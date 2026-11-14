//! Shared server state: configuration, storage, the rootcard host, connected devices, link requests, rate limits.

use crate::db::{Db, Identities};
use crate::devices::{Device, DeviceList, verify_list};
use crate::error::ApiError;
use rootcard::json::{Value, canonical};
use rootcard::keys::{KeyType, format_key};
use rootcard_host::Host;
use rootcard_host::store::{IdentityStore, MemoryChallengeStore, MemorySessionStore};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

/// The rootcard host type of this server.
pub type RcHost = Host<Identities, MemoryChallengeStore, MemorySessionStore>;

/// Server configuration (from the environment, see `main.rs`).
#[derive(Debug, Clone)]
pub struct Config {
    /// Public origin, such as `https://mesg.example`.
    pub origin: String,
    /// Address to bind.
    pub bind: String,
    /// SQLite database path.
    pub db: String,
    /// File with the host key seed (64 hex characters).
    pub key_file: String,
    /// Directory of the static client.
    pub client_dir: String,
    /// The rootcard realm of new identities.
    pub realm: String,
    /// Realms accepted for identities from other homes.
    pub realms: Vec<String>,
    /// Origins of other rootcard homes whose identities may use this server (`https://rootcard.org`).
    pub remote_homes: Vec<String>,
    /// Accept identities from any public https home.
    pub any_home: bool,
    /// Reverse proxies whose `X-Forwarded-For` is believed (empty: none).
    pub trust_proxy: Vec<Net>,
    /// Multiplier for every rate limit (1 in production).
    pub limit_scale: u32,
    /// Bytes of encrypted file chunks kept per device that is not connected (0: files only go live).
    pub file_queue: i64,
    /// Bytes of queued file chunks kept in total.
    pub file_queue_total: i64,
    /// Push services whose endpoints are accepted for notifications (empty: no push).
    pub push_hosts: Vec<String>,
    /// Contact in push requests (`mailto:` or `https:` URL); the origin by default.
    pub push_contact: String,
}

/// Seconds since the epoch.
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Random bytes from the operating system.
pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("operating system random generator");
    b
}

// ── connected devices ───────────────────────────────────────────────────────────────────────────────────────────

/// Something to push to a connection.
#[derive(Debug, Clone)]
pub enum Push {
    /// A text frame.
    Text(String),
}

/// Pushes waiting per connection; a connection that falls this far behind is dropped (it reconnects and reads the
/// mailbox from storage, relay frames for it are lost by design).
pub const PUSH_QUEUE: usize = 512;

struct Conn {
    id: u64,
    account: String,
    tx: mpsc::Sender<Push>,
}

/// The connected devices of this server. Dropping a connection's sender ends its session.
#[derive(Default)]
pub struct Hub {
    conns: Mutex<HashMap<String, Conn>>,
    next: AtomicU64,
}

impl Hub {
    /// Register a connection of `device`; an earlier connection of the same device is dropped.
    pub fn register(&self, device: &str, account: &str, tx: mpsc::Sender<Push>) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut g) = self.conns.lock() {
            g.insert(
                device.to_string(),
                Conn {
                    id,
                    account: account.to_string(),
                    tx,
                },
            );
        }
        id
    }

    /// Remove a connection (only if it is still the registered one).
    pub fn unregister(&self, device: &str, id: u64) {
        if let Ok(mut g) = self.conns.lock()
            && g.get(device).is_some_and(|c| c.id == id)
        {
            g.remove(device);
        }
    }

    /// Drop the connection of a device (for example after it was removed from its list).
    pub fn disconnect(&self, device: &str) {
        if let Ok(mut g) = self.conns.lock() {
            g.remove(device);
        }
    }

    /// Whether a device is connected now.
    pub fn is_connected(&self, device: &str) -> bool {
        self.conns
            .lock()
            .map(|g| g.contains_key(device))
            .unwrap_or(false)
    }

    /// Push to one device; returns whether it was connected and accepted the push.
    pub fn to_device(&self, device: &str, p: Push) -> bool {
        let Ok(mut g) = self.conns.lock() else {
            return false;
        };
        let Some(c) = g.get(device) else { return false };
        match c.tx.try_send(p) {
            Ok(()) => true,
            Err(_) => {
                g.remove(device);
                false
            }
        }
    }

    /// Push to every connected device of an account.
    pub fn to_account(&self, account: &str, p: &Push) {
        let devices: Vec<String> = self
            .conns
            .lock()
            .map(|g| {
                g.iter()
                    .filter(|(_, c)| c.account == account)
                    .map(|(d, _)| d.clone())
                    .collect()
            })
            .unwrap_or_default();
        for d in devices {
            self.to_device(&d, p.clone());
        }
    }
}

