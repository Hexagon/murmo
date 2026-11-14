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
    /// Trust `X-Forwarded-For` from a reverse proxy.
    pub trust_proxy: bool,
    /// Multiplier for every rate limit (1 in production).
    pub limit_scale: u32,
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

/// Fixed-window counters, in memory only. `scale` multiplies every limit (`MESG_LIMIT_SCALE`, for tests).
pub struct Limiter(Mutex<HashMap<String, (u32, i64)>>, u32);

impl Default for Limiter {
    fn default() -> Self {
        Limiter(Mutex::new(HashMap::new()), 1)
    }
}

impl Limiter {
    /// Limits multiplied by `scale` (at least 1).
    pub fn scaled(scale: u32) -> Self {
        Limiter(Mutex::new(HashMap::new()), scale.max(1))
    }

    /// Count one event for `key`; at most `max` per `window` seconds.
    pub fn check(&self, key: String, max: u32, window: i64) -> Result<(), ApiError> {
        let t = now();
        let mut g = self.0.lock().map_err(ApiError::internal)?;
        let e = g.entry(key).or_insert((0, t));
        if t - e.1 >= window {
            *e = (0, t);
        }
        if e.0 >= max.saturating_mul(self.1) {
            let wait = u64::try_from(window - (t - e.1)).unwrap_or(1).max(1);
            return Err(ApiError::rate_limited(wait));
        }
        e.0 += 1;
        Ok(())
    }

    /// Forget windows older than an hour.
    pub fn sweep(&self) {
        let t = now();
        if let Ok(mut g) = self.0.lock() {
            g.retain(|_, (_, start)| t - *start < 3600);
        }
    }

    /// Limit by network address.
    pub fn by_addr(&self, what: &str, addr: IpAddr, max: u32, window: i64) -> Result<(), ApiError> {
        self.check(format!("{what}:{addr}"), max, window)
    }
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
