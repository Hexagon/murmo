//! `/api/v1/ws`: the authenticated mailbox (DESIGN.md §10). A device proves itself by signing a fresh challenge; then
//! it receives queued envelopes, pushes and link requests, and can send, acknowledge and publish prekeys.

use crate::app::{App, PUSH_QUEUE, Push, now, random, text};
use crate::devices::{verify_prekey, verify_ws_auth};
use crate::error::ApiError;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use rootcard::encoding::base64url_encode;
use rootcard::json::{Map, Value, parse_limited};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// Largest envelope (base64url text).
pub const MAX_ENVELOPE: usize = 96 * 1024;
/// Most recipients per send.
pub const MAX_RECIPIENTS: usize = 24;
/// Most queued envelopes per device.
pub const MAX_QUEUE: i64 = 2000;
/// Mailbox lifetime in seconds (14 days).
pub const MAILBOX_TTL: i64 = 14 * 24 * 3600;
/// Largest relay payload (base64url text): one file chunk.
pub const MAX_RELAY: usize = 96 * 1024;
/// Relay budget per sending device and minute, in bytes of chunk text counted once per recipient device.
pub const RELAY_BYTES: u32 = 384 << 20;
/// Relay budget per sending account and recipient device and minute, in bytes of chunk text: what one account can
/// push into one device, whichever of its devices sends.
pub const RELAY_PEER_BYTES: u32 = 96 << 20;
/// Most devices per presence query.
pub const MAX_PRESENCE: usize = 32;
/// Largest frame accepted from a client.
pub const MAX_FRAME: usize = 3 * 1024 * 1024;

/// Upgrade to a WebSocket. A browser's `Origin` must be this server's origin.
pub async fn upgrade(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let origin = match headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        Some(o) if !app.is_origin(o) => return ApiError::new(403, "bad_origin").into_response(),
        Some(o) => Some(o.to_string()),
        // Not a browser: the device may sign for any of this server's origins.
        None => None,
    };
    if let Err(e) = app.limits.by_addr("ws", addr, 60, 60) {
        return e.into_response();
    }
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| async move {
            let _ = run(app, socket, origin).await;
        })
}

fn frame(m: Map) -> Message {
    Message::Text(text(&m.into()).into())
}

fn error(code: &str) -> Message {
    frame(Map::new().with("t", "error").with("error", code))
}

async fn recv_object(socket: &mut WebSocket) -> Option<Map> {
    loop {
        match socket.recv().await? {
            Ok(Message::Text(t)) => {
                return match parse_limited(t.as_bytes(), MAX_FRAME) {
                    Ok(Value::Object(m)) => Some(m),
                    _ => None,
                };
            }
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            _ => return None,
        }
    }
}

struct Authed {
    account: String,
    device: String,
}

async fn authenticate(
    app: &Arc<App>,
    socket: &mut WebSocket,
    origin: Option<&str>,
) -> Option<Authed> {
    let nonce = base64url_encode(&random::<32>());
    socket
        .send(frame(
            Map::new()
                .with("t", "challenge")
                .with("nonce", nonce.as_str()),
        ))
        .await
        .ok()?;
    let m = tokio::time::timeout(Duration::from_secs(30), recv_object(socket))
        .await
        .ok()??;
    if m.get("t").and_then(Value::as_str) != Some("auth") {
        return None;
    }
    let account = m.get("account").and_then(Value::as_str)?.to_string();
    let device = m.get("device").and_then(Value::as_str)?.to_string();
    let sig = m.get("sig").and_then(Value::as_str)?;
    crate::remote::refresh_if_remote(app, &account, 300).await;
    let cur = match app.current(&account) {
        Ok(c) => c,
        Err(e) => {
            let _ = socket.send(error(e.code)).await;
            return None;
        }
    };
    let Some(dev) = cur.device(&device) else {
        let _ = socket.send(error("unknown_device")).await;
        return None;
    };
    let signed = match origin {
        Some(o) => verify_ws_auth(dev, &account, &nonce, o, sig).is_ok(),
        None => app
            .origins()
            .any(|o| verify_ws_auth(dev, &account, &nonce, o, sig).is_ok()),
    };
    if !signed {
        let _ = socket.send(error("bad_signature")).await;
        return None;
    }
    Some(Authed { account, device })
}

