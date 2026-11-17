//! Federation: Murmo servers that hand each other envelopes (DESIGN.md §14).
//!
//! Every account has one Murmo server, where its device list and mailbox are. A client talks only to its own server;
//! for a contact on another server, its server fetches what the client needs from there (the lookup, the device list
//! and the identity's log, all of which the client verifies itself) and delivers the envelopes there. A delivery is
//! signed by the sending server's federation key (derived from its host key) and checked by the receiving server
//! against the key the sender publishes in `/api/v1/info`, fetched over https from the origin it claims to be. The
//! receiving server learns which server sent an envelope, never which account or device.
//!
//! File chunks go the same way (`/federation/relay`), as do the questions a transfer needs: which devices are
//! connected (`/federation/presence`) and which have room in the file queue (`/federation/space`). Each server keeps
//! its own limits for what it takes from other servers, and says what they are in `/api/v1/info` (`relay`,
//! `file_queue_limits`), so that a sender can keep within the smaller of both.
//!
//! Which servers take part is the operator's choice (`MURMO_FEDERATION`: `open`, `off`, or a list of origins, and
//! `MURMO_FEDERATION_BLOCK`). An open server talks only to public https origins with a domain name.

use crate::api::check_account;
use crate::app::{App, Locked, Push, now, random, text};
use crate::db::{ChunkData, OutboxItem};
use crate::devices::{MAX_DEVICES, MAX_ENTRIES};
use crate::egress;
use crate::error::{ApiError, json};
use crate::remote::origin_of;
use crate::ws::{
    MAILBOX_TTL, MAX_PRESENCE, MAX_QUEUE, MAX_RECIPIENTS, MAX_RELAY, MAX_RELAY_BIN,
    RELAY_PEER_BYTES, Sender, check_envelope, deliver_frame, is_b64url, share_for, space_for,
};
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use rootcard::crypto::{ed25519_public, ed25519_sign, ed25519_verify, frame, hkdf};
use rootcard::encoding::{base64url_decode, base64url_decode_fixed, base64url_encode};
use rootcard::json::{Map, Value, canonical, parse_limited};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

/// Domain separation for a delivery's signature.
pub const LABEL: &str = "murmo/federation/v1";
/// Largest delivery accepted: a full send (24 envelopes of at most 96 KiB) and some room.
pub const MAX_DELIVER_BODY: usize = 3 * 1024 * 1024;
/// Largest answer read from another server.
const MAX_ANSWER: usize = 4 * 1024 * 1024;
/// How far a delivery's time may be from ours (seconds).
const SKEW: i64 = 300;
/// How long a peer's federation key is trusted before it is fetched again (seconds).
const KEY_TTL: i64 = 3600;
/// A peer's `/api/v1/info` is fetched at most this often (seconds): a forced refetch (after a bad signature) and a
/// fetch that failed are both remembered for this long, so neither can be repeated faster.
const REFETCH_EVERY: i64 = 60;
/// Signed requests per minute from one network address that fail verification in a way that cost a fetch (a bad
/// signature, an unreachable or keyless sender). Checked before any work, so an address over it is refused at once.
const FAILED_PER_ADDR: u32 = 10;
/// Envelopes per minute from one server.
const PER_SERVER: u32 = 6000;
/// How long a device list fetched from another server is reused for other requests (seconds). All of this server's
/// users share its network address at the other server, and so its rate limits there.
const LIST_CACHE: i64 = 20;
/// How long a learned route (a device of a contact on another server) is kept without being used (seconds).
const ROUTE_TTL: i64 = 7 * 24 * 3600;
/// Chunk frames per minute from one server, and bytes.
const RELAY_PER_SERVER: u32 = 60_000;
const RELAY_BYTES_PER_SERVER: u32 = 2047 << 20;
/// Most routes kept per local account (devices of its contacts on other servers); the least recently used go first.
const MAX_ROUTES: usize = 512;
/// Most device lists of other servers kept at once, and their size in all (as JSON text). An answer larger than a
/// quarter of that is used but not kept.
const MAX_LISTS: usize = 256;
const MAX_LISTS_BYTES: usize = 16 << 20;
/// Most other servers whose key and limits are kept at once; the least recently fetched go first.
const MAX_PEERS: usize = 1024;
/// Largest relay request (one chunk as text, and the fields around it).
pub const MAX_RELAY_BODY: usize = 256 * 1024;

/// Which servers this one exchanges envelopes with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Policy {
    /// None.
    Off,
    /// Any public https origin with a domain name (except blocked ones).
    Open,
    /// Only these origins.
    Allow(Vec<String>),
}

impl Policy {
    /// `open` (the default), `off`, or a comma-separated list of origins.
    pub fn parse(s: &str) -> Policy {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "open" => Policy::Open,
            "off" | "0" | "none" => Policy::Off,
            list => Policy::Allow(
                list.split(',')
                    .map(|o| o.trim().trim_end_matches('/').to_string())
                    .filter(|o| !o.is_empty())
                    .collect(),
            ),
        }
    }
}

/// What this server knows of another one from its `/api/v1/info`: its federation key (None: it publishes none), the
/// limits it puts on what it takes from other servers, and when that was fetched. A fetch that failed is remembered as
/// well (`unreachable`), so it is not tried again for [`REFETCH_EVERY`] seconds.
#[derive(Clone)]
struct Peer {
    key: Option<[u8; 32]>,
    limits: Option<Value>,
    /// When this answer was fetched.
    at: i64,
    /// When a fetch was last tried, whether it worked or not.
    tried: i64,
    /// The last fetch failed and nothing usable was known before it.
    unreachable: bool,
}

/// The routes of one local account: device → (origin, last used).
type Routes = HashMap<String, (String, i64)>;

/// This server's federation key and what it remembers about other servers.
pub struct Federation {
    seed: Zeroizing<[u8; 32]>,
    /// The public key, base64url, as published in `/api/v1/info`.
    pub public: String,
    /// Peers by origin.
    keys: Mutex<HashMap<String, Peer>>,
    /// Deliveries seen (`origin nonce` → time), against replays.
    nonces: Mutex<HashMap<String, i64>>,
    /// Device lists with logs fetched from other servers (`origin account` → answer, its size, time).
    lists: Mutex<HashMap<String, (Value, usize, i64)>>,
    /// Where devices of other servers are, for each local account that writes to them (account → device → origin,
    /// last used): learned from its `send` and `remote-devices`, used for its file chunks and presence questions. At
    /// most [`MAX_ROUTES`] per account.
    routes: Mutex<HashMap<String, Routes>>,
    /// Connections to other servers, kept open between requests: to servers on the operator's allowlist, and (open
    /// federation) to public addresses only (`egress`).
    agent: ureq::Agent,
    public_agent: ureq::Agent,
    /// Whether [`flush_outbox`] is running.
    flushing: AtomicBool,
}

