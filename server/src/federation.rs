//! Federation: Murmo servers that hand each other envelopes (DESIGN.md §14).
//!
//! Every account has one Murmo server, where its device list and mailbox are. A client talks only to its own server;
//! for a contact on another server, its server fetches what the client needs from there (the lookup, the device list
//! and the identity's log, all of which the client verifies itself) and delivers the envelopes there. A delivery is
//! signed by the sending server's federation key (derived from its host key) and checked by the receiving server
//! against the key the sender publishes in `/api/v1/info`, fetched over https from the origin it claims to be. The
//! receiving server learns which server sent an envelope, never which account or device.
//!
//! Which servers take part is the operator's choice (`MURMO_FEDERATION`: `open`, `off`, or a list of origins, and
//! `MURMO_FEDERATION_BLOCK`). An open server talks only to public https origins with a domain name.

use crate::api::check_account;
use crate::app::{App, Push, now, random, text};
use crate::error::{ApiError, json};
use crate::remote::origin_of;
use crate::ws::{MAILBOX_TTL, MAX_QUEUE, MAX_RECIPIENTS, check_envelope};
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use rootcard::crypto::{ed25519_public, ed25519_sign, ed25519_verify, frame, hkdf};
use rootcard::encoding::{base64url_decode_fixed, base64url_encode};
use rootcard::json::{Map, Value, canonical, parse_limited};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
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
/// Envelopes per minute from one server.
const PER_SERVER: u32 = 6000;
/// How long a device list fetched from another server is reused for other requests (seconds). All of this server's
/// users share its network address at the other server, and so its rate limits there.
const LIST_CACHE: i64 = 20;

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

/// A peer's federation key (None: it publishes none) and when it was fetched.
type PeerKey = (Option<[u8; 32]>, i64);

/// This server's federation key and what it remembers about other servers.
pub struct Federation {
    seed: Zeroizing<[u8; 32]>,
    /// The public key, base64url, as published in `/api/v1/info`.
    pub public: String,
    /// Peers' keys by origin.
    keys: Mutex<HashMap<String, PeerKey>>,
    /// Deliveries seen (`origin nonce` → time), against replays.
    nonces: Mutex<HashMap<String, i64>>,
    /// Device lists with logs fetched from other servers (`origin account` → answer, time).
    lists: Mutex<HashMap<String, (Value, i64)>>,
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
        }
    }

    fn sign(&self, m: &[u8]) -> [u8; 64] {
        ed25519_sign(&self.seed, m)
    }

    /// Remember a delivery; false if it was seen before.
    fn fresh(&self, origin: &str, nonce: &str, t: i64) -> bool {
        let mut n = self.nonces.lock().unwrap_or_else(|e| e.into_inner());
        n.retain(|_, seen| t - *seen < 2 * SKEW);
        match n.entry(format!("{origin} {nonce}")) {
            std::collections::hash_map::Entry::Occupied(_) => false,
            std::collections::hash_map::Entry::Vacant(v) => {
                v.insert(t);
                true
            }
        }
    }

    /// Forget peers' keys fetched long ago.
    pub fn sweep(&self) {
        let t = now();
        self.keys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, (_, at)| t - *at < KEY_TTL);
        self.lists
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, (_, at)| t - *at < LIST_CACHE);
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

/// A public https origin with a domain name: never an IP literal or a name without a dot.
fn public_origin(o: &str) -> bool {
    let Some(host) = o.strip_prefix("https://") else {
        return false;
    };
    let name = host.split(':').next().unwrap_or_default();
    plain_origin(o)
        && name.contains('.')
        && !name.ends_with(".local")
        && !name.ends_with(".internal")
        && !name.ends_with(".localhost")
        && name.parse::<std::net::Ipv4Addr>().is_err()
}