// ── rate limits ─────────────────────────────────────────────────────────────────────────────────────────────────

/// Windows at least this long survive a restart (see [`Limiter::save`]).
pub const PERSIST_WINDOW: i64 = 600;

/// Fixed-window counters. `scale` multiplies every limit (`MESG_LIMIT_SCALE`, for tests).
///
/// Keys are never kept as given: each is replaced by a keyed hash (HKDF-SHA-256 under a random secret kept in the
/// database), so neither memory nor the database holds network addresses in the clear. Counters of windows of
/// [`PERSIST_WINDOW`] seconds or more are written to the database by [`Limiter::save`] and read back on start, so a
/// restart does not hand out fresh budgets for registration, link requests or vault fetches. Nothing older than an
/// hour is kept.
pub struct Limiter {
    counters: Mutex<HashMap<[u8; 16], Counter>>,
    scale: u32,
    secret: [u8; 32],
    db: Option<Db>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Counter {
    count: u32,
    start: i64,
    window: i64,
}

impl Default for Limiter {
    fn default() -> Self {
        Limiter::scaled(1)
    }
}

const LIMIT_SECRET: &str = "rate_limit_secret";

impl Limiter {
    /// In-memory limits multiplied by `scale` (at least 1).
    pub fn scaled(scale: u32) -> Self {
        Limiter {
            counters: Mutex::new(HashMap::new()),
            scale: scale.max(1),
            secret: random::<32>(),
            db: None,
        }
    }

    /// Limits that survive restarts: the hashing secret and the long windows live in `db`.
    pub fn persistent(scale: u32, db: Db) -> Result<Self, String> {
        let secret = match db.setting(LIMIT_SECRET).map_err(|e| e.to_string())? {
            Some(hex) => rootcard::encoding::hex_decode(&hex)
                .ok()
                .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
                .ok_or("bad rate limit secret in the database")?,
            None => {
                let s = random::<32>();
                db.set_setting(LIMIT_SECRET, &rootcard::encoding::hex_encode(&s))
                    .map_err(|e| e.to_string())?;
                s
            }
        };
        let t = now();
        let mut counters = HashMap::new();
        for (key, count, start, window) in db.rate_limits().map_err(|e| e.to_string())? {
            if let Ok(k) = <[u8; 16]>::try_from(key.as_slice())
                && t - start < window.min(3600)
                && start <= t
            {
                counters.insert(
                    k,
                    Counter {
                        count,
                        start,
                        window,
                    },
                );
            }
        }
        Ok(Limiter {
            counters: Mutex::new(counters),
            scale: scale.max(1),
            secret,
            db: Some(db),
        })
    }

    fn hash(&self, key: &str) -> [u8; 16] {
        let h = rootcard::crypto::hkdf(key.as_bytes(), &self.secret, b"mesg rate limit v1");
        let mut out = [0u8; 16];
        out.copy_from_slice(&h[..16]);
        out
    }

    /// Count one event for `key`; at most `max` per `window` seconds.
    pub fn check(&self, key: String, max: u32, window: i64) -> Result<(), ApiError> {
        let k = self.hash(&key);
        let t = now();
        let mut g = self.counters.lock().map_err(ApiError::internal)?;
        let e = g.entry(k).or_insert(Counter {
            count: 0,
            start: t,
            window,
        });
        if t - e.start >= window || e.start > t {
            *e = Counter {
                count: 0,
                start: t,
                window,
            };
        }
        e.window = e.window.max(window);
        if e.count >= max.saturating_mul(self.scale) {
            let wait = u64::try_from(window - (t - e.start)).unwrap_or(1).max(1);
            return Err(ApiError::rate_limited(wait));
        }
        e.count += 1;
        Ok(())
    }