impl Federation {
    /// The federation key is derived from the host key, so there is nothing more to keep.
    pub fn new(host_seed: &[u8; 32]) -> Federation {
        let seed = hkdf(host_seed, b"murmo", b"murmo/federation-key/v1");
        let public = base64url_encode(&ed25519_public(&seed));
        Federation {
            seed,
            public,
            keys: Mutex::default(),
            nonces: Mutex::default(),
            lists: Mutex::default(),
            routes: Mutex::default(),
            agent: egress::agent(false),
            public_agent: egress::agent(true),
            flushing: AtomicBool::new(false),
        }
    }

    fn sign(&self, m: &[u8]) -> [u8; 64] {
        ed25519_sign(&self.seed, m)
    }

    /// Remember a delivery; false if it was seen before.
    fn fresh(&self, origin: &str, nonce: &str, t: i64) -> bool {
        let mut n = self.nonces.locked();
        n.retain(|_, seen| t - *seen < 2 * SKEW);
        match n.entry(format!("{origin} {nonce}")) {
            std::collections::hash_map::Entry::Occupied(_) => false,
            std::collections::hash_map::Entry::Vacant(v) => {
                v.insert(t);
                true
            }
        }
    }

    /// Remember that `device` (of a contact of `account`) is on `origin`. An account that has named
    /// [`MAX_ROUTES`] devices forgets the one it used least recently.
    pub fn learn(&self, account: &str, device: &str, origin: &str) {
        let t = now();
        let mut routes = self.routes.locked();
        let mine = routes.entry(account.to_string()).or_default();
        if !mine.contains_key(device) && mine.len() >= MAX_ROUTES {
            evict_oldest(mine, |(_, at)| *at);
        }
        mine.insert(device.to_string(), (origin.to_string(), t));
    }

    /// The server a device is on, as `account` knows it; None for a device of this server (or one it never named).
    pub fn route(&self, account: &str, device: &str) -> Option<String> {
        self.routes
            .locked()
            .get(account)
            .and_then(|m| m.get(device))
            .map(|(o, _)| o.clone())
    }

    /// Keep a device list fetched from another server for a while, within [`MAX_LISTS`] and [`MAX_LISTS_BYTES`].
    fn keep_list(&self, key: String, v: &Value, t: i64) {
        let size = text(v).len();
        if size > MAX_LISTS_BYTES / 4 {
            return;
        }
        let mut lists = self.lists.locked();
        lists.remove(&key);
        lists.retain(|_, (_, _, at)| t - *at < LIST_CACHE);
        while !lists.is_empty()
            && (lists.len() >= MAX_LISTS
                || lists.values().map(|(_, n, _)| n).sum::<usize>() + size > MAX_LISTS_BYTES)
        {
            evict_oldest(&mut lists, |(_, _, at)| *at);
        }
        lists.insert(key, (v.clone(), size, t));
    }

    /// Keep what this server knows of a peer, within [`MAX_PEERS`].
    fn keep_peer(&self, origin: &str, p: Peer) {
        let mut keys = self.keys.locked();
        if !keys.contains_key(origin) && keys.len() >= MAX_PEERS {
            evict_oldest(&mut keys, |p| p.at);
        }
        keys.insert(origin.to_string(), p);
    }

    /// Forget peers' keys fetched long ago.
    pub fn sweep(&self) {
        let t = now();
        self.keys.locked().retain(|_, p| t - p.at < KEY_TTL);
        let mut routes = self.routes.locked();
        for mine in routes.values_mut() {
            mine.retain(|_, (_, at)| t - *at < ROUTE_TTL);
        }
        routes.retain(|_, mine| !mine.is_empty());
        drop(routes);
        self.lists
            .locked()
            .retain(|_, (_, _, at)| t - *at < LIST_CACHE);
    }
}

/// Remove the entry of `m` that `at` says is the oldest.
fn evict_oldest<V>(m: &mut HashMap<String, V>, at: impl Fn(&V) -> i64) {
    if let Some(k) = m.iter().min_by_key(|(_, v)| at(v)).map(|(k, _)| k.clone()) {
        m.remove(&k);
    }
}

/// An origin written plainly: `scheme://host[:port]`, lower case, nothing after it.
fn plain_origin(o: &str) -> bool {
    rootcard::check_base_url(o).is_ok()
        && origin_of(o).as_deref() == Some(o)
        && !o.contains('@')
        && o.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-' | b':' | b'/')
        })
}

/// A public https origin with a domain name: never an IP literal in any spelling, a name without a dot or a local
/// name (`egress::public_host`). Its addresses are checked again when it is connected to.
fn public_origin(o: &str) -> bool {
    let Some(host) = o.strip_prefix("https://") else {
        return false;
    };
    let name = host.split(':').next().unwrap_or_default();
    plain_origin(o) && egress::public_host(name)
}

/// The host name and port of an origin: no scheme, lower case, without a trailing dot; the port only when it is not the
/// scheme's default (443 for https, 80 for http).
fn host_port(origin: &str) -> (String, Option<u16>) {
    let (scheme, rest) = origin.split_once("://").unwrap_or(("https", origin));
    let rest = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let rest = rest.rsplit_once('@').map_or(rest, |(_, h)| h);
    let (host, port) = if let Some(v6) = rest.strip_prefix('[') {
        // An IPv6 literal keeps its brackets.
        let (h, after) = v6.split_once(']').unwrap_or((v6, ""));
        (format!("[{h}]"), after.strip_prefix(':'))
    } else {
        match rest.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (rest.to_string(), None),
        }
    };
    let default = if scheme.eq_ignore_ascii_case("http") {
        80
    } else {
        443
    };
    let port = port
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|p| *p != default);
    (host.trim_end_matches('.').to_ascii_lowercase(), port)
}

/// The host name of an origin, without scheme and port.
pub fn host_of(origin: &str) -> String {
    host_port(origin).0
}

/// An entry of `MURMO_FEDERATION_BLOCK` (an origin or a bare host name) as what it blocks: `host`, which blocks the
/// host on any scheme and port and all its subdomains, or `host:port` when it names a port other than the default,
/// which blocks only that port of that host (several servers on one address, as in tests).
pub fn block_entry(s: &str) -> Option<String> {
    let (host, port) = host_port(s.trim());
    match port {
        _ if host.is_empty() => None,
        Some(p) => Some(format!("{host}:{p}")),
        None => Some(host),
    }
}

/// Whether `origin` is blocked: its host is on the block list or is a subdomain of a host on it, whatever the scheme
/// and port (`evil.example` blocks `https://evil.example:8443` and `https://a.evil.example`), or the list names this
/// very host and port.
pub fn blocked(block: &[String], origin: &str) -> bool {
    let (host, port) = host_port(origin);
    let with_port = port.map(|p| format!("{host}:{p}"));
    block.iter().any(|b| {
        host == *b
            || with_port.as_deref() == Some(b.as_str())
            || host
                .strip_suffix(b.as_str())
                .is_some_and(|sub| sub.ends_with('.'))
    })
}

/// The key under which the budgets for another server are counted: its host, so that other ports of one host share
/// them.
fn budget_key(origin: &str) -> String {
    host_of(origin)
}