/// Whether this server exchanges envelopes with `origin`.
pub fn allowed(app: &App, origin: &str) -> bool {
    if app.is_origin(origin) || app.cfg.federation_block.iter().any(|b| b == origin) {
        return false;
    }
    match &app.cfg.federation {
        Policy::Off => false,
        Policy::Open => public_origin(origin),
        Policy::Allow(list) => plain_origin(origin) && list.iter().any(|o| o == origin),
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into()
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
async fn get(url: String) -> Result<(u16, Value), ApiError> {
    tokio::task::spawn_blocking(move || answer(agent().get(&url).call()))
        .await
        .map_err(ApiError::internal)?
}

/// POST a JSON body to another server (blocking task).
async fn post(url: String, body: Vec<u8>) -> Result<(u16, Value), ApiError> {
    tokio::task::spawn_blocking(move || {
        answer(
            agent()
                .post(&url)
                .header("Content-Type", "application/json")
                .send(&body[..]),
        )
    })
    .await
    .map_err(ApiError::internal)?
}

/// A peer's federation key, from its `/api/v1/info` (cached; `fresh` fetches it again).
async fn peer_key(app: &Arc<App>, origin: &str, fresh: bool) -> Result<[u8; 32], ApiError> {
    let t = now();
    if !fresh
        && let Some((key, at)) = app
            .fed
            .keys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(origin)
            .copied()
        && t - at < if key.is_some() { KEY_TTL } else { 60 }
    {
        return key.ok_or(ApiError::new(403, "federation_refused"));
    }
    let (status, info) = get(format!("{origin}/api/v1/info")).await?;
    let info = info.as_object().filter(|_| status == 200);
    // The peer must say it is this origin, and publish a key.
    let key = info
        .filter(|m| {
            m.get("origins")
                .and_then(Value::as_array)
                .is_some_and(|a| a.iter().any(|o| o.as_str() == Some(origin)))
        })
        .and_then(|m| m.get("federation"))
        .and_then(Value::as_object)
        .and_then(|f| f.get("key"))
        .and_then(Value::as_str)
        .and_then(|k| base64url_decode_fixed::<32>(k).ok());
    app.fed
        .keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(origin.to_string(), (key, t));
    key.ok_or(ApiError::new(403, "federation_refused"))
}

/// One envelope for a device on another server, as the client asked for it in `send`.
pub struct Outgoing {
    pub device: String,
    pub env: String,
    pub ttl: Option<i64>,
    pub notify: bool,
}

/// Deliver envelopes to devices on `server`; returns the devices they could not be delivered to.
pub async fn deliver(app: &Arc<App>, server: &str, msgs: Vec<Outgoing>) -> Vec<String> {
    let devices: Vec<String> = msgs.iter().map(|m| m.device.clone()).collect();
    let items: Vec<Value> = msgs
        .into_iter()
        .map(|m| {
            let mut o = Map::new().with("device", m.device).with("env", m.env);
            if let Some(ttl) = m.ttl {
                o.insert("ttl", ttl.into());
            }
            if m.notify {
                o.insert("notify", true.into());
            }
            o.into()
        })
        .collect();
    let req: Value = Map::new()
        .with("v", 1i64)
        .with("from", app.cfg.origin.as_str())
        .with("to", server)
        .with("time", now())
        .with("nonce", base64url_encode(&random::<16>()))
        .with("msgs", Value::Array(items))
        .into();
    let sig = app.fed.sign(&frame(LABEL, &canonical(&req)));
    let body = canonical(
        &Map::new()
            .with("req", req)
            .with("sig", base64url_encode(&sig))
            .into(),
    );
    match post(format!("{server}/api/v1/federation/deliver"), body).await {
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
            devices.into_iter().filter(|d| failed.contains(d)).collect()
        }
        _ => devices,
    }
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
        if app.cfg.federation == Policy::Off {
            return Err(ApiError::new(403, "federation_refused"));
        }
        if body.len() > MAX_DELIVER_BODY {
            return Err(ApiError::new(413, "too_large"));
        }
        let bad = || ApiError::new(400, "bad_field");
        let v = parse_limited(&body, MAX_DELIVER_BODY).map_err(|_| bad())?;
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
        let msgs = r.get("msgs").and_then(Value::as_array).ok_or_else(bad)?;
        if r.get("v").and_then(Value::as_int) != Some(1)
            || !app.is_origin(to)
            || base64url_decode_fixed::<16>(nonce).is_err()
            || msgs.is_empty()
            || msgs.len() > MAX_RECIPIENTS
        {
            return Err(bad());
        }
        let t = now();
        if (t - time).abs() > SKEW {
            return Err(ApiError::new(401, "stale"));
        }
        if !allowed(&app, from) {
            return Err(ApiError::new(403, "federation_refused"));
        }
        app.limits
            .check(format!("federation:{from}"), PER_SERVER, 60)?;
        let signed = frame(LABEL, &canonical(req));
        let mut key = peer_key(&app, from, false).await?;
        if ed25519_verify(&key, &signed, &sig).is_err() {
            // The peer may have a new key (a new host key): ask once more.
            key = peer_key(&app, from, true).await?;
            ed25519_verify(&key, &signed, &sig).map_err(|_| ApiError::new(401, "bad_signature"))?;
        }
        if !app.fed.fresh(from, nonce, t) {
            return Err(ApiError::new(409, "replay"));
        }
        let mut failed: Vec<Value> = Vec::new();
        for item in msgs {
            let o = item.as_object().ok_or_else(bad)?;
            let device = o.get("device").and_then(Value::as_str).ok_or_else(bad)?;
            let env = o.get("env").and_then(Value::as_str).ok_or_else(bad)?;
            check_envelope(env)?;
            let ttl = match o.get("ttl") {
                None => MAILBOX_TTL,
                Some(v) => v.as_int().filter(|t| *t > 0).ok_or_else(bad)?,
            };
            if device.len() > 64 || !app.db.device_known(device).map_err(ApiError::internal)? {
                failed.push(device.into());
                continue;
            }
            app.limits
                .check(format!("federation-device:{device}"), 600, 60)?;
            let expires = t + ttl.clamp(1, MAILBOX_TTL);
            match app
                .db
                .enqueue(device, env, expires, MAX_QUEUE, Some(from))
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
    let (status, v) = get(format!("{server}/api/v1/lookup?handle={}", encode(handle))).await?;
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
    let server = server_param(app, server)?;
    check_account(account)?;
    let key = format!("{server} {account}");
    if !fresh
        && let Some((v, at)) = app
            .fed
            .lists
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .cloned()
        && now() - at < LIST_CACHE
    {
        return Ok(v);
    }
    let (status, devices) = get(format!("{server}/api/v1/accounts/{account}/devices")).await?;
    if status != 200 {
        return Err(passed_on(status, &devices));
    }
    let (status, log) = get(format!("{server}/api/v1/accounts/{account}/log")).await?;
    if status != 200 {
        return Err(passed_on(status, &log));
    }
    let mut out = devices
        .as_object()
        .cloned()
        .ok_or(ApiError::new(502, "server_error"))?;
    let events = log
        .as_object()
        .and_then(|m| m.get("events"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or(ApiError::new(502, "server_error"))?;
    out.insert("events", Value::Array(events));
    out.insert("server", server.as_str().into());
    let v: Value = out.into();
    app.fed
        .lists
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, (v.clone(), now()));
    Ok(v)
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
        assert!(plain_origin("http://127.0.0.1:8080"));
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