    /// Forget windows that have ended (and anything older than an hour).
    pub fn sweep(&self) {
        let t = now();
        if let Ok(mut g) = self.counters.lock() {
            g.retain(|_, c| t - c.start < c.window.min(3600));
        }
    }

    /// Write the counters of long windows to the database (replacing what was there). A no-op without one.
    pub fn save(&self) -> Result<(), String> {
        let Some(db) = &self.db else { return Ok(()) };
        let rows: Vec<crate::db::RateRow> = self
            .counters
            .lock()
            .map_err(|_| "lock poisoned".to_string())?
            .iter()
            .filter(|(_, c)| c.window >= PERSIST_WINDOW && c.count > 0)
            .map(|(k, c)| (k.to_vec(), c.count, c.start, c.window))
            .collect();
        db.set_rate_limits(&rows).map_err(|e| e.to_string())
    }

    /// Limit by network address. IPv6 addresses count per /64, since one host usually holds a whole /64.
    pub fn by_addr(&self, what: &str, addr: IpAddr, max: u32, window: i64) -> Result<(), ApiError> {
        self.check(format!("{what}:{}", limit_net(addr)), max, window)
    }
}

/// The network a rate limit by address counts against: the IPv4 address (also when mapped into IPv6), or the /64
/// of an IPv6 address.
pub fn limit_net(addr: IpAddr) -> String {
    match addr {
        IpAddr::V4(a) => a.to_string(),
        IpAddr::V6(a) => match a.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = a.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
    }
}

// ── trusted proxies ─────────────────────────────────────────────────────────────────────────────────────────────

/// An address range in CIDR notation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Net {
    addr: IpAddr,
    prefix: u8,
}

impl Net {
    /// Parse `10.0.0.0/8`, `::1` or `fd00::/8`. A bare address is a single host.
    pub fn parse(s: &str) -> Option<Net> {
        let (a, p) = match s.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (s, None),
        };
        let addr: IpAddr = a.trim().parse().ok()?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match p {
            Some(p) => p.trim().parse::<u8>().ok().filter(|p| *p <= max)?,
            None => max,
        };
        Some(Net { addr, prefix })
    }

    /// Whether `ip` is inside the range (IPv4-mapped IPv6 addresses count as IPv4).
    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = canonical_ip(ip);
        match (self.addr, ip) {
            (IpAddr::V4(n), IpAddr::V4(a)) => {
                let mask = u32::MAX
                    .checked_shl(32 - u32::from(self.prefix))
                    .unwrap_or(0);
                u32::from(n) & mask == u32::from(a) & mask
            }
            (IpAddr::V6(n), IpAddr::V6(a)) => {
                let mask = u128::MAX
                    .checked_shl(128 - u32::from(self.prefix))
                    .unwrap_or(0);
                u128::from(n) & mask == u128::from(a) & mask
            }
            _ => false,
        }
    }
}

/// IPv4-mapped IPv6 addresses as IPv4.
pub fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(a) => a.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    }
}

/// The ranges `MESG_TRUST_PROXY=1` stands for: loopback and private networks, where a reverse proxy on the same
/// host or in the same container network connects from.
pub const LOCAL_NETS: &[&str] = &[
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "::1/128",
    "fc00::/7",
];

/// Parse `MESG_TRUST_PROXY`: `0` or empty for none, `1` for [`LOCAL_NETS`], or a comma-separated list of addresses
/// and ranges. Entries that do not parse are returned as errors.
pub fn trusted_proxies(s: &str) -> Result<Vec<Net>, String> {
    let s = s.trim();
    if s.is_empty() || s == "0" {
        return Ok(Vec::new());
    }
    let items: Vec<&str> = if s == "1" {
        LOCAL_NETS.to_vec()
    } else {
        s.split(',')
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .collect()
    };
    items
        .into_iter()
        .map(|x| Net::parse(x).ok_or_else(|| format!("not an address or range: {x}")))
        .collect()
}