/// Whether this server exchanges envelopes with `origin`.
pub fn allowed(app: &App, origin: &str) -> bool {
    if app.is_origin(origin) || blocked(&app.cfg.federation_block, origin) {
        return false;
    }
    match &app.cfg.federation {
        Policy::Off => false,
        Policy::Open => public_origin(origin),
        Policy::Allow(list) => plain_origin(origin) && list.iter().any(|o| o == origin),
    }
}

/// Read an answer from another server: its status and its JSON body (an empty object when there is none or it is not
/// JSON).
fn answer(
    res: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
) -> Result<(u16, Value), ApiError> {
    let mut res = res.map_err(|_| ApiError::new(502, "server_unreachable"))?;
    let status = res.status().as_u16();
    let body = res
        .body_mut()
        .with_config()
        .limit(MAX_ANSWER as u64)
        .read_to_vec()
        .map_err(|_| ApiError::new(502, "server_error"))?;
    Ok((
        status,
        parse_limited(&body, MAX_ANSWER).unwrap_or_else(|_| Map::new().into()),
    ))
}

/// GET a JSON document from another server (blocking task).
/// The agent for a request to another server: open federation reaches public addresses only.
fn agent(app: &App) -> ureq::Agent {
    match app.cfg.federation {
        Policy::Open => app.fed.public_agent.clone(),
        _ => app.fed.agent.clone(),
    }
}

async fn get(app: &App, url: String) -> Result<(u16, Value), ApiError> {
    let agent = agent(app);
    tokio::task::spawn_blocking(move || answer(agent.get(&url).call()))
        .await
        .map_err(ApiError::internal)?
}

/// POST a JSON body to another server (blocking task).
async fn post(app: &App, url: String, body: Vec<u8>) -> Result<(u16, Value), ApiError> {
    let agent = agent(app);
    tokio::task::spawn_blocking(move || {
        answer(
            agent
                .post(&url)
                .header("Content-Type", "application/json")
                .send(&body[..]),
        )
    })
    .await
    .map_err(ApiError::internal)?
}

/// What this server knows of another one, from its `/api/v1/info` (cached; `fresh` fetches it again, but never more
/// than once in [`REFETCH_EVERY`] seconds; a failed fetch is cached for as long).
async fn peer(app: &Arc<App>, origin: &str, fresh: bool) -> Result<Peer, ApiError> {
    let t = now();
    let cached = app.fed.keys.locked().get(origin).cloned();
    if let Some(p) = &cached {
        let valid = t - p.at < if p.key.is_some() { KEY_TTL } else { 60 };
        if (valid && !fresh) || t - p.tried < REFETCH_EVERY {
            return if p.unreachable || !valid {
                Err(ApiError::new(502, "server_unreachable"))
            } else {
                Ok(p.clone())
            };
        }
    }
    let (status, info) = match get(app, format!("{origin}/api/v1/info")).await {
        Ok(a) => a,
        Err(e) => {
            // Remembered, so that the next request does not try again at once. What was known before stays usable
            // while it is still valid.
            let mut p = cached
                .filter(|p| !p.unreachable && t - p.at < KEY_TTL)
                .unwrap_or(Peer {
                    key: None,
                    limits: None,
                    at: t,
                    tried: t,
                    unreachable: true,
                });
            p.tried = t;
            app.fed.keep_peer(origin, p);
            return Err(e);
        }
    };
    // The peer must say it is this origin, and publish a key.
    let info = info.as_object().filter(|m| {
        status == 200
            && m.get("origins")
                .and_then(Value::as_array)
                .is_some_and(|a| a.iter().any(|o| o.as_str() == Some(origin)))
    });
    let key = info
        .and_then(|m| m.get("federation"))
        .and_then(Value::as_object)
        .and_then(|f| f.get("key"))
        .and_then(Value::as_str)
        .and_then(|k| base64url_decode_fixed::<32>(k).ok());
    let limits = info.map(|m| {
        let mut l = Map::new();
        for k in ["relay", "file_queue", "file_queue_limits"] {
            if let Some(v) = m.get(k) {
                l.insert(k, v.clone());
            }
        }
        l.into()
    });
    let p = Peer {
        key,
        limits,
        at: t,
        tried: t,
        unreachable: false,
    };
    app.fed.keep_peer(origin, p.clone());
    Ok(p)
}

/// A peer's federation key (cached; `fresh` fetches it again).
async fn peer_key(app: &Arc<App>, origin: &str, fresh: bool) -> Result<[u8; 32], ApiError> {
    peer(app, origin, fresh)
        .await?
        .key
        .ok_or(ApiError::new(403, "federation_refused"))
}

/// A request to another server, signed: `{ req: { v, kind, from, to, time, nonce, ...fields }, sig }`.
fn signed(app: &App, server: &str, kind: &str, fields: Map) -> Vec<u8> {
    let mut req = Map::new()
        .with("v", 1i64)
        .with("kind", kind)
        .with("from", app.cfg.origin.as_str())
        .with("to", server)
        .with("time", now())
        .with("nonce", base64url_encode(&random::<16>()));
    for (k, v) in fields.iter() {
        req.insert(k, v.clone());
    }
    let req: Value = req.into();
    let sig = app.fed.sign(&frame(LABEL, &canonical(&req)));
    canonical(
        &Map::new()
            .with("req", req)
            .with("sig", base64url_encode(&sig))
            .into(),
    )
}

/// Send a signed request of `kind` to `path` on `server`: the answer's body when it says 200, otherwise None.
async fn call(app: &Arc<App>, server: &str, path: &str, kind: &str, fields: Map) -> Option<Map> {
    let body = signed(app, server, kind, fields);
    match post(app, format!("{server}{path}"), body).await {
        Ok((200, v)) => v.as_object().cloned(),
        _ => None,
    }
}