async fn run(
    app: Arc<App>,
    mut socket: WebSocket,
    origin: Option<String>,
) -> Result<(), axum::Error> {
    let Some(me) = authenticate(&app, &mut socket, origin.as_deref()).await else {
        let _ = socket.send(Message::Close(None)).await;
        return Ok(());
    };
    let (tx, mut rx) = mpsc::channel::<Push>(PUSH_QUEUE);
    let conn = app.hub.register(&me.device, &me.account, tx);
    // When each device was last connected, so the owner can tell which devices are still in use (`seen`).
    let _ = app.db.set_seen(&me.device, now());
    let result = session(&app, &me, &mut socket, &mut rx).await;
    app.hub.unregister(&me.device, conn);
    let _ = app.db.set_seen(&me.device, now());
    result
}

async fn session(
    app: &Arc<App>,
    me: &Authed,
    socket: &mut WebSocket,
    rx: &mut mpsc::Receiver<Push>,
) -> Result<(), axum::Error> {
    // The relay budgets, so that the client can pace a file transfer instead of running into them.
    socket
        .send(frame(
            Map::new().with("t", "ready").with(
                "relay",
                Map::new()
                    .with("bytes", i64::from(app.limits.budget(RELAY_BYTES)))
                    .with("peer", i64::from(app.limits.budget(RELAY_PEER_BYTES)))
                    .with("window", 60i64),
            ),
        ))
        .await?;
    // Queued envelopes, then pending link requests.
    let mut after = 0i64;
    loop {
        let batch = app
            .db
            .queued(&me.device, after, 200)
            .map_err(axum::Error::new)?;
        if batch.is_empty() {
            break;
        }
        for (id, env) in batch {
            after = id;
            socket
                .send(frame(
                    Map::new().with("t", "msg").with("id", id).with("env", env),
                ))
                .await?;
        }
    }
    for r in app.links.pending(&me.account) {
        socket
            .send(frame(Map::new().with("t", "link").with("request", r.value)))
            .await?;
    }
    let mut ping = tokio::time::interval(Duration::from_secs(30));
    // File chunks queued while this device was away follow, a few at a time between other frames.
    let mut relay_after = 0i64;
    let mut relay_more = true;
    loop {
        tokio::select! {
            biased;
            push = rx.recv() => match push {
                Some(Push::Text(t)) => socket.send(Message::Text(t.into())).await?,
                None => {
                    let _ = socket.send(Message::Close(None)).await;
                    return Ok(());
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    if let Some(r) = text_frame(app, me, t.as_bytes()) {
                        socket.send(r).await?;
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => return Ok(()),
            },
            _ = ping.tick() => socket.send(Message::Ping(Vec::new().into())).await?,
            _ = std::future::ready(()), if relay_more => {
                let batch = app
                    .db
                    .relay_queued(&me.device, relay_after, 4)
                    .map_err(axum::Error::new)?;
                relay_more = !batch.is_empty();
                for (id, sender, account, data) in batch {
                    relay_after = id;
                    socket
                        .send(frame(
                            Map::new()
                                .with("t", "relay")
                                .with("id", id)
                                .with("from", sender)
                                .with("account", account)
                                .with("data", data),
                        ))
                        .await?;
                }
            }
        }
    }
}

/// The reply to a text frame from an authenticated device, if any.
fn text_frame(app: &Arc<App>, me: &Authed, text: &[u8]) -> Option<Message> {
    match parse_limited(text, MAX_FRAME) {
        Ok(Value::Object(m)) => handle(app, me, &m),
        _ => Some(error("bad_json")),
    }
}

/// [`text_frame`] for the fuzz targets: the reply as text.
#[doc(hidden)]
pub fn fuzz_frame(app: &Arc<App>, account: &str, device: &str, text: &[u8]) -> Option<String> {
    let me = Authed {
        account: account.to_string(),
        device: device.to_string(),
    };
    match text_frame(app, &me, text)? {
        Message::Text(t) => Some(t.to_string()),
        _ => None,
    }
}

fn handle(app: &Arc<App>, me: &Authed, m: &Map) -> Option<Message> {
    let r = match m.get("t").and_then(Value::as_str) {
        Some("send") => send(app, me, m),
        Some("ack") => ack(app, me, m),
        Some("prekey") => prekey(app, me, m),
        Some("link-decline") => {
            if let Some(id) = m.get("id").and_then(Value::as_str) {
                app.links.remove(&me.account, |r| r.id == id);
            }
            Ok(None)
        }
        Some("relay") => relay(app, me, m),
        Some("relay-ack") => relay_ack(app, me, m),
        Some("relay-space") => relay_space(app, me, m),
        Some("presence") => presence(app, me, m),
        Some("seen") => seen(app, me, m),
        Some("push-sub") => push_sub(app, me, m),
        Some("ping") => Ok(Some(frame(Map::new().with("t", "pong")))),
        _ => Err(ApiError::new(400, "bad_frame")),
    };
    match r {
        Ok(msg) => msg,
        Err(e) => {
            let mut f = Map::new().with("t", "error").with("error", e.code);
            if let Some(s) = e.retry_after {
                f.insert("retry", i64::try_from(s).unwrap_or(i64::MAX).into());
            }
            if let Some(id) = m.get("id").and_then(Value::as_str) {
                f.insert("id", id.into());
            } else if let Some(r) = m.get("ref").and_then(Value::as_str)
                && r.len() <= 64
            {
                f.insert("id", r.into());
            }
            Some(frame(f))
        }
    }
}

fn send(app: &Arc<App>, me: &Authed, m: &Map) -> Result<Option<Message>, ApiError> {
    app.limits.check(format!("send:{}", me.device), 60, 60)?;
    let id = m
        .get("id")
        .and_then(Value::as_str)
        .ok_or(ApiError::new(400, "bad_field"))?;
    if id.len() > 64 {
        return Err(ApiError::new(400, "bad_field"));
    }
    let to = m
        .get("to")
        .and_then(Value::as_array)
        .ok_or(ApiError::new(400, "bad_field"))?;
    if to.is_empty() || to.len() > MAX_RECIPIENTS {
        return Err(ApiError::new(400, "bad_field"));
    }
    let mut failed: Vec<Value> = Vec::new();
    let expires = now() + MAILBOX_TTL;
    for r in to {
        let o = r.as_object().ok_or(ApiError::new(400, "bad_field"))?;
        let device = o
            .get("device")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(400, "bad_field"))?;
        let env = o
            .get("env")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(400, "bad_field"))?;
        if env.len() > MAX_ENVELOPE
            || !env
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(ApiError::new(400, "bad_envelope"));
        }
        if !app.db.device_known(device).map_err(ApiError::internal)? {
            failed.push(device.into());
            continue;
        }
        match app
            .db
            .enqueue(device, env, expires, MAX_QUEUE)
            .map_err(ApiError::internal)?
        {
            Some(mid) => {
                let push = Map::new().with("t", "msg").with("id", mid).with("env", env);
                app.hub.to_device(device, Push::Text(text(&push.into())));
                // The sender marks what the user should hear about; the server cannot tell (it is ciphertext).
                if o.get("notify").and_then(Value::as_bool) == Some(true) {
                    crate::push::schedule(app, device, mid);
                }
            }
            None => failed.push(device.into()),
        }
    }
    Ok(Some(frame(
        Map::new()
            .with("t", "sent")
            .with("id", id)
            .with("failed", Value::Array(failed)),
    )))
}