/// The client address of a request from `peer` with the given `X-Forwarded-For` header values.
///
/// The header is only believed when `peer` is a trusted proxy. Then the hops are read from the right (the hop the
/// proxy appended itself) and every trusted proxy is skipped: the first untrusted hop is the client. A hop that is
/// not an address ends the walk at the last address before it, since everything further left is whatever the client
/// chose to send.
pub fn client_addr<'a>(
    peer: IpAddr,
    forwarded: impl IntoIterator<Item = &'a str>,
    trusted: &[Net],
) -> IpAddr {
    let is_trusted = |ip: IpAddr| trusted.iter().any(|n| n.contains(ip));
    let peer = canonical_ip(peer);
    if !is_trusted(peer) {
        return peer;
    }
    let hops: Vec<&str> = forwarded.into_iter().flat_map(|v| v.split(',')).collect();
    let mut client = peer;
    for hop in hops.iter().rev() {
        let Ok(ip) = hop.trim().parse::<IpAddr>() else {
            break;
        };
        client = canonical_ip(ip);
        if !is_trusted(client) {
            break;
        }
    }
    client
}

// ── link requests ───────────────────────────────────────────────────────────────────────────────────────────────

/// A pending link request (memory only).
#[derive(Debug, Clone)]
pub struct LinkRequest {
    /// Request id.
    pub id: String,
    /// The new device.
    pub device: String,
    /// The request as sent by the new device.
    pub value: Value,
    /// When it expires.
    pub expires: i64,
}

/// Pending link requests per account.
#[derive(Default)]
pub struct Links(Mutex<HashMap<String, Vec<LinkRequest>>>);

/// At most this many pending link requests per account.
pub const MAX_LINKS: usize = 3;
/// Lifetime of a link request in seconds.
pub const LINK_TTL: i64 = 600;

impl Links {
    /// Add a request; refuses when the account already has [`MAX_LINKS`].
    pub fn add(&self, account: &str, r: LinkRequest) -> Result<(), ApiError> {
        let mut g = self.0.lock().map_err(ApiError::internal)?;
        let t = now();
        let list = g.entry(account.to_string()).or_default();
        list.retain(|x| x.expires > t && x.device != r.device);
        if list.len() >= MAX_LINKS {
            return Err(ApiError::new(429, "too_many_link_requests"));
        }
        list.push(r);
        Ok(())
    }