/// Check a signed request from another server: the policy, the address, the time, the signature by the key the
/// sender publishes, the kind and that it is not a replay. Returns the sender's origin and the request.
async fn verify(
    app: &Arc<App>,
    addr: std::net::IpAddr,
    body: &[u8],
    kind: &str,
    limit: usize,
) -> Result<(String, Map), ApiError> {
    if app.cfg.federation == Policy::Off {
        return Err(ApiError::new(403, "federation_refused"));
    }
    if body.len() > limit {
        return Err(ApiError::new(413, "too_large"));
    }
    let bad = || ApiError::new(400, "bad_field");
    let v = parse_limited(body, limit).map_err(|_| bad())?;
    let m = v.as_object().ok_or_else(bad)?;
    let req = m.get("req").ok_or_else(bad)?;
    let r = req.as_object().ok_or_else(bad)?;
    let sig = m
        .get("sig")
        .and_then(Value::as_str)
        .and_then(|s| base64url_decode_fixed::<64>(s).ok())
        .ok_or_else(bad)?;
    let from = r.get("from").and_then(Value::as_str).ok_or_else(bad)?;
    let to = r.get("to").and_then(Value::as_str).ok_or_else(bad)?;
    let time = r.get("time").and_then(Value::as_int).ok_or_else(bad)?;
    let nonce = r.get("nonce").and_then(Value::as_str).ok_or_else(bad)?;
    if r.get("v").and_then(Value::as_int) != Some(1)
        || r.get("kind").and_then(Value::as_str) != Some(kind)
        || !app.is_origin(to)
        || base64url_decode_fixed::<16>(nonce).is_err()
    {
        return Err(bad());
    }
    let t = now();
    if (t - time).abs() > SKEW {
        return Err(ApiError::new(401, "stale"));
    }
    if !allowed(app, from) {
        return Err(ApiError::new(403, "federation_refused"));
    }
    // An address whose requests keep failing verification is refused before anything is fetched for it.
    let failures = format!("federation-failed:{}", crate::app::limit_net(addr));
    app.limits.spent(&failures, FAILED_PER_ADDR, 60)?;
    let signed = frame(LABEL, &canonical(req));
    let checked = async {
        let mut key = peer_key(app, from, false).await?;
        if ed25519_verify(&key, &signed, &sig).is_err() {
            // The peer may have a new key (a new host key): ask once more (at most once a minute per origin).
            key = peer_key(app, from, true).await?;
            ed25519_verify(&key, &signed, &sig).map_err(|_| ApiError::new(401, "bad_signature"))?;
        }
        Ok::<(), ApiError>(())
    };
    if let Err(e) = checked.await {
        let _ = app.limits.check(failures, FAILED_PER_ADDR, 60);
        return Err(e);
    }
    if !app.fed.fresh(from, nonce, t) {
        return Err(ApiError::new(409, "replay"));
    }
    // It is up: what waits for it here goes now rather than after its backoff.
    if app.db.outbox_wake(from, t).unwrap_or(0) > 0 {
        let app = app.clone();
        tokio::spawn(async move { flush_outbox(&app).await });
    }
    Ok((from.to_string(), r.clone()))
}

/// One envelope for a device on another server, as the client asked for it in `send`.
pub struct Outgoing {
    pub device: String,
    pub env: String,
    /// When it is given up: the mailbox lifetime from now, or its shorter `ttl`.
    pub expires: i64,
    pub notify: bool,
}

/// What became of envelopes for another server: the devices they could not be delivered to, and those they are kept
/// for because the server could not be reached now (tried again later, see [`flush_outbox`]).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Delivery {
    pub failed: Vec<String>,
    pub queued: Vec<String>,
}

/// Most envelopes kept for one server that cannot be reached.
pub const MAX_OUTBOX: i64 = 20_000;

/// When to try again after `attempts` tries that did not reach the server (seconds): a minute, doubling, at most an
/// hour.
pub fn retry_after(attempts: i64) -> i64 {
    60i64.saturating_mul(1i64 << attempts.clamp(0, 6)).min(3600)
}

/// Deliver envelopes to devices on `server`. When it cannot be reached (no answer, a server error, its rate limit),
/// they are kept and tried again with backoff until they expire; a server that answers decides at once.
pub async fn deliver(app: &Arc<App>, server: &str, msgs: Vec<Outgoing>) -> Delivery {
    let items: Vec<OutboxItem> = msgs
        .into_iter()
        .map(|m| OutboxItem {
            device: m.device,
            env: m.env,
            notify: m.notify,
            expires: m.expires,
            attempts: 0,
        })
        .collect();
    match send_items(app, server, &items).await {
        Some(failed) => Delivery {
            failed,
            queued: Vec::new(),
        },
        None => {
            let queued = app
                .db
                .outbox_put(server, &items, now() + retry_after(0), MAX_OUTBOX)
                .unwrap_or_default();
            Delivery {
                failed: items
                    .iter()
                    .filter(|it| !queued.contains(&it.device))
                    .map(|it| it.device.clone())
                    .collect(),
                queued,
            }
        }
    }
}

/// Hand envelopes to `server`: the devices they could not be delivered to when it answered, or None when it could
/// not be reached and they should be tried again (no answer, a server error, a rate limit, a time it did not take).
async fn send_items(app: &Arc<App>, server: &str, items: &[OutboxItem]) -> Option<Vec<String>> {
    let devices: Vec<String> = items.iter().map(|m| m.device.clone()).collect();
    let t = now();
    let msgs: Vec<Value> = items
        .iter()
        .map(|m| {
            // What is left of its lifetime: the other server keeps it no longer than this one would have.
            let mut o = Map::new()
                .with("device", m.device.as_str())
                .with("env", m.env.as_str())
                .with("ttl", (m.expires - t).clamp(1, MAILBOX_TTL));
            if m.notify {
                o.insert("notify", true.into());
            }
            o.into()
        })
        .collect();
    let body = signed(
        app,
        server,
        "deliver",
        Map::new().with("msgs", Value::Array(msgs)),
    );
    match post(app, format!("{server}/api/v1/federation/deliver"), body).await {
        Ok((200, v)) => {
            let failed: Vec<String> = v
                .as_object()
                .and_then(|m| m.get("failed"))
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|d| d.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            Some(devices.into_iter().filter(|d| failed.contains(d)).collect())
        }
        Ok((status, _)) if status == 401 || status == 429 || status >= 500 => None,
        Ok(_) => Some(devices),
        Err(_) => None,
    }
}

/// Try again what waits for servers that could not be reached, whose time has come: delivered or refused envelopes
/// are done, the others wait longer (see [`retry_after`]) until they expire. One run at a time.
pub async fn flush_outbox(app: &Arc<App>) {
    if app.fed.flushing.swap(true, Ordering::AcqRel) {
        return;
    }
    // Servers that still do not answer are put back for later, so this ends.
    for _ in 0..1000 {
        let t = now();
        let Ok(Some((server, items))) = app.db.outbox_due(t, MAX_RECIPIENTS as i64) else {
            break;
        };
        // A server blocked or left out of the policy since then gets nothing more.
        if !allowed(app, &server) {
            continue;
        }
        if send_items(app, &server, &items).await.is_some() {
            continue;
        }
        let again: Vec<OutboxItem> = items
            .into_iter()
            .map(|mut it| {
                it.attempts += 1;
                it
            })
            .collect();
        let attempts = again.first().map_or(1, |it| it.attempts);
        let _ = app
            .db
            .outbox_put(&server, &again, t + retry_after(attempts), MAX_OUTBOX);
    }
    app.fed.flushing.store(false, Ordering::Release);
}

fn respond(r: Result<Response, ApiError>) -> Response {
    r.unwrap_or_else(IntoResponse::into_response)
}

