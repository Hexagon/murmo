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
    if let Some(o) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        && o != app.cfg.origin
    {
        return ApiError::new(403, "bad_origin").into_response();
    }
    if let Err(e) = app.limits.by_addr("ws", addr, 60, 60) {
        return e.into_response();
    }
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| async move {
            let _ = run(app, socket).await;
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

async fn authenticate(app: &Arc<App>, socket: &mut WebSocket) -> Option<Authed> {
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
    if verify_ws_auth(dev, &account, &nonce, &app.cfg.origin, sig).is_err() {
        let _ = socket.send(error("bad_signature")).await;
        return None;
    }
    Some(Authed { account, device })
}

async fn run(app: Arc<App>, mut socket: WebSocket) -> Result<(), axum::Error> {
    let Some(me) = authenticate(&app, &mut socket).await else {
        let _ = socket.send(Message::Close(None)).await;
        return Ok(());
    };
    let (tx, mut rx) = mpsc::channel::<Push>(PUSH_QUEUE);
    let conn = app.hub.register(&me.device, &me.account, tx);
    let result = session(&app, &me, &mut socket, &mut rx).await;
    app.hub.unregister(&me.device, conn);
    result
}

async fn session(
    app: &Arc<App>,
    me: &Authed,
    socket: &mut WebSocket,
    rx: &mut mpsc::Receiver<Push>,
) -> Result<(), axum::Error> {
    socket.send(frame(Map::new().with("t", "ready"))).await?;
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
                    let reply = match parse_limited(t.as_bytes(), MAX_FRAME) {
                        Ok(Value::Object(m)) => handle(app, me, &m),
                        _ => Some(error("bad_json")),
                    };
                    if let Some(r) = reply {
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
        Some("push-sub") => push_sub(app, me, m),
        Some("ping") => Ok(Some(frame(Map::new().with("t", "pong")))),
        _ => Err(ApiError::new(400, "bad_frame")),
    };
    match r {
        Ok(msg) => msg,
        Err(e) => {
            let mut f = Map::new().with("t", "error").with("error", e.code);
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
    if !app.db.device_known(device).map_err(ApiError::internal)?
        || app.db.relay_bytes(None).map_err(ApiError::internal)? + data.len() as i64
            > app.cfg.file_queue_total
    {
        return Ok(false);
    }
    app.db
        .relay_enqueue(
            device,
            &me.device,
            &me.account,
            data,
            now() + MAILBOX_TTL,
            app.cfg.file_queue,
        )
        .map_err(ApiError::internal)
}

/// Which of the given devices have room for `bytes` more of queued chunks (asked before a transfer, so that a file
/// is queued whole or not at all).
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
    let mut ok: Vec<Value> = Vec::new();
    if app.cfg.file_queue > 0 {
        let mut total = app.db.relay_bytes(None).map_err(ApiError::internal)?;
        for d in devices.iter().filter_map(Value::as_str) {
            if d == me.device || !app.db.device_known(d).map_err(ApiError::internal)? {
                continue;
            }
            let used = app.db.relay_bytes(Some(d)).map_err(ApiError::internal)?;
            if used.saturating_add(bytes) <= app.cfg.file_queue
                && total.saturating_add(bytes) <= app.cfg.file_queue_total
            {
                total = total.saturating_add(bytes);
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