fn ack(app: &App, me: &Authed, m: &Map) -> Result<Option<Message>, ApiError> {
    let ids = m
        .get("ids")
        .and_then(Value::as_array)
        .ok_or(ApiError::new(400, "bad_field"))?;
    if ids.len() > 500 {
        return Err(ApiError::new(400, "bad_field"));
    }
    let ids: Vec<i64> = ids.iter().filter_map(Value::as_int).collect();
    app.db.ack(&me.device, &ids).map_err(ApiError::internal)?;
    Ok(None)
}

fn prekey(app: &App, me: &Authed, m: &Map) -> Result<Option<Message>, ApiError> {
    app.limits
        .check(format!("prekey:{}", me.device), 10, 3600)?;
    let cur = app.current(&me.account)?;
    let dev = cur
        .device(&me.device)
        .ok_or(ApiError::new(403, "unknown_device"))?;
    let p = verify_prekey(
        &me.account,
        dev,
        m.get("prekey").ok_or(ApiError::new(400, "bad_field"))?,
    )?;
    app.db
        .put_prekey(&me.account, &me.device, &p.value)
        .map_err(ApiError::internal)?;
    Ok(Some(frame(
        Map::new().with("t", "prekey-ok").with("id", p.id.as_str()),
    )))
}

/// Live relay to connected devices only: nothing is stored, devices that are not connected are reported back.
fn relay(app: &App, me: &Authed, m: &Map) -> Result<Option<Message>, ApiError> {
    app.limits.check(format!("relay:{}", me.device), 3000, 60)?;
    let data = m
        .get("data")
        .and_then(Value::as_str)
        .ok_or(ApiError::new(400, "bad_field"))?;
    if data.len() > MAX_RELAY
        || !data
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError::new(400, "bad_relay"));
    }
    let to = m
        .get("to")
        .and_then(Value::as_array)
        .ok_or(ApiError::new(400, "bad_field"))?;
    if to.is_empty() || to.len() > MAX_RECIPIENTS {
        return Err(ApiError::new(400, "bad_field"));
    }
    // Bytes, not only frames: once per recipient device for the sender, and per recipient for the sending account.
    let mut targets: Vec<&str> = Vec::with_capacity(to.len());
    for d in to {
        let d = d.as_str().ok_or(ApiError::new(400, "bad_field"))?;
        if d != me.device && !targets.contains(&d) {
            targets.push(d);
        }
    }
    let len = u32::try_from(data.len()).unwrap_or(u32::MAX);
    let mut budget: Vec<(String, u32, u32)> = Vec::with_capacity(targets.len() + 1);
    budget.push((
        format!("relay-bytes:{}", me.device),
        len.saturating_mul(u32::try_from(targets.len()).unwrap_or(u32::MAX)),
        RELAY_BYTES,
    ));
    for d in &targets {
        budget.push((
            format!("relay-to:{}>{d}", me.account),
            len,
            RELAY_PEER_BYTES,
        ));
    }
    app.limits.charge(&budget, 60)?;
    let push = text(
        &Map::new()
            .with("t", "relay")
            .with("from", me.device.as_str())
            .with("account", me.account.as_str())
            .with("data", data)
            .into(),
    );
    // `store`: keep the chunk for devices that are not connected (ciphertext, like the mailbox).
    let store = m.get("store").and_then(Value::as_bool) == Some(true) && app.cfg.file_queue > 0;
    let mut missed: Vec<Value> = Vec::new();
    for d in to {
        let d = d.as_str().ok_or(ApiError::new(400, "bad_field"))?;
        let delivered = d != me.device
            && (app.hub.to_device(d, Push::Text(push.clone()))
                || (store && queue_chunk(app, me, d, data)?));
        if !delivered {
            missed.push(d.into());
        }
    }
    if missed.is_empty() {
        return Ok(None);
    }
    let mut f = Map::new()
        .with("t", "relay-missed")
        .with("devices", Value::Array(missed));
    if let Some(r) = m.get("ref").and_then(Value::as_str)
        && r.len() <= 64
    {
        f.insert("ref", r.into());
    }
    Ok(Some(frame(f)))
}