/// `POST /api/v1/federation/deliver` with `{ req: { v, from, to, time, nonce, msgs }, sig }`: envelopes from another
/// server for devices on this one. Answers `{ failed }`: the devices that are unknown here or whose mailbox is full.
pub async fn post_deliver(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    body: Bytes,
) -> Response {
    let run = async {
        app.limits.by_addr("federation", addr, 1200, 60)?;
        let (from, r) = verify(&app, addr, &body, "deliver", MAX_DELIVER_BODY).await?;
        let from = from.as_str();
        let bad = || ApiError::new(400, "bad_field");
        let msgs = r.get("msgs").and_then(Value::as_array).ok_or_else(bad)?;
        if msgs.is_empty() || msgs.len() > MAX_RECIPIENTS {
            return Err(bad());
        }
        app.limits
            .check(format!("federation:{}", budget_key(from)), PER_SERVER, 60)?;
        // Every envelope is checked before any is queued, so that a bad one cannot fail the delivery after others went
        // in (the sending server would then report them all as failed, and a resend would duplicate them). What fails
        // for one device only (unknown, its limit, a full mailbox) is reported in `failed`.
        let t = now();
        let mut items: Vec<(&Map, &str, &str, i64)> = Vec::with_capacity(msgs.len());
        for item in msgs {
            let o = item.as_object().ok_or_else(bad)?;
            let device = o.get("device").and_then(Value::as_str).ok_or_else(bad)?;
            let env = o.get("env").and_then(Value::as_str).ok_or_else(bad)?;
            check_envelope(env)?;
            let ttl = match o.get("ttl") {
                None => MAILBOX_TTL,
                Some(v) => v.as_int().filter(|t| *t > 0).ok_or_else(bad)?,
            };
            items.push((o, device, env, ttl));
        }
        let mut failed: Vec<Value> = Vec::new();
        for (o, device, env, ttl) in items {
            let owner = if device.len() > 64 {
                None
            } else {
                app.db.device_owner(device).map_err(ApiError::internal)?
            };
            let Some(owner) = owner else {
                failed.push(device.into());
                continue;
            };
            if app
                .limits
                .check(format!("federation-device:{device}"), 600, 60)
                .is_err()
            {
                failed.push(device.into());
                continue;
            }
            let expires = t + ttl.clamp(1, MAILBOX_TTL);
            // All accounts of the sending server share one part of the mailbox (this server cannot tell them apart).
            let share = share_for(&app, &owner, Sender::Server(from), t)?;
            match app
                .db
                .enqueue(device, env, expires, MAX_QUEUE, Some(from), share.as_ref())
                .map_err(ApiError::internal)?
            {
                Some(mid) => {
                    let push = Map::new()
                        .with("t", "msg")
                        .with("id", mid)
                        .with("env", env)
                        .with("server", from);
                    app.hub.to_device(device, Push::Text(text(&push.into())));
                    if o.get("notify").and_then(Value::as_bool) == Some(true) {
                        crate::push::schedule(&app, device, mid);
                    }
                }
                None => failed.push(device.into()),
            }
        }
        Ok(json(
            200,
            &Map::new().with("failed", Value::Array(failed)).into(),
        ))
    };
    respond(run.await)
}

/// A server origin a client asked about, checked against the federation policy.
fn server_param(app: &App, server: &str) -> Result<String, ApiError> {
    let server = server.trim_end_matches('/').to_ascii_lowercase();
    if !plain_origin(&server) {
        return Err(ApiError::new(400, "bad_server"));
    }
    if !allowed(app, &server) {
        return Err(ApiError::new(403, "federation_refused"));
    }
    Ok(server)
}

/// Percent-encode a query value.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// An error answer from another server, passed on when it is one the client knows; otherwise `server_error`.
fn passed_on(status: u16, v: &Value) -> ApiError {
    let code = v
        .as_object()
        .and_then(|m| m.get("error"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let known: &'static str = match code {
        "unknown_account" => "unknown_account",
        "ambiguous_handle" => "ambiguous_handle",
        "bad_handle" => "bad_handle",
        "rate_limited" => "rate_limited",
        "federation_refused" => "federation_refused",
        // A host that is not a Murmo server (or has no such account) says so in its own way.
        _ if status == 404 => "unknown_account",
        _ => return ApiError::new(502, "server_error"),
    };
    ApiError::new(
        if (400..500).contains(&status) {
            status
        } else {
            502
        },
        known,
    )
}

// What follows is asked over the WebSocket (`remote-lookup`, `remote-devices`), so only by a device of an account on
// this server: the server is never an open proxy towards other servers, nor a relay between accounts elsewhere.

/// An exact identifier on another server, looked up there for one of this server's users (the client never contacts
/// other servers itself): `{ account, home, handle, server }`.
pub async fn lookup(app: &Arc<App>, server: &str, handle: &str) -> Result<Value, ApiError> {
    let server = server_param(app, server)?;
    if handle.is_empty() || handle.len() > 128 {
        return Err(ApiError::new(400, "bad_handle"));
    }
    // Only a Murmo server that takes part in federation (an older one, or another kind of host, does not).
    peer_key(app, &server, false).await?;
    let (status, v) = get(
        app,
        format!("{server}/api/v1/lookup?handle={}", encode(handle)),
    )
    .await?;
    if status != 200 {
        return Err(passed_on(status, &v));
    }
    let m = v.as_object().ok_or(ApiError::new(502, "server_error"))?;
    let field = |k: &str| {
        m.get(k)
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 256)
            .ok_or(ApiError::new(502, "server_error"))
    };
    let account = field("account")?;
    check_account(account).map_err(|_| ApiError::new(502, "server_error"))?;
    Ok(Map::new()
        .with("account", account)
        .with("home", field("home")?)
        .with("handle", field("handle")?)
        .with("server", server.as_str())
        .into())
}

/// The device list and prekeys of an account on another server, with the identity's log as that server has it. The
/// client verifies the log and the list itself and pins the list's head, as for an account on this server. `fresh`
/// (a device the client does not know yet, a changed list) always asks the other server.
pub async fn devices(
    app: &Arc<App>,
    server: &str,
    account: &str,
    fresh: bool,
) -> Result<Value, ApiError> {
    let v = devices_of(app, server, account, fresh).await?;
    Ok(v)
}