    /// The pending requests of an account.
    pub fn pending(&self, account: &str) -> Vec<LinkRequest> {
        let t = now();
        self.0
            .lock()
            .map(|g| {
                g.get(account)
                    .map(|l| l.iter().filter(|x| x.expires > t).cloned().collect())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    /// Remove requests by id or by device.
    pub fn remove(&self, account: &str, pred: impl Fn(&LinkRequest) -> bool) {
        if let Ok(mut g) = self.0.lock()
            && let Some(l) = g.get_mut(account)
        {
            l.retain(|x| !pred(x));
        }
    }

    /// Drop expired requests.
    pub fn sweep(&self) {
        let t = now();
        if let Ok(mut g) = self.0.lock() {
            for l in g.values_mut() {
                l.retain(|x| x.expires > t);
            }
            g.retain(|_, l| !l.is_empty());
        }
    }
}

// ── proof challenges ────────────────────────────────────────────────────────────────────────────────────────────

/// Single-use challenges for rootcard proofs (memory only, 2 minutes).
#[derive(Default)]
pub struct Challenges(Mutex<HashMap<String, i64>>);

impl Challenges {
    /// A new challenge (base64url of 32 random bytes).
    pub fn issue(&self) -> Result<String, ApiError> {
        let nonce = rootcard::encoding::base64url_encode(&random::<32>());
        let t = now();
        let mut g = self.0.lock().map_err(ApiError::internal)?;
        g.retain(|_, e| *e > t);
        if g.len() > 100_000 {
            return Err(ApiError::rate_limited(10));
        }
        g.insert(nonce.clone(), t + 120);
        Ok(nonce)
    }

    /// Take a challenge (once).
    pub fn take(&self, nonce: &str) -> bool {
        let t = now();
        self.0
            .lock()
            .map(|mut g| g.remove(nonce).is_some_and(|e| e > t))
            .unwrap_or(false)
    }
}

// ── the application ─────────────────────────────────────────────────────────────────────────────────────────────

/// Everything a handler needs.
pub struct App {
    /// Configuration.
    pub cfg: Config,
    /// Storage.
    pub db: Db,
    /// The rootcard home.
    pub host: RcHost,
    /// Connected devices.
    pub hub: Hub,
    /// Pending link requests.
    pub links: Links,
    /// Rate limits.
    pub limits: Limiter,
    /// Challenges for rootcard proofs.
    pub challenges: Challenges,
    /// Web Push wake-ups.
    pub push: crate::push::Pusher,
}

/// The current state of an account as far as mesg is concerned.
pub struct Current {
    /// The rootcard base URL of the identity's home.
    pub home: String,
    /// The account key of the current instance.
    pub account_key: [u8; 32],
    /// `ed25519:<account key>`.
    pub instance: String,
    /// The verified device list of the current instance, if any.
    pub list: Option<DeviceList>,
    /// Device ids of a stored list of an earlier instance (to clean up).
    pub stale: Vec<String>,
}

impl Current {
    /// A present device.
    pub fn device(&self, id: &str) -> Option<&Device> {
        self.list.as_ref().and_then(|l| l.device(id))
    }
}

impl App {
    /// This server's own rootcard base URL.
    pub fn local_home(&self) -> String {
        format!("{}{}", self.cfg.origin, crate::rc::PREFIX)
    }

    /// The newest log events of an account, local or remote.
    pub fn events(&self, account: &str) -> Result<Vec<Value>, ApiError> {
        if let Some(s) = self.host.store.load(account).map_err(ApiError::internal)? {
            return Ok(s.events);
        }
        self.db
            .remote(account)
            .map_err(ApiError::internal)?
            .map(|r| r.events)
            .ok_or(ApiError::new(404, "unknown_account"))
    }

    /// Load an account: its home is this server, or another allowed home whose log this server has fetched.
    pub fn current(&self, account: &str) -> Result<Current, ApiError> {
        let (state, home) = match self.host.store.load(account).map_err(ApiError::internal)? {
            Some(stored) => {
                let inst = stored
                    .state
                    .instance
                    .as_ref()
                    .ok_or(ApiError::new(410, "account_retired"))?;
                if !self.host.config.is_own_key(&inst.home.key) {
                    return Err(ApiError::new(409, "not_home"));
                }
                (stored.state, self.local_home())
            }
            None => {
                let r = self
                    .db
                    .remote(account)
                    .map_err(ApiError::internal)?
                    .ok_or(ApiError::new(404, "unknown_account"))?;
                (r.state, r.home)
            }
        };
        let inst = state
            .instance
            .as_ref()
            .ok_or(ApiError::new(410, "account_retired"))?;
        if inst.home.url != home {
            return Err(ApiError::new(409, "not_home"));
        }
        let instance = format_key(KeyType::Ed25519, &inst.account_key);
        let (list, stale) = match self.db.device_list(account).map_err(ApiError::internal)? {
            Some((i, entries)) if i == instance => (
                Some(verify_list(account, &inst.account_key, &entries)?),
                Vec::new(),
            ),
            Some((_, entries)) => (None, stale_ids(&entries)),
            None => (None, Vec::new()),
        };
        Ok(Current {
            home,
            account_key: inst.account_key,
            instance,
            list,
            stale,
        })
    }
}

/// Device ids named in a list of an earlier instance (not verified: only used to delete).
fn stale_ids(entries: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in entries {
        if let Some(id) = e
            .as_object()
            .and_then(|m| m.get("device"))
            .and_then(Value::as_object)
            .and_then(|d| d.get("id"))
            .and_then(Value::as_str)
            && !out.iter().any(|x| x == id)
        {
            out.push(id.to_string());
        }
    }
    out
}

/// A canonical JSON text.
pub fn text(v: &Value) -> String {
    String::from_utf8(canonical(v)).unwrap_or_default()
}

#[cfg(test)]
mod limit_tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("ip")
    }

    #[test]
    fn nets() {
        let n = Net::parse("10.0.0.0/8").expect("net");
        assert!(n.contains(ip("10.1.2.3")));
        assert!(n.contains(ip("::ffff:10.1.2.3")));
        assert!(!n.contains(ip("11.0.0.1")));
        assert!(
            Net::parse("0.0.0.0/0")
                .expect("net")
                .contains(ip("8.8.8.8"))
        );
        assert!(Net::parse("fc00::/7").expect("net").contains(ip("fd12::1")));
        assert!(!Net::parse("::1").expect("net").contains(ip("::2")));
        assert!(Net::parse("10.0.0.0/33").is_none());
        assert!(Net::parse("nonsense").is_none());
        assert!(trusted_proxies("10.0.0.1, bad").is_err());
        assert_eq!(trusted_proxies("0").expect("none"), Vec::new());
        assert_eq!(trusted_proxies("1").expect("local").len(), LOCAL_NETS.len());
    }

    #[test]
    fn forwarded_for() {
        let local = trusted_proxies("1").expect("local");
        // Not behind a trusted proxy: the header is ignored.
        assert_eq!(
            client_addr(ip("203.0.113.9"), ["1.2.3.4"], &local),
            ip("203.0.113.9")
        );
        // No trust configured.
        assert_eq!(
            client_addr(ip("127.0.0.1"), ["1.2.3.4"], &[]),
            ip("127.0.0.1")
        );
        // One proxy: the hop it appended.
        assert_eq!(
            client_addr(ip("127.0.0.1"), ["1.2.3.4"], &local),
            ip("1.2.3.4")
        );
        // A spoofed hop on the left is not taken.
        assert_eq!(
            client_addr(ip("127.0.0.1"), ["6.6.6.6, 1.2.3.4"], &local),
            ip("1.2.3.4")
        );
        // Two trusted proxies, in one header or several.
        assert_eq!(
            client_addr(ip("127.0.0.1"), ["6.6.6.6, 1.2.3.4, 10.0.0.2"], &local),
            ip("1.2.3.4")
        );
        assert_eq!(
            client_addr(ip("127.0.0.1"), ["6.6.6.6, 1.2.3.4", "10.0.0.2"], &local),
            ip("1.2.3.4")
        );
        // Garbage stops the walk at the last good hop.
        assert_eq!(
            client_addr(ip("127.0.0.1"), ["1.2.3.4, junk, 10.0.0.2"], &local),
            ip("10.0.0.2")
        );
        // No header: the proxy itself.
        assert_eq!(client_addr(ip("127.0.0.1"), [], &local), ip("127.0.0.1"));
    }

    #[test]
    fn ipv6_per_64() {
        assert_eq!(limit_net(ip("2001:db8:1:2:3:4:5:6")), "2001:db8:1:2::/64");
        assert_eq!(limit_net(ip("::ffff:1.2.3.4")), "1.2.3.4");
        let l = Limiter::scaled(1);
        for i in 0..3 {
            let a = ip(&format!("2001:db8:1:2::{i}"));
            assert!(l.by_addr("x", a, 3, 60).is_ok());
        }
        assert!(l.by_addr("x", ip("2001:db8:1:2::ff"), 3, 60).is_err());
        assert!(l.by_addr("x", ip("2001:db8:1:3::1"), 3, 60).is_ok());
    }

    #[test]
    fn survives_restart() {
        let db = Db::open(":memory:").expect("db");
        let l = Limiter::persistent(1, db.clone()).expect("limiter");
        for _ in 0..5 {
            assert!(l.check("register:1.2.3.4".into(), 5, 3600).is_ok());
            assert!(l.check("lookup:1.2.3.4".into(), 5, 60).is_ok());
        }
        assert!(l.check("register:1.2.3.4".into(), 5, 3600).is_err());
        l.save().expect("save");
        // Nothing in the clear.
        let rows = db.rate_limits().expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0.len(), 16);
        let again = Limiter::persistent(1, db).expect("limiter");
        assert!(again.check("register:1.2.3.4".into(), 5, 3600).is_err());
        // Short windows start over.
        assert!(again.check("lookup:1.2.3.4".into(), 5, 60).is_ok());
    }
}