fn queue_chunk(app: &App, me: &Authed, device: &str, data: &str) -> Result<bool, ApiError> {
    app.db
        .relay_enqueue(
            device,
            &me.device,
            &me.account,
            data,
            now() + MAILBOX_TTL,
            &app.cfg.queue_limits(),
        )
        .map_err(ApiError::internal)
}

/// Which of the given devices have room for `bytes` more of queued chunks from this account (asked before a
/// transfer, so that a file is queued whole or not at all). The same budgets as [`queue_chunk`]; what is granted to
/// one device counts against the account's and the server's totals for the next.
fn relay_space(app: &App, me: &Authed, m: &Map) -> Result<Option<Message>, ApiError> {
    app.limits
        .check(format!("presence:{}", me.device), 120, 60)?;
    let devices = m
        .get("devices")
        .and_then(Value::as_array)
        .ok_or(ApiError::new(400, "bad_field"))?;
    let bytes = m
        .get("bytes")
        .and_then(Value::as_int)
        .filter(|b| *b >= 0)
        .ok_or(ApiError::new(400, "bad_field"))?;
    if devices.len() > MAX_PRESENCE {
        return Err(ApiError::new(400, "bad_field"));
    }
    let limits = app.cfg.queue_limits();
    let mut ok: Vec<Value> = Vec::new();
    let mut granted = 0i64;
    if app.cfg.file_queue > 0 {
        for d in devices.iter().filter_map(Value::as_str) {
            if d == me.device || ok.iter().any(|o| o.as_str() == Some(d)) {
                continue;
            }
            let Some(mut u) = app
                .db
                .relay_usage(d, &me.account)
                .map_err(ApiError::internal)?
            else {
                continue;
            };
            u.account = u.account.saturating_add(granted);
            u.total = u.total.saturating_add(granted);
            if u.room(&limits) >= bytes {
                granted = granted.saturating_add(bytes);
                ok.push(d.into());
            }
        }
    }
    let mut f = Map::new()
        .with("t", "relay-space")
        .with("ok", Value::Array(ok));
    if let Some(r) = m.get("ref").and_then(Value::as_str)
        && r.len() <= 64
    {
        f.insert("ref", r.into());
    }
    Ok(Some(frame(f)))
}