/// The routes to an account's devices on another server, learned for the local account `me` that asked.
pub fn learn_list(app: &App, me: &str, v: &Value) {
    let Some(m) = v.as_object() else { return };
    let Some(server) = m.get("server").and_then(Value::as_str) else {
        return;
    };
    for pk in m
        .get("prekeys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_DEVICES)
    {
        if let Some(d) = pk
            .as_object()
            .and_then(|o| o.get("device"))
            .and_then(Value::as_str)
            && d.len() <= 64
        {
            app.fed.learn(me, d, server);
        }
    }
}

async fn devices_of(
    app: &Arc<App>,
    server: &str,
    account: &str,
    fresh: bool,
) -> Result<Value, ApiError> {
    let server = server_param(app, server)?;
    check_account(account)?;
    let key = format!("{server} {account}");
    if !fresh
        && let Some((v, _, at)) = app.fed.lists.locked().get(&key).cloned()
        && now() - at < LIST_CACHE
    {
        return Ok(v);
    }
    let (status, devices) = get(app, format!("{server}/api/v1/accounts/{account}/devices")).await?;
    if status != 200 {
        return Err(passed_on(status, &devices));
    }
    let (status, log) = get(app, format!("{server}/api/v1/accounts/{account}/log")).await?;
    if status != 200 {
        return Err(passed_on(status, &log));
    }
    let mut out = devices
        .as_object()
        .cloned()
        .ok_or(ApiError::new(502, "server_error"))?;
    // No list has more entries, nor more devices with prekeys, than a list on this server can have: a longer answer
    // is not a Murmo server's.
    let longer = |k: &str, max: usize| {
        out.get(k)
            .and_then(Value::as_array)
            .is_some_and(|a| a.len() > max)
    };
    if longer("entries", MAX_ENTRIES) || longer("prekeys", MAX_DEVICES) {
        return Err(ApiError::new(502, "server_error"));
    }
    let events = log
        .as_object()
        .and_then(|m| m.get("events"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or(ApiError::new(502, "server_error"))?;
    out.insert("events", Value::Array(events));
    out.insert("server", server.as_str().into());
    // What the other server takes from accounts elsewhere: a sender keeps within the smaller of both servers' limits.
    if let Some(l) = peer(app, &server, false).await.ok().and_then(|p| p.limits) {
        out.insert("limits", l);
    }
    let v: Value = out.into();
    app.fed.keep_list(key, &v, now());
    Ok(v)
}

// ── files between servers ───────────────────────────────────────────────────────────────────────────────────────

/// One file chunk for devices on another server, from a device of an account on this one.
pub struct RelayOut {
    pub account: String,
    pub device: String,
    pub devices: Vec<String>,
    pub store: bool,
    pub ttl: Option<i64>,
    /// The chunk as the client sent it: text, or the payload of a binary frame.
    pub text: Option<String>,
    pub binary: Option<Vec<u8>>,
}

/// The subset of `of` that the answer lists under `key`.
fn listed(m: &Map, key: &str, of: &[String]) -> Vec<String> {
    m.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|d| of.iter().any(|x| x == d))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Hand a chunk to another server. Returns the devices that did not get it, and of those the ones that take no
/// binary frames (the sender sends them text instead), as for local devices in `relay-missed`.
pub async fn relay(app: &Arc<App>, server: &str, out: RelayOut) -> (Vec<String>, Vec<String>) {
    let (data, bin) = match (&out.text, &out.binary) {
        (Some(t), _) => (t.clone(), false),
        (None, Some(b)) => (base64url_encode(b), true),
        (None, None) => return (out.devices, Vec::new()),
    };
    let sender: Value = Map::new()
        .with("account", out.account.as_str())
        .with("device", out.device.as_str())
        .into();
    let mut fields = Map::new()
        .with("sender", sender)
        .with(
            "devices",
            Value::Array(out.devices.iter().map(|d| d.as_str().into()).collect()),
        )
        .with("store", out.store)
        .with("data", data)
        .with("bin", bin);
    if let Some(t) = out.ttl {
        fields.insert("ttl", t.into());
    }
    match call(app, server, "/api/v1/federation/relay", "relay", fields).await {
        Some(m) => (
            listed(&m, "missed", &out.devices),
            listed(&m, "text", &out.devices),
        ),
        None => (out.devices, Vec::new()),
    }
}

/// Which of `devices` on `server` are connected now (none when it does not answer).
pub async fn presence(app: &Arc<App>, server: &str, devices: Vec<String>) -> Vec<String> {
    let fields = Map::new().with(
        "devices",
        Value::Array(devices.iter().map(|d| d.as_str().into()).collect()),
    );
    match call(
        app,
        server,
        "/api/v1/federation/presence",
        "presence",
        fields,
    )
    .await
    {
        Some(m) => listed(&m, "online", &devices),
        None => Vec::new(),
    }
}

/// Which of `devices` on `server` have room for `bytes` of queued chunks from `account`, by that server's limits.
pub async fn space(
    app: &Arc<App>,
    server: &str,
    account: &str,
    devices: Vec<String>,
    bytes: i64,
) -> Vec<String> {
    let fields = Map::new()
        .with("account", account)
        .with("bytes", bytes)
        .with(
            "devices",
            Value::Array(devices.iter().map(|d| d.as_str().into()).collect()),
        );
    match call(app, server, "/api/v1/federation/space", "space", fields).await {
        Some(m) => listed(&m, "ok", &devices),
        None => Vec::new(),
    }
}

/// Refuse a request from another server that speaks for an account this server serves (its rootcard home is here,
/// or its device list is): that server cannot have one of its devices, and must not use up the account's budgets.
/// Accounts named by other servers are otherwise only taken at their word for what they send, and their budgets here
/// are kept per sending server ([`crate::db::Db::relay_usage`]).
fn refuse_own_account(app: &App, account: &str) -> Result<(), ApiError> {
    use rootcard_host::store::IdentityStore;
    let home = app.host.store.load(account).map_err(ApiError::internal)?;
    let list = app.db.device_list(account).map_err(ApiError::internal)?;
    if home.is_some() || list.is_some() {
        return Err(ApiError::new(403, "not_your_account"));
    }
    Ok(())
}

/// The devices of a request from another server: a list of at most `max` device ids.
fn device_list(r: &Map, max: usize) -> Result<Vec<String>, ApiError> {
    let bad = || ApiError::new(400, "bad_field");
    let a = r.get("devices").and_then(Value::as_array).ok_or_else(bad)?;
    if a.is_empty() || a.len() > max {
        return Err(bad());
    }
    let mut out: Vec<String> = Vec::with_capacity(a.len());
    for d in a {
        let d = d
            .as_str()
            .filter(|d| d.len() <= 64 && is_b64url(d))
            .ok_or_else(bad)?;
        if !out.iter().any(|x| x == d) {
            out.push(d.to_string());
        }
    }
    Ok(out)
}

/// `POST /api/v1/federation/relay`: a file chunk from a device of an account on another server, for devices on this
/// one. Forwarded live to connected devices and, with `store`, queued for the others, within this server's own limits
/// (the same as for its own accounts: per sending account into a device, and the file queue's). Answers
/// `{ missed, text }`.
pub async fn post_relay(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    body: Bytes,
) -> Response {
    let run = async {
        app.limits
            .by_addr("federation-relay", addr, RELAY_PER_SERVER, 60)?;
        let (from, r) = verify(&app, addr, &body, "relay", MAX_RELAY_BODY).await?;
        let bad = || ApiError::new(400, "bad_field");
        let sender = r.get("sender").and_then(Value::as_object).ok_or_else(bad)?;
        let account = sender
            .get("account")
            .and_then(Value::as_str)
            .ok_or_else(bad)?;
        check_account(account)?;
        refuse_own_account(&app, account)?;
        let device = sender
            .get("device")
            .and_then(Value::as_str)
            .filter(|d| d.len() <= 64 && is_b64url(d))
            .ok_or_else(bad)?;
        let devices = device_list(&r, MAX_RECIPIENTS)?;
        let store = r.get("store").and_then(Value::as_bool) == Some(true) && app.cfg.file_queue > 0;
        let ttl = match r.get("ttl") {
            None => MAILBOX_TTL,
            Some(v) => v.as_int().filter(|t| *t > 0).ok_or_else(bad)?,
        };
        let raw = r.get("data").and_then(Value::as_str).ok_or_else(bad)?;
        let bin = r.get("bin").and_then(Value::as_bool) == Some(true);
        let payload = if bin {
            let b = base64url_decode(raw).map_err(|_| bad())?;
            if b.is_empty() || b.len() > MAX_RELAY_BIN {
                return Err(ApiError::new(400, "bad_relay"));
            }
            Some(b)
        } else {
            if raw.len() > MAX_RELAY || !is_b64url(raw) {
                return Err(ApiError::new(400, "bad_relay"));
            }
            None
        };
        let data = match &payload {
            Some(b) => ChunkData::Binary(b),
            None => ChunkData::Text(raw),
        };
        let len = u32::try_from(data.len()).unwrap_or(u32::MAX);
        let peer = budget_key(&from);
        app.limits
            .check(format!("federation-relay:{peer}"), RELAY_PER_SERVER, 60)?;
        app.limits.charge(
            &[(
                format!("federation-relay-bytes:{peer}"),
                len.saturating_mul(u32::try_from(devices.len()).unwrap_or(1)),
                RELAY_BYTES_PER_SERVER,
            )],
            60,
        )?;
        let push = match &payload {
            None => Push::Text(text(
                &Map::new()
                    .with("t", "relay")
                    .with("from", device)
                    .with("account", account)
                    .with("data", raw)
                    .into(),
            )),
            Some(b) => Push::Binary(deliver_frame(device, account, 0, b).ok_or_else(bad)?),
        };
        let expires = now() + ttl.clamp(1, MAILBOX_TTL);
        let mut missed: Vec<Value> = Vec::new();
        let mut no_binary: Vec<Value> = Vec::new();
        for d in &devices {
            if !app.db.device_known(d).map_err(ApiError::internal)? {
                missed.push(d.as_str().into());
                continue;
            }
            let delivered = match app.hub.binary(d) {
                Some(false) if bin => {
                    no_binary.push(d.as_str().into());
                    false
                }
                Some(_) => {
                    app.limits
                        .charge(
                            &[(
                                format!("relay-to:{account}@{from}>{d}"),
                                len,
                                RELAY_PEER_BYTES,
                            )],
                            60,
                        )
                        .is_ok()
                        && app.hub.to_device(d, push.clone())
                }
                None if store => {
                    app.limits
                        .charge(
                            &[(
                                format!("relay-store:{account}@{from}"),
                                len,
                                app.cfg.relay_store,
                            )],
                            60,
                        )
                        .is_ok()
                        && app
                            .db
                            .relay_enqueue(
                                d,
                                device,
                                account,
                                Some(&from),
                                data,
                                expires,
                                &app.cfg.queue_limits(),
                            )
                            .map_err(ApiError::internal)?
                }
                None => false,
            };
            if !delivered {
                missed.push(d.as_str().into());
            }
        }
        Ok(json(
            200,
            &Map::new()
                .with("missed", Value::Array(missed))
                .with("text", Value::Array(no_binary))
                .into(),
        ))
    };
    respond(run.await)
}

/// `POST /api/v1/federation/presence`: which of these devices on this server are connected (`{ online }`).
pub async fn post_presence(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    body: Bytes,
) -> Response {
    let run = async {
        app.limits.by_addr("federation", addr, 1200, 60)?;
        let (from, r) = verify(&app, addr, &body, "presence", crate::api::MAX_BODY).await?;
        app.limits.check(
            format!("federation-presence:{}", budget_key(&from)),
            6000,
            60,
        )?;
        let online: Vec<Value> = device_list(&r, MAX_PRESENCE)?
            .into_iter()
            .filter(|d| app.hub.is_connected(d))
            .map(Value::from)
            .collect();
        Ok(json(
            200,
            &Map::new().with("online", Value::Array(online)).into(),
        ))
    };
    respond(run.await)
}

/// `POST /api/v1/federation/space`: which of these devices on this server have room in the file queue for `bytes`
/// from `account` (`{ ok }`), by this server's limits.
pub async fn post_space(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    body: Bytes,
) -> Response {
    let run = async {
        app.limits.by_addr("federation", addr, 1200, 60)?;
        let (from, r) = verify(&app, addr, &body, "space", crate::api::MAX_BODY).await?;
        app.limits
            .check(format!("federation-space:{}", budget_key(&from)), 6000, 60)?;
        let bad = || ApiError::new(400, "bad_field");
        let account = r.get("account").and_then(Value::as_str).ok_or_else(bad)?;
        check_account(account)?;
        refuse_own_account(&app, account)?;
        let bytes = r
            .get("bytes")
            .and_then(Value::as_int)
            .filter(|b| *b >= 0)
            .ok_or_else(bad)?;
        let devices = device_list(&r, MAX_PRESENCE)?;
        let local: Vec<&str> = devices.iter().map(String::as_str).collect();
        let ok: Vec<Value> = space_for(&app, account, Some(&from), &local, bytes)?
            .into_iter()
            .map(Value::from)
            .collect();
        Ok(json(200, &Map::new().with("ok", Value::Array(ok)).into()))
    };
    respond(run.await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::decode;

    #[test]
    fn policies() {
        assert_eq!(Policy::parse(""), Policy::Open);
        assert_eq!(Policy::parse("open"), Policy::Open);
        assert_eq!(Policy::parse("off"), Policy::Off);
        assert_eq!(
            Policy::parse("https://a.example, https://b.example/"),
            Policy::Allow(vec!["https://a.example".into(), "https://b.example".into()])
        );
    }

    #[test]
    fn origins() {
        assert!(public_origin("https://murmo.example"));
        assert!(public_origin("https://murmo.example:8443"));
        assert!(!public_origin("http://murmo.example"));
        assert!(!public_origin("https://localhost"));
        assert!(!public_origin("https://10.0.0.1"));
        assert!(!public_origin("https://[::1]"));
        assert!(!public_origin("https://murmo.example/path"));
        assert!(!public_origin("https://user@murmo.example"));
        assert!(!public_origin("https://Murmo.example"));
        assert!(!public_origin("https://printer.local"));
        // Spellings that resolvers read as internal addresses or as localhost (T23, T40).
        for o in [
            "https://127.1",
            "https://10.1",
            "https://0x7f.0.0.1",
            "https://localhost.",
            "https://127.0.0.1:8443",
            "https://db.internal",
        ] {
            assert!(!public_origin(o), "{o}");
        }
        assert!(plain_origin("http://127.0.0.1:8080"));
    }

    #[test]
    fn blocks_go_by_host_and_subdomains() {
        let block: Vec<String> = [
            "https://evil.example/",
            "Bad.Example.",
            "https://other.example:443",
            "http://127.0.0.1:8002",
            "  ",
        ]
        .iter()
        .filter_map(|s| block_entry(s))
        .collect();
        assert_eq!(
            block,
            vec![
                "evil.example",
                "bad.example",
                "other.example",
                "127.0.0.1:8002"
            ]
        );
        for o in [
            "https://evil.example",
            "https://evil.example:443",
            "https://evil.example:8443",
            "http://evil.example",
            "https://a.evil.example",
            "https://a.b.evil.example:9000",
            "https://bad.example",
            "https://x.bad.example",
            "https://other.example",
            "http://127.0.0.1:8002",
        ] {
            assert!(blocked(&block, o), "{o} should be blocked");
        }
        for o in [
            "https://notevil.example",
            "https://evil.example.org",
            "https://good.example",
            "https://example",
            "http://127.0.0.1:8001",
        ] {
            assert!(!blocked(&block, o), "{o} should not be blocked");
        }
    }

    #[test]
    fn budgets_are_per_host() {
        assert_eq!(budget_key("https://a.example"), "a.example");
        assert_eq!(budget_key("https://a.example:443"), "a.example");
        assert_eq!(budget_key("https://a.example:8443"), "a.example");
        assert_eq!(budget_key("http://[::1]:80"), "[::1]");
        assert_ne!(budget_key("https://b.a.example"), "a.example");
    }

    #[test]
    fn routes_are_capped_per_account() {
        let f = Federation::new(&[7; 32]);
        for i in 0..MAX_ROUTES {
            f.learn("A", &format!("d{i}"), "https://b.example");
        }
        f.learn("B", "x", "https://c.example");
        {
            // d0 was used last, then the others in order: d1 is the least recently used.
            let mut routes = f.routes.lock().expect("lock");
            let mine = routes.get_mut("A").expect("routes of A");
            for i in 0..MAX_ROUTES {
                if let Some((_, at)) = mine.get_mut(&format!("d{i}")) {
                    *at = if i == 0 {
                        i64::MAX
                    } else {
                        i64::try_from(i).unwrap_or_default()
                    };
                }
            }
        }
        let len = |a: &str| {
            f.routes
                .lock()
                .expect("lock")
                .get(a)
                .map_or(0, HashMap::len)
        };
        f.learn("A", "new", "https://b.example");
        assert_eq!(len("A"), MAX_ROUTES);
        assert!(f.route("A", "new").is_some());
        assert!(f.route("A", "d0").is_some());
        assert!(f.route("A", "d1").is_none());
        assert!(f.route("A", "d2").is_some());
        // Other accounts are not affected, and a known device is updated in place.
        assert_eq!(f.route("B", "x").as_deref(), Some("https://c.example"));
        f.learn("A", "new", "https://d.example");
        assert_eq!(len("A"), MAX_ROUTES);
        assert_eq!(f.route("A", "new").as_deref(), Some("https://d.example"));
    }

    #[test]
    fn device_lists_are_capped_in_number_and_size() {
        let f = Federation::new(&[7; 32]);
        let t = now();
        for i in 0..MAX_LISTS + 10 {
            f.keep_list(format!("s a{i}"), &Value::from("x"), t);
        }
        assert_eq!(f.lists.lock().expect("lock").len(), MAX_LISTS);
        // Large answers push older ones out until they fit; one larger than a quarter of the cap is not kept.
        let big = Value::from("x".repeat(MAX_LISTS_BYTES / 5));
        for i in 0..8 {
            f.keep_list(format!("s big{i}"), &big, t);
        }
        let bytes: usize = f
            .lists
            .lock()
            .expect("lock")
            .values()
            .map(|(_, n, _)| n)
            .sum();
        assert!(bytes <= MAX_LISTS_BYTES);
        assert!(f.lists.lock().expect("lock").contains_key("s big7"));
        f.keep_list(
            "s huge".into(),
            &Value::from("x".repeat(MAX_LISTS_BYTES / 2)),
            t,
        );
        assert!(!f.lists.lock().expect("lock").contains_key("s huge"));
    }

    #[test]
    fn peers_are_capped() {
        let f = Federation::new(&[7; 32]);
        for i in 0..MAX_PEERS + 5 {
            let p = Peer {
                key: None,
                limits: None,
                at: i64::try_from(i).unwrap_or_default(),
                tried: 0,
                unreachable: false,
            };
            f.keep_peer(&format!("https://s{i}.example"), p);
        }
        let keys = f.keys.lock().expect("lock");
        assert_eq!(keys.len(), MAX_PEERS);
        assert!(!keys.contains_key("https://s0.example"));
        assert!(keys.contains_key(&format!("https://s{}.example", MAX_PEERS + 4)));
    }

    #[test]
    fn retries_back_off_to_an_hour() {
        assert_eq!(retry_after(0), 60);
        assert_eq!(retry_after(1), 120);
        assert_eq!(retry_after(5), 1920);
        assert_eq!(retry_after(6), 3600);
        assert_eq!(retry_after(100), 3600);
        assert_eq!(retry_after(-3), 60);
    }

    fn item(device: &str) -> OutboxItem {
        OutboxItem {
            device: device.into(),
            env: "e".into(),
            notify: false,
            expires: 1000,
            attempts: 0,
        }
    }

    #[test]
    fn the_outbox_keeps_envelopes_per_server_within_its_cap() {
        let db = crate::db::Db::open(":memory:").expect("db");
        let kept = db
            .outbox_put(
                "https://a.example",
                &[item("d1"), item("d2"), item("d3")],
                100,
                2,
            )
            .expect("put");
        assert_eq!(kept, vec!["d1", "d2"]);
        db.outbox_put("https://b.example", &[item("e1")], 500, 2)
            .expect("put");
        // Nothing is due before its time; then one server at a time, taken out as it is handed over.
        assert_eq!(db.outbox_due(99, 24).expect("due"), None);
        let (server, items) = db.outbox_due(100, 24).expect("due").expect("some");
        assert_eq!(server, "https://a.example");
        assert_eq!(items.len(), 2);
        assert_eq!(db.outbox_due(100, 24).expect("due"), None);
        // A server heard from is due at once; expired envelopes are not handed out.
        assert_eq!(db.outbox_wake("https://b.example", 200).expect("wake"), 1);
        let (server, items) = db.outbox_due(200, 24).expect("due").expect("some");
        assert_eq!(
            (server.as_str(), items[0].device.as_str()),
            ("https://b.example", "e1")
        );
        db.outbox_put("https://b.example", &[item("e2")], 100, 2)
            .expect("put");
        assert_eq!(db.outbox_due(1001, 24).expect("due"), None);
    }

    #[test]
    fn replays_are_refused() {
        let f = Federation::new(&[7; 32]);
        assert!(f.fresh("https://a.example", "n1", 1000));
        assert!(!f.fresh("https://a.example", "n1", 1001));
        assert!(f.fresh("https://b.example", "n1", 1001));
        // Long after, the nonce is forgotten; by then the delivery's time is too old anyway.
        assert!(f.fresh("https://a.example", "n1", 1000 + 2 * SKEW));
    }

    #[test]
    fn query_values_are_encoded() {
        assert_eq!(encode("Alice#3F9C"), "Alice%233F9C");
        assert_eq!(decode(&encode("a b&c")).as_deref(), Some("a b&c"));
    }
}