fn relay_ack(app: &App, me: &Authed, m: &Map) -> Result<Option<Message>, ApiError> {
    let ids = m
        .get("ids")
        .and_then(Value::as_array)
        .ok_or(ApiError::new(400, "bad_field"))?;
    if ids.len() > 4096 {
        return Err(ApiError::new(400, "bad_field"));
    }
    let ids: Vec<i64> = ids.iter().filter_map(Value::as_int).collect();
    app.db
        .relay_ack(&me.device, &ids)
        .map_err(ApiError::internal)?;
    Ok(None)
}

/// Set (`endpoint`) or remove (no `endpoint`) where this device is woken by push.
fn push_sub(app: &App, me: &Authed, m: &Map) -> Result<Option<Message>, ApiError> {
    app.limits.check(format!("push:{}", me.device), 20, 3600)?;
    let endpoint = m.get("endpoint").and_then(Value::as_str);
    if let Some(e) = endpoint {
        app.push.check_endpoint(e)?;
    }
    app.db
        .set_push_sub(&me.device, endpoint)
        .map_err(ApiError::internal)?;
    let mut f = Map::new().with("t", "ok");
    if let Some(r) = m.get("ref").and_then(Value::as_str)
        && r.len() <= 64
    {
        f.insert("ref", r.into());
    }
    Ok(Some(frame(f)))
}

/// Which of the given devices are connected now (to decide where a file transfer goes).
/// When the account's own devices were last connected: `{ device: seconds }`, `0` for connected now. Only for the
/// account's own devices: the server does not tell others when someone was around.
fn seen(app: &App, me: &Authed, m: &Map) -> Result<Option<Message>, ApiError> {
    app.limits.check(format!("seen:{}", me.device), 30, 60)?;
    let cur = app.current(&me.account)?;
    let mut devices = Map::new();
    for d in cur.list.iter().flat_map(|l| &l.present) {
        let t = if app.hub.is_connected(&d.id) {
            Some(0)
        } else {
            app.db.seen(&d.id).map_err(ApiError::internal)?
        };
        if let Some(t) = t {
            devices.insert(d.id.as_str(), t.into());
        }
    }
    let mut f = Map::new()
        .with("t", "seen")
        .with("devices", Value::Object(devices));
    if let Some(r) = m.get("ref").and_then(Value::as_str)
        && r.len() <= 64
    {
        f.insert("ref", r.into());
    }
    Ok(Some(frame(f)))
}

fn presence(app: &App, me: &Authed, m: &Map) -> Result<Option<Message>, ApiError> {
    app.limits
        .check(format!("presence:{}", me.device), 120, 60)?;
    let devices = m
        .get("devices")
        .and_then(Value::as_array)
        .ok_or(ApiError::new(400, "bad_field"))?;
    if devices.len() > MAX_PRESENCE {
        return Err(ApiError::new(400, "bad_field"));
    }
    let online: Vec<Value> = devices
        .iter()
        .filter_map(Value::as_str)
        .filter(|d| *d != me.device && app.hub.is_connected(d))
        .map(Value::from)
        .collect();
    let mut f = Map::new()
        .with("t", "presence")
        .with("online", Value::Array(online));
    if let Some(r) = m.get("ref").and_then(Value::as_str)
        && r.len() <= 64
    {
        f.insert("ref", r.into());
    }
    Ok(Some(frame(f)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Config;

    fn app() -> Arc<App> {
        let cfg = Config {
            origin: "http://127.0.0.1:8080".into(),
            old_origins: Vec::new(),
            bind: String::new(),
            db: ":memory:".into(),
            key_file: String::new(),
            client_dir: String::new(),
            realm: "global".into(),
            realms: vec!["global".into()],
            remote_homes: Vec::new(),
            any_home: false,
            trust_proxy: Vec::new(),
            limit_scale: 1,
            file_queue: 0,
            file_queue_total: 0,
            file_queue_sender: 0,
            file_queue_account: 0,
            push_hosts: Vec::new(),
            giphy_key: String::new(),
            giphy_rating: "pg-13".into(),
            push_contact: String::new(),
        };
        let db = crate::db::Db::open(":memory:").expect("database");
        crate::build(&cfg, db, [3; 32]).expect("app")
    }

    fn me(account: &str, device: &str) -> Authed {
        Authed {
            account: account.into(),
            device: device.into(),
        }
    }

    fn relay_to(app: &Arc<App>, me: &Authed, to: &[&str], len: usize) -> Map {
        let f = Map::new()
            .with("t", "relay")
            .with(
                "to",
                Value::Array(to.iter().map(|d| Value::from(*d)).collect()),
            )
            .with("data", "a".repeat(len).as_str())
            .with("ref", "r");
        match handle(app, me, &f) {
            Some(Message::Text(t)) => match parse_limited(t.as_bytes(), MAX_FRAME) {
                Ok(Value::Object(m)) => m,
                _ => panic!("not an object"),
            },
            _ => panic!("no reply"),
        }
    }

    fn is_limited(m: &Map) -> bool {
        m.get("error").and_then(Value::as_str) == Some("rate_limited")
            && m.get("id").and_then(Value::as_str) == Some("r")
            && m.get("retry")
                .and_then(Value::as_int)
                .is_some_and(|s| (1..=60).contains(&s))
    }

    #[test]
    fn relay_bytes_per_recipient() {
        let app = app();
        let a = me("A", "a1");
        // Full chunks into one device: the per-recipient budget ends it long before the frame limit.
        let per = RELAY_PEER_BYTES as usize / MAX_RELAY;
        for _ in 0..per {
            assert_eq!(
                relay_to(&app, &a, &["b1"], MAX_RELAY)
                    .get("t")
                    .and_then(Value::as_str),
                Some("relay-missed")
            );
        }
        assert!(is_limited(&relay_to(&app, &a, &["b1"], MAX_RELAY)));
        // Another device of the same account shares that budget; another recipient has its own.
        assert!(is_limited(&relay_to(
            &app,
            &me("A", "a2"),
            &["b1"],
            MAX_RELAY
        )));
        assert!(!is_limited(&relay_to(&app, &a, &["b2"], MAX_RELAY)));
        // A refused frame counts nothing: b2 got only what passed.
        assert!(is_limited(&relay_to(&app, &a, &["b1", "b3"], MAX_RELAY)));
        assert!(!is_limited(&relay_to(&app, &a, &["b3"], MAX_RELAY)));
        // Other accounts are not affected.
        assert!(!is_limited(&relay_to(
            &app,
            &me("C", "c1"),
            &["b1"],
            MAX_RELAY
        )));
    }

    #[test]
    fn relay_bytes_per_sender() {
        let app = app();
        let a = me("A", "a1");
        let to: Vec<String> = (0..MAX_RECIPIENTS).map(|i| format!("d{i}")).collect();
        let to: Vec<&str> = to.iter().map(String::as_str).collect();
        // Fan-out counts once per recipient (duplicates and the sender itself not at all).
        let per = RELAY_BYTES as usize / (MAX_RELAY * to.len());
        for _ in 0..per {
            assert!(!is_limited(&relay_to(&app, &a, &to, MAX_RELAY)));
        }
        assert!(is_limited(&relay_to(&app, &a, &to, MAX_RELAY)));
        // Small frames still fit in what is left.
        assert!(!is_limited(&relay_to(&app, &a, &["x", "x", "a1"], 1000)));
    }
}
