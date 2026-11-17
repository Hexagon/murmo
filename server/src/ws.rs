//! `/api/v1/ws`: the authenticated mailbox (DESIGN.md §10). A device proves itself by signing a fresh challenge; then
//! it receives queued envelopes, pushes and link requests, and can send, acknowledge and publish prekeys.

use crate::app::{App, PUSH_QUEUE, Push, now, random, text};
use crate::db::{ChunkData, QueuedData};
use crate::devices::{verify_prekey, verify_ws_auth};
use crate::error::ApiError;
use crate::federation::Outgoing;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use rootcard::encoding::base64url_encode;
use rootcard::json::{Map, Value, parse_limited};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// Largest envelope (base64url text).
pub const MAX_ENVELOPE: usize = 96 * 1024;
/// Most recipients per send.
pub const MAX_RECIPIENTS: usize = 24;
/// Most queued envelopes per device.
pub const MAX_QUEUE: i64 = 2000;
/// Most envelopes one account of this server may have waiting in a device of another account that wrote to it
/// within [`WRITES_TTL`] (a contact), and in one of an account that did not (anybody else, such as a message request).
/// The account's own devices have no share but the whole mailbox.
pub const SHARE_CONTACT: i64 = 500;
pub const SHARE_STRANGER: i64 = 50;
/// The same for all accounts of another server together (federation), which this server cannot tell apart: contact
/// when the device's account wrote to someone on that server.
pub const SHARE_SERVER: i64 = 1000;
pub const SHARE_SERVER_STRANGER: i64 = 200;
/// How long it counts that an account wrote to another (seconds, 90 days).
pub const WRITES_TTL: i64 = 90 * 24 * 3600;

/// The share of `device`'s mailbox for envelopes from `sender`: an account of this server (`account:<id>`) or another
/// server (`server:<origin>`). `None` for the device's own account, which may use the whole mailbox. Whether the
/// sender is a contact is whether the device's account wrote to it (see [`note_writes`]).
pub fn share_for(
    app: &App,
    owner: &str,
    sender: Sender<'_>,
    now: i64,
) -> Result<Option<crate::db::Share>, ApiError> {
    let (key, wrote_to, contact, stranger) = match sender {
        Sender::Account(a) if a == owner => return Ok(None),
        Sender::Account(a) => (
            format!("account:{a}"),
            a.to_string(),
            SHARE_CONTACT,
            SHARE_STRANGER,
        ),
        Sender::Server(o) => (
            format!("server:{o}"),
            format!("@{o}"),
            SHARE_SERVER,
            SHARE_SERVER_STRANGER,
        ),
    };
    let pair = app.limits.tag(&format!("writes:{owner}>{wrote_to}"));
    let known = app.db.wrote(&pair, now).map_err(ApiError::internal)?;
    Ok(Some(crate::db::Share {
        sender: app.limits.tag(&key),
        max: if known { contact } else { stranger },
    }))
}

/// Who sent an envelope, for its share of a mailbox.
#[derive(Clone, Copy)]
pub enum Sender<'a> {
    /// An account of this server.
    Account(&'a str),
    /// Another server (federation), by its origin.
    Server(&'a str),
}

/// Remember that `account` wrote to each of `to` (accounts of this server, or `@<origin>` for another server): from
/// then on they count it as a contact for [`WRITES_TTL`]. Kept as keyed hashes only.
fn note_writes<'a>(app: &App, account: &str, to: impl IntoIterator<Item = &'a str>, now: i64) {
    let mut seen: Vec<&str> = Vec::new();
    for t in to {
        if seen.contains(&t) || t == account {
            continue;
        }
        seen.push(t);
        let pair = app.limits.tag(&format!("writes:{account}>{t}"));
        let _ = app.db.note_write(&pair, now + WRITES_TTL);
    }
}
/// Mailbox lifetime in seconds (14 days).
pub const MAILBOX_TTL: i64 = 14 * 24 * 3600;
/// Largest relay payload (base64url text): one file chunk.
pub const MAX_RELAY: usize = 96 * 1024;
/// Largest payload of a binary relay frame: one file chunk with its id and indices (DESIGN.md §10.2).
pub const MAX_RELAY_BIN: usize = 64 * 1024;
/// Live relay budget per sending device and minute, in bytes of chunks (text, or the payload of binary frames)
/// counted once per connected recipient device without a grant.
pub const RELAY_BYTES: u32 = 384 << 20;
/// Live relay budget per sending account and recipient device and minute: what one account can push into one
/// connected device that did not ask for it, whichever of the account's devices sends.
pub const RELAY_PEER_BYTES: u32 = 96 << 20;
/// Default budget per sending device and minute for chunks to devices that granted it more (`relay-grant`): the
/// recipient asked for the file, so this is not flooding; it bounds the server's bandwidth (`MURMO_RELAY_GRANTED_MB`).
pub const RELAY_GRANTED_BYTES: u32 = 1 << 30;
/// Default budget per sending account and minute for chunks put into the file queue (`MURMO_RELAY_STORE_MB`).
pub const RELAY_STORE_BYTES: u32 = 128 << 20;
/// Relay frames per device and minute, of any kind.
pub const RELAY_FRAMES: u32 = 24_000;
/// Relay frames per device and minute that go anywhere but to devices that granted more (live without a grant, or
/// queued).
pub const RELAY_SLOW_FRAMES: u32 = 3_000;
/// Relay budget per sending device and minute for chunks to devices on other servers (federation), which then
/// apply their own limits too (announced in their `/api/v1/info`).
pub const RELAY_REMOTE_BYTES: u32 = 256 << 20;
/// Largest grant: a whole file of `MAX_FILE` (1 GiB) as text chunks, with room to spare.
pub const MAX_GRANT: i64 = 2 << 30;
/// How long a grant lasts, in seconds.
pub const GRANT_TTL: i64 = 30 * 60;
/// Binary frame types (DESIGN.md §10.2).
pub const BIN_RELAY: u8 = 0x01;
/// A binary chunk from the server to a device.
pub const BIN_DELIVER: u8 = 0x02;
/// Most devices per presence query.
pub const MAX_PRESENCE: usize = 32;
/// Largest frame accepted from a client.
pub const MAX_FRAME: usize = 3 * 1024 * 1024;
/// How often the server pings a connected device.
pub const PING_EVERY: Duration = Duration::from_secs(30);
/// Pings in a row that may go unanswered before the connection is taken for dead and closed.
pub const MISSED_PONGS: u32 = 2;

/// Whether the other end of a connection is still there: every ping must be followed by something from it (a pong, or
/// any other frame) before too many pings have gone by. A half-open socket (a phone that lost its network without
/// closing) would otherwise stay registered: presence would say it is connected, and pushes and live chunks would go
/// to it instead of the mailbox and the file queue.
#[derive(Default)]
struct Liveness {
    unanswered: u32,
}

impl Liveness {
    /// Something came from the device.
    fn heard(&mut self) {
        self.unanswered = 0;
    }

    /// Time for a ping: false when the last `MISSED_PONGS` went unanswered and the connection should be closed.
    fn ping(&mut self) -> bool {
        if self.unanswered >= MISSED_PONGS {
            return false;
        }
        self.unanswered += 1;
        true
    }
}

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
    /// It takes binary relay frames (`caps: ["bin"]` in `auth`).
    binary: bool,
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
    let binary = m
        .get("caps")
        .and_then(Value::as_array)
        .is_some_and(|c| c.iter().any(|x| x.as_str() == Some("bin")));
    Some(Authed {
        account,
        device,
        binary,
    })
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
    let conn = app.hub.register(&me.device, &me.account, me.binary, tx);
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
                    .with(
                        "granted",
                        i64::from(app.limits.budget(app.cfg.relay_granted)),
                    )
                    .with("store", i64::from(app.limits.budget(app.cfg.relay_store)))
                    .with("remote", i64::from(app.limits.budget(RELAY_REMOTE_BYTES)))
                    .with("frames", i64::from(app.limits.budget(RELAY_FRAMES)))
                    .with(
                        "slow_frames",
                        i64::from(app.limits.budget(RELAY_SLOW_FRAMES)),
                    )
                    .with(
                        "grant",
                        if app.cfg.relay_granted > 0 {
                            MAX_GRANT
                        } else {
                            0
                        },
                    )
                    .with("binary", 1i64)
                    .with("window", 60i64),
            ),
        ))
        .await?;
    // Queued envelopes, then pending link requests.
    let mut after = 0i64;
    loop {
        let batch = app
            .db
            .queued(&me.device, after, 200, now())
            .map_err(axum::Error::new)?;
        if batch.is_empty() {
            break;
        }
        for (id, env, origin) in batch {
            after = id;
            let mut m = Map::new().with("t", "msg").with("id", id).with("env", env);
            if let Some(o) = origin {
                // From a device on another server (federation): the client looks the sender up there.
                m.insert("server", o.into());
            }
            socket.send(frame(m)).await?;
        }
    }
    for r in app.links.pending(&me.account) {
        socket
            .send(frame(Map::new().with("t", "link").with("request", r.value)))
            .await?;
    }
    let mut ping = tokio::time::interval(PING_EVERY);
    // The first tick is at once; the device has just authenticated, so it starts from there.
    ping.tick().await;
    let mut alive = Liveness::default();
    // File chunks queued while this device was away follow, a few at a time between other frames.
    let mut relay_after = 0i64;
    let mut relay_more = true;
    loop {
        tokio::select! {
            biased;
            push = rx.recv() => match push {
                Some(Push::Text(t)) => socket.send(Message::Text(t.into())).await?,
                Some(Push::Binary(b)) => socket.send(Message::Binary(b)).await?,
                None => {
                    let _ = socket.send(Message::Close(None)).await;
                    return Ok(());
                }
            },
            incoming = socket.recv() => {
                if let Some(Ok(_)) = &incoming {
                    alive.heard();
                }
                match incoming {
                    Some(Ok(Message::Text(t))) => {
                        if let Some(r) = text_frame(app, me, t.as_bytes()).resolve().await {
                            socket.send(r).await?;
                        }
                    }
                    Some(Ok(Message::Binary(b))) => {
                        if let Some(r) = binary_frame(app, me, &b).resolve().await {
                            socket.send(r).await?;
                        }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    _ => return Ok(()),
                }
            }
            _ = ping.tick() => {
                if !alive.ping() {
                    // Nothing came back: a half-open connection. Closing it unregisters the device.
                    let _ = socket.send(Message::Close(None)).await;
                    return Ok(());
                }
                socket.send(Message::Ping(Vec::new().into())).await?;
            }
            _ = std::future::ready(()), if relay_more => {
                let batch = app
                    .db
                    .relay_queued(&me.device, relay_after, 4)
                    .map_err(axum::Error::new)?;
                relay_more = !batch.is_empty();
                for q in batch {
                    relay_after = q.id;
                    let out = match q.data {
                        QueuedData::Text(data) => frame(
                            Map::new()
                                .with("t", "relay")
                                .with("id", q.id)
                                .with("from", q.sender)
                                .with("account", q.account)
                                .with("data", data),
                        ),
                        // A connection that cannot read it does not get it; it stays queued until it expires.
                        QueuedData::Binary(_) if !me.binary => continue,
                        QueuedData::Binary(data) => match deliver_frame(&q.sender, &q.account, q.id, &data) {
                            Some(b) => Message::Binary(b),
                            None => continue,
                        },
                    };
                    socket.send(out).await?;
                }
            }
        }
    }
}

/// The reply to a text frame from an authenticated device, if any.
/// The answer to a frame: now, or once another server has answered (federation). The connection waits for it
/// before it reads the next frame, so answers keep their order.
pub enum Reply {
    Now(Option<Message>),
    Later(futures_util::future::BoxFuture<'static, Option<Message>>),
}

impl From<Option<Message>> for Reply {
    fn from(m: Option<Message>) -> Reply {
        Reply::Now(m)
    }
}

impl Reply {
    async fn resolve(self) -> Option<Message> {
        match self {
            Reply::Now(m) => m,
            Reply::Later(f) => f.await,
        }
    }

    /// The answer when it is there already (tests and fuzzing, where no other server is asked).
    fn now(self) -> Option<Message> {
        match self {
            Reply::Now(m) => m,
            Reply::Later(_) => None,
        }
    }
}

fn text_frame(app: &Arc<App>, me: &Authed, text: &[u8]) -> Reply {
    match parse_limited(text, MAX_FRAME) {
        Ok(Value::Object(m)) => handle(app, me, &m),
        _ => Reply::Now(Some(error("bad_json"))),
    }
}

/// [`text_frame`] for the fuzz targets: the reply as text.
#[doc(hidden)]
pub fn fuzz_frame(app: &Arc<App>, account: &str, device: &str, text: &[u8]) -> Option<String> {
    let me = Authed {
        account: account.to_string(),
        device: device.to_string(),
        binary: true,
    };
    match text_frame(app, &me, text).now()? {
        Message::Text(t) => Some(t.to_string()),
        _ => None,
    }
}

fn handle(app: &Arc<App>, me: &Authed, m: &Map) -> Reply {
    let r = match m.get("t").and_then(Value::as_str) {
        Some("send") => send(app, me, m).map(Reply::Now),
        Some("ack") => ack(app, me, m).map(Reply::Now),
        Some("prekey") => prekey(app, me, m).map(Reply::Now),
        Some("link-decline") => {
            if let Some(id) = m.get("id").and_then(Value::as_str) {
                app.links.remove(&me.account, |r| r.id == id);
            }
            Ok(Reply::Now(None))
        }
        Some("relay") => relay(app, me, m),
        Some("relay-ack") => relay_ack(app, me, m).map(Reply::Now),
        Some("relay-space") => relay_space(app, me, m),
        Some("relay-grant") => relay_grant(app, me, m).map(Reply::Now),
        Some("presence") => presence(app, me, m),
        Some("remote-lookup" | "remote-devices") => remote(app, me, m).map(Reply::Now),
        Some("seen") => seen(app, me, m).map(Reply::Now),
        Some("push-sub") => push_sub(app, me, m).map(Reply::Now),
        Some("ping") => Ok(Reply::Now(Some(frame(Map::new().with("t", "pong"))))),
        _ => Err(ApiError::new(400, "bad_frame")),
    };
    match r {
        Ok(reply) => reply,
        Err(e) => {
            let id = m.get("id").and_then(Value::as_str).or_else(|| {
                m.get("ref")
                    .and_then(Value::as_str)
                    .filter(|r| r.len() <= 64)
            });
            Reply::Now(Some(error_reply(&e, id)))
        }
    }
}

/// `{ t: "error", error, retry?, id? }`.
fn error_reply(e: &ApiError, id: Option<&str>) -> Message {
    let mut f = Map::new().with("t", "error").with("error", e.code);
    if let Some(s) = e.retry_after {
        f.insert("retry", i64::try_from(s).unwrap_or(i64::MAX).into());
    }
    if let Some(id) = id {
        f.insert("id", id.into());
    }
    frame(f)
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
    // Every recipient is checked before anything is queued: a bad one fails the whole frame and nothing was sent, so
    // that a resend does not give the others a second copy. What can only fail for one device (unknown here, a full
    // mailbox, a server that does not take it) is reported for that device in `failed`.
    let now = now();
    let mut targets: Vec<(&Map, &str, &str, i64)> = Vec::with_capacity(to.len());
    for r in to {
        let o = r.as_object().ok_or(ApiError::new(400, "bad_field"))?;
        // An optional shorter lifetime for this envelope (disappearing messages): absent means the mailbox TTL.
        let ttl = match o.get("ttl") {
            None => MAILBOX_TTL,
            Some(v) => v
                .as_int()
                .filter(|t| *t > 0)
                .ok_or(ApiError::new(400, "bad_field"))?,
        };
        let device = o
            .get("device")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(400, "bad_field"))?;
        let env = o
            .get("env")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(400, "bad_field"))?;
        check_envelope(env)?;
        targets.push((o, device, env, ttl));
    }
    let mut failed: Vec<Value> = Vec::new();
    let mut remote: HashMap<String, Vec<Outgoing>> = HashMap::new();
    let mut wrote: Vec<String> = Vec::new();
    for (o, device, env, ttl) in targets {
        let expires = now + ttl.clamp(1, MAILBOX_TTL);
        // A device on another Murmo server (federation): handed to that server below.
        if let Some(server) = o.get("server").and_then(Value::as_str)
            && !app.is_origin(server)
        {
            if device.len() > 64 || !crate::federation::allowed(app, server) {
                failed.push(device.into());
            } else {
                app.fed.learn(&me.account, device, server);
                wrote.push(format!("@{server}"));
                remote
                    .entry(server.to_string())
                    .or_default()
                    .push(Outgoing {
                        device: device.to_string(),
                        env: env.to_string(),
                        expires,
                        notify: o.get("notify").and_then(Value::as_bool) == Some(true),
                    });
            }
            continue;
        }
        let Some(owner) = app.db.device_owner(device).map_err(ApiError::internal)? else {
            failed.push(device.into());
            continue;
        };
        let share = share_for(app, &owner, Sender::Account(&me.account), now)?;
        wrote.push(owner);
        match app
            .db
            .enqueue(device, env, expires, MAX_QUEUE, None, share.as_ref())
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
    note_writes(app, &me.account, wrote.iter().map(String::as_str), now);
    if remote.is_empty() {
        return Ok(Some(frame(
            Map::new()
                .with("t", "sent")
                .with("id", id)
                .with("failed", Value::Array(failed)),
        )));
    }
    // Envelopes for other servers go there first, to all of them at once; `sent` follows when they have answered.
    // `queued`: devices on servers that could not be reached now, whose envelopes this server keeps trying.
    let (app, device, id) = (app.clone(), me.device.clone(), id.to_string());
    tokio::spawn(async move {
        let answers = futures_util::future::join_all(remote.into_iter().map(|(server, msgs)| {
            let app = app.clone();
            async move { crate::federation::deliver(&app, &server, msgs).await }
        }))
        .await;
        let mut queued: Vec<Value> = Vec::new();
        for a in answers {
            failed.extend(a.failed.into_iter().map(Value::from));
            queued.extend(a.queued.into_iter().map(Value::from));
        }
        let sent = Map::new()
            .with("t", "sent")
            .with("id", id)
            .with("failed", Value::Array(failed))
            .with("queued", Value::Array(queued));
        app.hub.to_device(&device, Push::Text(text(&sent.into())));
    });
    Ok(None)
}

/// `{ t: "remote-lookup", server, handle, ref }` or `{ t: "remote-devices", server, account, fresh?, ref }`: this server
/// asks another one for one of its own users (federation, DESIGN.md §14.2). Answered `{ t: "remote", ref, value }`
/// when the other server has answered, or with an error. Only devices of accounts on this server can ask, so the
/// server is never a proxy for anyone else.
fn remote(app: &Arc<App>, me: &Authed, m: &Map) -> Result<Option<Message>, ApiError> {
    let r = m
        .get("ref")
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty() && r.len() <= 64)
        .ok_or(ApiError::new(400, "bad_field"))?
        .to_string();
    let field = |k: &str| {
        m.get(k)
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 256)
            .map(str::to_string)
            .ok_or(ApiError::new(400, "bad_field"))
    };
    let server = field("server")?;
    let lookup = m.get("t").and_then(Value::as_str) == Some("remote-lookup");
    let (what, arg) = if lookup {
        app.limits
            .check(format!("remote-lookup:{}", me.device), 20, 60)?;
        ("lookup", field("handle")?)
    } else {
        app.limits
            .check(format!("remote-devices:{}", me.device), 240, 60)?;
        ("devices", field("account")?)
    };
    let fresh = m.get("fresh").and_then(Value::as_bool) == Some(true);
    let (app, device, account) = (app.clone(), me.device.clone(), me.account.clone());
    tokio::spawn(async move {
        let answer = if what == "lookup" {
            crate::federation::lookup(&app, &account, &server, &arg).await
        } else {
            crate::federation::devices(&app, &account, &server, &arg, fresh).await
        };
        if let Ok(v) = &answer
            && what == "devices"
        {
            // Where the contact's devices are, for this account's file chunks and presence questions.
            crate::federation::learn_list(&app, &account, v);
        }
        let reply = match answer {
            Ok(value) => text(
                &Map::new()
                    .with("t", "remote")
                    .with("ref", r.as_str())
                    .with("value", value)
                    .into(),
            ),
            Err(e) => match error_reply(&e, Some(&r)) {
                Message::Text(t) => t.to_string(),
                _ => return,
            },
        };
        app.hub.to_device(&device, Push::Text(reply));
    });
    Ok(None)
}

/// An envelope as sent: base64url text of at most `MAX_ENVELOPE` bytes.
pub fn check_envelope(env: &str) -> Result<(), ApiError> {
    if env.len() > MAX_ENVELOPE
        || !env
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError::new(400, "bad_envelope"));
    }
    Ok(())
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

/// A relay request, from a JSON `relay` frame or a binary frame.
struct RelayReq<'a> {
    /// Recipient devices, without duplicates.
    to: Vec<String>,
    /// Keep the chunk for devices that are not connected.
    store: bool,
    /// How long a queued chunk is kept (seconds), when given.
    ttl: Option<i64>,
    /// Echoed in `relay-missed` and `error`.
    reference: Option<String>,
    data: ChunkData<'a>,
}

/// Where one chunk goes for one recipient device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    /// Connected, no grant: the live budgets.
    Live,
    /// Connected, and it granted the sender more.
    Granted,
    /// Not connected: into the file queue.
    Stored,
    /// Connected, but it does not take binary frames.
    NoBinary,
    /// On another server (federation): handed to it.
    Remote,
    /// Not delivered.
    Missed,
}

pub fn is_b64url(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A JSON `relay` frame: `{ t: "relay", to, data, ref?, store?, ttl? }`.
fn relay(app: &Arc<App>, me: &Authed, m: &Map) -> Result<Reply, ApiError> {
    app.limits
        .check(format!("relay:{}", me.device), RELAY_FRAMES, 60)?;
    let data = m
        .get("data")
        .and_then(Value::as_str)
        .ok_or(ApiError::new(400, "bad_field"))?;
    if data.len() > MAX_RELAY || !is_b64url(data) {
        return Err(ApiError::new(400, "bad_relay"));
    }
    let to = m
        .get("to")
        .and_then(Value::as_array)
        .ok_or(ApiError::new(400, "bad_field"))?;
    if to.is_empty() || to.len() > MAX_RECIPIENTS {
        return Err(ApiError::new(400, "bad_field"));
    }
    let mut devices: Vec<String> = Vec::with_capacity(to.len());
    for d in to {
        let d = d.as_str().ok_or(ApiError::new(400, "bad_field"))?;
        if !devices.iter().any(|x| x == d) {
            devices.push(d.to_string());
        }
    }
    let ttl = match m.get("ttl") {
        None => None,
        Some(v) => Some(
            v.as_int()
                .filter(|t| *t > 0)
                .ok_or(ApiError::new(400, "bad_field"))?,
        ),
    };
    let req = RelayReq {
        to: devices,
        store: m.get("store").and_then(Value::as_bool) == Some(true),
        ttl,
        reference: m
            .get("ref")
            .and_then(Value::as_str)
            .filter(|r| r.len() <= 64)
            .map(str::to_string),
        data: ChunkData::Text(data),
    };
    relay_req(app, me, &req)
}

/// Parse a binary relay frame (DESIGN.md §10.2). Fixed offsets, every bound checked; nothing is allocated beyond
/// the recipient list.
fn parse_binary(b: &[u8]) -> Result<RelayReq<'_>, ApiError> {
    let bad = || ApiError::new(400, "bad_relay");
    let (&kind, rest) = b.split_first().ok_or_else(bad)?;
    if kind != BIN_RELAY {
        return Err(bad());
    }
    let (&flags, rest) = rest.split_first().ok_or_else(bad)?;
    if flags & !1 != 0 {
        return Err(bad());
    }
    let (&k, rest) = rest.split_first().ok_or_else(bad)?;
    let k = usize::from(k);
    if k == 0 || k > MAX_RECIPIENTS {
        return Err(bad());
    }
    let (ids, rest) = rest.split_at_checked(16 * k).ok_or_else(bad)?;
    let (reference, rest) = rest.split_at_checked(8).ok_or_else(bad)?;
    let (ttl, payload) = rest.split_at_checked(4).ok_or_else(bad)?;
    if payload.is_empty() || payload.len() > MAX_RELAY_BIN {
        return Err(bad());
    }
    let mut to: Vec<String> = Vec::with_capacity(k);
    for id in ids.as_chunks::<16>().0 {
        let d = base64url_encode(id);
        if !to.contains(&d) {
            to.push(d);
        }
    }
    let ttl = u32::from_be_bytes(ttl.try_into().map_err(|_| bad())?);
    Ok(RelayReq {
        to,
        store: flags & 1 == 1,
        ttl: (ttl > 0).then_some(i64::from(ttl)),
        reference: Some(base64url_encode(reference)),
        data: ChunkData::Binary(payload),
    })
}

/// The reply to a binary frame from an authenticated device, if any.
fn binary_frame(app: &Arc<App>, me: &Authed, b: &[u8]) -> Reply {
    if let Err(e) = app
        .limits
        .check(format!("relay:{}", me.device), RELAY_FRAMES, 60)
    {
        return Reply::Now(Some(error_reply(&e, None)));
    }
    let req = match parse_binary(b) {
        Ok(r) => r,
        Err(e) => return Reply::Now(Some(error_reply(&e, None))),
    };
    match relay_req(app, me, &req) {
        Ok(r) => r,
        Err(e) => Reply::Now(Some(error_reply(&e, req.reference.as_deref()))),
    }
}

/// [`binary_frame`] for the fuzz targets: the reply as text.
#[doc(hidden)]
pub fn fuzz_binary(app: &Arc<App>, account: &str, device: &str, b: &[u8]) -> Option<String> {
    let me = Authed {
        account: account.to_string(),
        device: device.to_string(),
        binary: true,
    };
    match binary_frame(app, &me, b).now()? {
        Message::Text(t) => Some(t.to_string()),
        _ => None,
    }
}

/// The binary frame a device receives: type, the sending device (16 bytes), the sending account (length, then the
/// id), the queue id (8 bytes, 0 when live), then the payload as it was sent. `None` for ids that do not fit.
pub fn deliver_frame(
    device: &str,
    account: &str,
    id: i64,
    payload: &[u8],
) -> Option<axum::body::Bytes> {
    let from = rootcard::encoding::base64url_decode(device).ok()?;
    let len = u8::try_from(account.len()).ok()?;
    if from.len() != 16 {
        return None;
    }
    let mut out = Vec::with_capacity(2 + 16 + account.len() + 8 + payload.len());
    out.push(BIN_DELIVER);
    out.extend_from_slice(&from);
    out.push(len);
    out.extend_from_slice(account.as_bytes());
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(payload);
    Some(out.into())
}

/// Forward a chunk to the connected recipients and, with `store`, queue it for the others. Each route has its own
/// budget, charged all or nothing before anything is forwarded:
/// - live to a connected device: per sending device (once per recipient) and per sending account into that device;
/// - to a device that granted this device more (`relay-grant`): per sending device, much larger, and the grant;
/// - into the file queue: per sending account.
fn relay_req(app: &Arc<App>, me: &Authed, req: &RelayReq<'_>) -> Result<Reply, ApiError> {
    let binary = matches!(req.data, ChunkData::Binary(_));
    let len = u32::try_from(req.data.len()).unwrap_or(u32::MAX);
    let store = req.store && app.cfg.file_queue > 0;
    let routes: Vec<Route> = req
        .to
        .iter()
        .map(|d| {
            if *d == me.device {
                return Route::Missed;
            }
            match app.hub.binary(d) {
                Some(false) if binary => Route::NoBinary,
                Some(_)
                    if app.cfg.relay_granted > 0
                        && app.hub.granted(d, &me.device) >= u64::from(len) =>
                {
                    Route::Granted
                }
                Some(_) => Route::Live,
                None if remote_of(app, me, d).is_some() => Route::Remote,
                None if store => Route::Stored,
                None => Route::Missed,
            }
        })
        .collect();
    let count =
        |r: Route| u32::try_from(routes.iter().filter(|x| **x == r).count()).unwrap_or(u32::MAX);
    let (live, granted, stored, remote) = (
        count(Route::Live),
        count(Route::Granted),
        count(Route::Stored),
        count(Route::Remote),
    );
    let mut budget: Vec<(String, u32, u32)> = Vec::with_capacity(req.to.len() + 5);
    if live + stored + remote > 0 {
        budget.push((format!("relay-slow:{}", me.device), 1, RELAY_SLOW_FRAMES));
    }
    if live > 0 {
        budget.push((
            format!("relay-bytes:{}", me.device),
            len.saturating_mul(live),
            RELAY_BYTES,
        ));
        for (d, _) in req
            .to
            .iter()
            .zip(&routes)
            .filter(|(_, r)| **r == Route::Live)
        {
            budget.push((
                format!("relay-to:{}>{d}", me.account),
                len,
                RELAY_PEER_BYTES,
            ));
        }
    }
    if granted > 0 {
        budget.push((
            format!("relay-granted:{}", me.device),
            len.saturating_mul(granted),
            app.cfg.relay_granted,
        ));
    }
    if stored > 0 {
        budget.push((
            format!("relay-store:{}", me.account),
            len.saturating_mul(stored),
            app.cfg.relay_store,
        ));
    }
    if remote > 0 {
        budget.push((
            format!("relay-remote:{}", me.device),
            len.saturating_mul(remote),
            RELAY_REMOTE_BYTES,
        ));
    }
    app.limits.charge(&budget, 60)?;
    let push = match req.data {
        ChunkData::Text(data) => Push::Text(text(
            &Map::new()
                .with("t", "relay")
                .with("from", me.device.as_str())
                .with("account", me.account.as_str())
                .with("data", data)
                .into(),
        )),
        ChunkData::Binary(payload) => Push::Binary(
            deliver_frame(&me.device, &me.account, 0, payload)
                .ok_or(ApiError::new(400, "bad_relay"))?,
        ),
    };
    // `store`: kept for devices that are not connected (ciphertext, like the mailbox), for `ttl` seconds when given
    // (disappearing pictures), never longer than the mailbox keeps a message.
    let expires = now() + req.ttl.unwrap_or(MAILBOX_TTL).clamp(1, MAILBOX_TTL);
    let mut missed: Vec<Value> = Vec::new();
    let mut no_binary: Vec<Value> = Vec::new();
    for (d, route) in req.to.iter().zip(&routes) {
        let delivered = match route {
            Route::Live | Route::Granted => {
                // A device that went away in between gets it queued, if it may be.
                let ok = app.hub.to_device(d, push.clone())
                    || (store && queue_chunk(app, me, d, req.data, expires)?);
                if ok && *route == Route::Granted {
                    app.hub.use_grant(d, &me.device, u64::from(len));
                }
                ok
            }
            Route::Stored => queue_chunk(app, me, d, req.data, expires)?,
            Route::NoBinary => {
                no_binary.push(d.as_str().into());
                false
            }
            Route::Remote => continue,
            Route::Missed => false,
        };
        if !delivered {
            missed.push(d.as_str().into());
        }
    }
    let reference = req.reference.clone();
    if remote == 0 {
        return Ok(Reply::Now(missed_frame(missed, no_binary, reference)));
    }
    // Devices on other servers: each server gets the chunk once, for all of its devices.
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for (d, route) in req.to.iter().zip(&routes) {
        if *route == Route::Remote
            && let Some(origin) = remote_of(app, me, d)
        {
            groups.entry(origin).or_default().push(d.clone());
        }
    }
    let (text_data, bin_data) = match req.data {
        ChunkData::Text(t) => (Some(t.to_string()), None),
        ChunkData::Binary(b) => (None, Some(b.to_vec())),
    };
    let (app, account, device, store, ttl) = (
        app.clone(),
        me.account.clone(),
        me.device.clone(),
        req.store,
        req.ttl,
    );
    Ok(Reply::Later(Box::pin(async move {
        for (origin, devices) in groups {
            let out = crate::federation::RelayOut {
                account: account.clone(),
                device: device.clone(),
                devices,
                store,
                ttl,
                text: text_data.clone(),
                binary: bin_data.clone(),
            };
            let (m, t) = crate::federation::relay(&app, &origin, out).await;
            missed.extend(m.into_iter().map(Value::from));
            no_binary.extend(t.into_iter().map(Value::from));
        }
        missed_frame(missed, no_binary, reference)
    })))
}

/// The server a device of a contact on another server is on, as this account told us (federation), if this server
/// still exchanges messages with it.
fn remote_of(app: &App, me: &Authed, device: &str) -> Option<String> {
    app.fed
        .route(&me.account, device)
        .filter(|o| crate::federation::allowed(app, o))
}

/// `relay-missed` for the devices that did not get a chunk, if any.
fn missed_frame(
    missed: Vec<Value>,
    no_binary: Vec<Value>,
    reference: Option<String>,
) -> Option<Message> {
    if missed.is_empty() {
        return None;
    }
    let mut f = Map::new()
        .with("t", "relay-missed")
        .with("devices", Value::Array(missed));
    if !no_binary.is_empty() {
        f.insert("text", Value::Array(no_binary));
    }
    if let Some(r) = &reference {
        f.insert("ref", r.as_str().into());
    }
    Some(frame(f))
}

/// Group the devices that are on other servers (as this account knows them) by server; the rest stay in `local`.
fn split_remote(
    app: &App,
    me: &Authed,
    devices: Vec<String>,
) -> (Vec<String>, HashMap<String, Vec<String>>) {
    let mut local = Vec::new();
    let mut remote: HashMap<String, Vec<String>> = HashMap::new();
    for d in devices {
        match remote_of(app, me, &d) {
            Some(o) if !app.hub.is_connected(&d) => remote.entry(o).or_default().push(d),
            _ => local.push(d),
        }
    }
    (local, remote)
}

/// A frame `{ t, <key>: [...], ref? }` as the answer to `presence` and `relay-space`.
fn list_frame(t: &str, key: &str, list: Vec<Value>, reference: Option<String>) -> Message {
    let mut f = Map::new().with("t", t).with(key, Value::Array(list));
    if let Some(r) = reference {
        f.insert("ref", r.into());
    }
    frame(f)
}

fn queue_chunk(
    app: &App,
    me: &Authed,
    device: &str,
    data: ChunkData<'_>,
    expires: i64,
) -> Result<bool, ApiError> {
    app.db
        .relay_enqueue(
            device,
            &me.device,
            &me.account,
            None,
            data,
            expires,
            &app.cfg.queue_limits(),
        )
        .map_err(ApiError::internal)
}

/// `{ t: "relay-grant", from, bytes, ref }`: this device lets `from` stream up to `bytes` more to it in the next
/// [`GRANT_TTL`] seconds, beyond the live budgets (it asked for a file). `bytes: 0` takes a grant back. The sending
/// device is told (`{ t: "relay-grant", to, bytes, ttl }`) when it is connected, so it can pace for it.
fn relay_grant(app: &App, me: &Authed, m: &Map) -> Result<Option<Message>, ApiError> {
    app.limits.check(format!("grant:{}", me.device), 120, 60)?;
    if app.cfg.relay_granted == 0 {
        return Err(ApiError::new(400, "no_grants"));
    }
    let from = m
        .get("from")
        .and_then(Value::as_str)
        .filter(|d| d.len() <= 64 && is_b64url(d) && *d != me.device)
        .ok_or(ApiError::new(400, "bad_field"))?;
    let bytes = m
        .get("bytes")
        .and_then(Value::as_int)
        .filter(|b| (0..=MAX_GRANT).contains(b))
        .ok_or(ApiError::new(400, "bad_field"))?;
    app.hub.grant(
        &me.device,
        from,
        u64::try_from(bytes).unwrap_or(0),
        now() + GRANT_TTL,
    );
    let note = Map::new()
        .with("t", "relay-grant")
        .with("to", me.device.as_str())
        .with("bytes", bytes)
        .with("ttl", GRANT_TTL);
    app.hub.to_device(from, Push::Text(text(&note.into())));
    let mut f = Map::new().with("t", "ok");
    if let Some(r) = m.get("ref").and_then(Value::as_str)
        && r.len() <= 64
    {
        f.insert("ref", r.into());
    }
    Ok(Some(frame(f)))
}

/// Which of the given devices have room for `bytes` more of queued chunks from this account (asked before a
/// transfer, so that a file is queued whole or not at all). The same budgets as [`queue_chunk`]; what is granted to
/// one device counts against the account's and the server's totals for the next.
fn relay_space(app: &Arc<App>, me: &Authed, m: &Map) -> Result<Reply, ApiError> {
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
    let devices: Vec<String> = devices
        .iter()
        .filter_map(Value::as_str)
        .filter(|d| *d != me.device)
        .map(str::to_string)
        .collect();
    let (local, remote) = split_remote(app, me, devices);
    let local: Vec<&str> = local.iter().map(String::as_str).collect();
    let mut ok: Vec<Value> = space_for(app, &me.account, None, &local, bytes)?
        .into_iter()
        .map(Value::from)
        .collect();
    let reference = m
        .get("ref")
        .and_then(Value::as_str)
        .filter(|r| r.len() <= 64)
        .map(str::to_string);
    if remote.is_empty() {
        return Ok(Reply::Now(Some(list_frame(
            "relay-space",
            "ok",
            ok,
            reference,
        ))));
    }
    // Devices on other servers: by their servers' own file limits.
    let (app, account) = (app.clone(), me.account.clone());
    Ok(Reply::Later(Box::pin(async move {
        for (origin, devices) in remote {
            let room = crate::federation::space(&app, &origin, &account, devices, bytes).await;
            ok.extend(room.into_iter().map(Value::from));
        }
        Some(list_frame("relay-space", "ok", ok, reference))
    })))
}

/// Which of `devices` (on this server) have room for `bytes` more of queued chunks from `account`; what is granted
/// to one device counts against the account's and the server's totals for the next. Also asked by other servers
/// for their accounts (federation).
pub fn space_for(
    app: &App,
    account: &str,
    origin: Option<&str>,
    devices: &[&str],
    bytes: i64,
) -> Result<Vec<String>, ApiError> {
    let limits = app.cfg.queue_limits();
    let mut ok: Vec<String> = Vec::new();
    let mut granted = 0i64;
    if app.cfg.file_queue == 0 {
        return Ok(ok);
    }
    for d in devices {
        if ok.iter().any(|o| o == d) {
            continue;
        }
        let Some(mut u) = app
            .db
            .relay_usage(d, account, origin)
            .map_err(ApiError::internal)?
        else {
            continue;
        };
        u.account = u.account.saturating_add(granted);
        u.total = u.total.saturating_add(granted);
        if u.room(&limits) >= bytes {
            granted = granted.saturating_add(bytes);
            ok.push((*d).to_string());
        }
    }
    Ok(ok)
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

fn presence(app: &Arc<App>, me: &Authed, m: &Map) -> Result<Reply, ApiError> {
    app.limits
        .check(format!("presence:{}", me.device), 120, 60)?;
    let devices = m
        .get("devices")
        .and_then(Value::as_array)
        .ok_or(ApiError::new(400, "bad_field"))?;
    if devices.len() > MAX_PRESENCE {
        return Err(ApiError::new(400, "bad_field"));
    }
    let devices: Vec<String> = devices
        .iter()
        .filter_map(Value::as_str)
        .filter(|d| *d != me.device)
        .map(str::to_string)
        .collect();
    let (local, remote) = split_remote(app, me, devices);
    let mut online: Vec<Value> = local
        .into_iter()
        .filter(|d| app.hub.is_connected(d))
        .map(Value::from)
        .collect();
    let reference = m
        .get("ref")
        .and_then(Value::as_str)
        .filter(|r| r.len() <= 64)
        .map(str::to_string);
    if remote.is_empty() {
        return Ok(Reply::Now(Some(list_frame(
            "presence", "online", online, reference,
        ))));
    }
    // Devices on other servers: asked there (a server that does not answer counts as nobody connected).
    let app = app.clone();
    Ok(Reply::Later(Box::pin(async move {
        for (origin, devices) in remote {
            let on = crate::federation::presence(&app, &origin, devices).await;
            online.extend(on.into_iter().map(Value::from));
        }
        Some(list_frame("presence", "online", online, reference))
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{Config, MAX_GRANTS};

    fn app() -> Arc<App> {
        app_with_queue(0)
    }

    /// A test server whose file queue keeps up to `bytes` per device (and per sender, account and in all).
    fn app_with_queue(bytes: i64) -> Arc<App> {
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
            file_queue: bytes,
            file_queue_total: bytes,
            file_queue_sender: bytes,
            file_queue_account: bytes,
            relay_granted: crate::ws::RELAY_GRANTED_BYTES,
            relay_store: crate::ws::RELAY_STORE_BYTES,
            push_hosts: Vec::new(),
            giphy_key: String::new(),
            giphy_rating: "pg-13".into(),
            beta: true,
            demo: false,
            federation: crate::federation::Policy::Off,
            federation_block: Vec::new(),
            push_contact: String::new(),
        };
        let db = crate::db::Db::open(":memory:").expect("database");
        crate::build(&cfg, db, [3; 32]).expect("app")
    }

    fn me(account: &str, device: &str) -> Authed {
        Authed {
            account: account.into(),
            device: device.into(),
            binary: true,
        }
    }

    /// Connect `device` of `account` to the hub; what it is pushed is collected (and drained, so it never falls
    /// behind) by a thread.
    fn connect(
        app: &Arc<App>,
        account: &str,
        device: &str,
        binary: bool,
    ) -> Arc<std::sync::Mutex<Vec<Push>>> {
        let (tx, mut rx) = mpsc::channel::<Push>(PUSH_QUEUE);
        app.hub.register(device, account, binary, tx);
        let got = Arc::new(std::sync::Mutex::new(Vec::new()));
        let keep = got.clone();
        std::thread::spawn(move || {
            while let Some(p) = rx.blocking_recv() {
                if let Ok(mut g) = keep.lock() {
                    // Keep the first few only: the tests look at their shape, not at all of them.
                    if g.len() < 8 {
                        g.push(p);
                    }
                }
            }
        });
        got
    }

    fn object(msg: impl Into<Reply>) -> Map {
        match msg.into().now() {
            Some(Message::Text(t)) => match parse_limited(t.as_bytes(), MAX_FRAME) {
                Ok(Value::Object(m)) => m,
                _ => panic!("not an object"),
            },
            None => Map::new(),
            _ => panic!("unexpected reply"),
        }
    }

    /// A JSON relay frame to `to`; the reply, or an empty map when there is none (everything delivered).
    fn relay_to(app: &Arc<App>, me: &Authed, to: &[&str], len: usize) -> Map {
        relay_with(app, me, to, len, false)
    }

    fn relay_with(app: &Arc<App>, me: &Authed, to: &[&str], len: usize, store: bool) -> Map {
        let mut f = Map::new()
            .with("t", "relay")
            .with(
                "to",
                Value::Array(to.iter().map(|d| Value::from(*d)).collect()),
            )
            .with("data", "a".repeat(len).as_str())
            .with("ref", "r");
        if store {
            f.insert("store", Value::Bool(true));
        }
        object(handle(app, me, &f))
    }

    fn is_limited(m: &Map) -> bool {
        m.get("error").and_then(Value::as_str) == Some("rate_limited")
            && m.get("id").and_then(Value::as_str) == Some("r")
            && m.get("retry")
                .and_then(Value::as_int)
                .is_some_and(|s| (1..=60).contains(&s))
    }

    #[test]
    fn remote_lookups_share_the_other_servers_budget_fairly() {
        use crate::federation::{LOOKUPS_PER_ACCOUNT, LOOKUPS_TO_SERVER, asking};
        let app = app();
        let ask = |me: &str, server: &str| {
            asking(
                &app,
                "lookup",
                me,
                server,
                LOOKUPS_PER_ACCOUNT,
                LOOKUPS_TO_SERVER,
            )
        };
        // One account gets its part, not the server's whole budget at the other server.
        for _ in 0..LOOKUPS_PER_ACCOUNT {
            assert!(ask("a", "https://b.example").is_ok());
        }
        assert!(ask("a", "https://b.example").is_err());
        // Others still can, and the same account can still ask another server.
        assert!(ask("c", "https://b.example").is_ok());
        assert!(ask("a", "https://d.example").is_ok());
        // All of them together stay under what the other server allows one network address.
        let mut n = LOOKUPS_PER_ACCOUNT + 1;
        for i in 0..100 {
            if ask(&format!("x{i}"), "https://b.example").is_ok() {
                n += 1;
            }
        }
        assert_eq!(n, LOOKUPS_TO_SERVER);
    }

    #[test]
    fn unanswered_pings_close_the_connection() {
        let mut alive = Liveness::default();
        // Answered pings keep it open for as long as it lasts.
        for _ in 0..10 {
            assert!(alive.ping());
            alive.heard();
        }
        // MISSED_PONGS pings in a row without an answer are allowed; the next tick closes it.
        for _ in 0..MISSED_PONGS {
            assert!(alive.ping());
        }
        assert!(!alive.ping());
        // Anything from the device counts as an answer.
        alive.heard();
        assert!(alive.ping());
    }

    #[test]
    fn relay_bytes_per_recipient() {
        let app = app();
        for d in ["b1", "b2", "b3"] {
            connect(&app, "B", d, true);
        }
        let a = me("A", "a1");
        // Full chunks into one device: the per-recipient budget ends it long before the frame limit.
        let per = RELAY_PEER_BYTES as usize / MAX_RELAY;
        for _ in 0..per {
            assert!(
                relay_to(&app, &a, &["b1"], MAX_RELAY).is_empty(),
                "delivered"
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
        for d in &to {
            connect(&app, "D", d, true);
        }
        let to: Vec<&str> = to.iter().map(String::as_str).collect();
        // Fan-out counts once per recipient (duplicates and the sender itself not at all).
        let per = RELAY_BYTES as usize / (MAX_RELAY * to.len());
        for _ in 0..per {
            assert!(!is_limited(&relay_to(&app, &a, &to, MAX_RELAY)));
        }
        assert!(is_limited(&relay_to(&app, &a, &to, MAX_RELAY)));
        // Small frames still fit in what is left.
        assert!(!is_limited(&relay_to(&app, &a, &["d1", "d1", "a1"], 1000)));
        // Devices that are not connected cost nothing: there is nothing to forward.
        let m = relay_to(&app, &a, &["gone"], MAX_RELAY);
        assert_eq!(m.get("t").and_then(Value::as_str), Some("relay-missed"));
    }

    #[test]
    fn queued_chunks_have_their_own_budget() {
        // A queue large enough that only the rate limit decides.
        let app = app_with_queue(1 << 32);
        for i in 0..4 {
            app.db
                .put_prekey("B", &format!("q{i}"), &Value::from("p"))
                .expect("prekey");
        }
        connect(&app, "B", "b1", true);
        let a = me("A", "a1");
        // Use up the live budget into b1 first: queueing still works.
        for _ in 0..RELAY_PEER_BYTES as usize / MAX_RELAY {
            assert!(relay_to(&app, &a, &["b1"], MAX_RELAY).is_empty());
        }
        assert!(is_limited(&relay_to(&app, &a, &["b1"], MAX_RELAY)));
        // Counted once per queued copy.
        let per = RELAY_STORE_BYTES as usize / (MAX_RELAY * 4);
        for _ in 0..per {
            assert!(
                relay_with(&app, &a, &["q0", "q1", "q2", "q3"], MAX_RELAY, true).is_empty(),
                "queued"
            );
        }
        for _ in 0..(RELAY_STORE_BYTES as usize - per * MAX_RELAY * 4) / MAX_RELAY {
            assert!(
                relay_with(&app, &a, &["q0"], MAX_RELAY, true).is_empty(),
                "queued"
            );
        }
        // The store budget is per account: another device of the account is refused too.
        assert!(is_limited(&relay_with(
            &app,
            &me("A", "a2"),
            &["q0"],
            MAX_RELAY,
            true
        )));
        // ... and a frame that would also queue is refused whole, live part included.
        let other = me("C", "c1");
        assert!(!is_limited(&relay_with(
            &app,
            &other,
            &["b1", "q1"],
            MAX_RELAY,
            true
        )));
    }

    fn grant(app: &Arc<App>, me: &Authed, from: &str, bytes: i64) -> Map {
        object(handle(
            app,
            me,
            &Map::new()
                .with("t", "relay-grant")
                .with("from", from)
                .with("bytes", bytes)
                .with("ref", "g"),
        ))
    }

    #[test]
    fn a_grant_lifts_the_live_budget_for_one_sender() {
        let app = app();
        let sender = connect(&app, "A", "a1", true);
        connect(&app, "B", "b1", true);
        let a = me("A", "a1");
        let b = me("B", "b1");
        let extra = 2 * RELAY_PEER_BYTES as usize / MAX_RELAY;
        let grant_bytes = i64::try_from(extra * MAX_RELAY).expect("fits");
        assert_eq!(
            grant(&app, &b, "a1", grant_bytes)
                .get("t")
                .and_then(Value::as_str),
            Some("ok")
        );
        // The sender is told, so it can pace for it.
        std::thread::sleep(Duration::from_millis(50));
        let told = sender.lock().expect("lock").iter().any(|p| match p {
            Push::Text(t) => t.contains("relay-grant") && t.contains("b1"),
            Push::Binary(_) => false,
        });
        assert!(told, "the sender heard of the grant");
        // Twice the live budget gets through on the grant, then the live budget follows.
        for _ in 0..extra {
            assert!(relay_to(&app, &a, &["b1"], MAX_RELAY).is_empty());
        }
        assert_eq!(app.hub.granted("b1", "a1"), 0);
        for _ in 0..RELAY_PEER_BYTES as usize / MAX_RELAY {
            assert!(relay_to(&app, &a, &["b1"], MAX_RELAY).is_empty());
        }
        assert!(is_limited(&relay_to(&app, &a, &["b1"], MAX_RELAY)));
        // The grant was for a1 only: a2 of the same account is still on the (spent) live budget.
        assert!(is_limited(&relay_to(
            &app,
            &me("A", "a2"),
            &["b1"],
            MAX_RELAY
        )));
    }

    #[test]
    fn grants_are_checked() {
        let app = app();
        let b = me("B", "b1");
        for (from, bytes) in [("a1", -1), ("a1", MAX_GRANT + 1), ("b1", 10), ("a+1", 10)] {
            assert_eq!(
                grant(&app, &b, from, bytes)
                    .get("error")
                    .and_then(Value::as_str),
                Some("bad_field"),
                "{from} {bytes}"
            );
        }
        assert_eq!(
            grant(&app, &b, "a1", 10).get("t").and_then(Value::as_str),
            Some("ok")
        );
        assert_eq!(app.hub.granted("b1", "a1"), 10);
        assert_eq!(
            app.hub.granted("b2", "a1"),
            0,
            "only for the device that granted"
        );
        assert_eq!(
            grant(&app, &b, "a1", 0).get("t").and_then(Value::as_str),
            Some("ok")
        );
        assert_eq!(app.hub.granted("b1", "a1"), 0, "taken back");
        // A device holds at most MAX_GRANTS; the oldest goes first.
        for i in 0..=MAX_GRANTS {
            app.hub.grant(
                "b1",
                &format!("s{i}"),
                1,
                now() + 100 + i64::try_from(i).expect("small"),
            );
        }
        assert_eq!(app.hub.granted("b1", "s0"), 0);
        assert_eq!(app.hub.granted("b1", &format!("s{MAX_GRANTS}")), 1);
        app.hub.grant("b1", "old", 1, now() - 1);
        assert_eq!(app.hub.granted("b1", "old"), 0, "expired");
    }

    /// A binary relay frame from the parts.
    fn bin(flags: u8, to: &[[u8; 16]], ttl: u32, payload: &[u8]) -> Vec<u8> {
        let mut b = vec![BIN_RELAY, flags, u8::try_from(to.len()).expect("small")];
        for d in to {
            b.extend_from_slice(d);
        }
        b.extend_from_slice(&[7; 8]);
        b.extend_from_slice(&ttl.to_be_bytes());
        b.extend_from_slice(payload);
        b
    }

    #[test]
    fn binary_frames_are_parsed_strictly() {
        let d = [1u8; 16];
        let ok = bin(0, &[d], 0, b"xyz");
        let r = parse_binary(&ok).expect("parses");
        assert_eq!(r.to, vec![base64url_encode(&d)]);
        assert!(!r.store && r.ttl.is_none());
        assert_eq!(
            r.reference.as_deref(),
            Some(base64url_encode(&[7; 8]).as_str())
        );
        let two = bin(1, &[d, d], 60, b"x");
        let r = parse_binary(&two).expect("parses");
        assert!(r.store);
        assert_eq!((r.to.len(), r.ttl), (1, Some(60)), "duplicates dropped");
        let too_many: Vec<[u8; 16]> = (0..=MAX_RECIPIENTS)
            .map(|i| [u8::try_from(i).expect("small"); 16])
            .collect();
        let mut bad_kind = ok.clone();
        bad_kind[0] = 3;
        for bad in [
            Vec::new(),
            vec![BIN_RELAY],
            bad_kind,
            bin(2, &[d], 0, b"x"),
            bin(0, &[], 0, b"x"),
            bin(0, &too_many, 0, b"x"),
            bin(0, &[d], 0, b""),
            bin(0, &[d], 0, &vec![0; MAX_RELAY_BIN + 1]),
            ok[..ok.len() - 4].to_vec(),
            ok[..3 + 16 + 4].to_vec(),
        ] {
            assert!(parse_binary(&bad).is_err(), "{bad:?}");
        }
        assert!(parse_binary(&bin(0, &[d], 0, &vec![0; MAX_RELAY_BIN])).is_ok());
    }

    #[test]
    fn binary_chunks_go_to_binary_connections_only() {
        let app = app();
        let raw = [5u8; 16];
        let new = base64url_encode(&raw);
        let old_raw = [6u8; 16];
        let old = base64url_encode(&old_raw);
        let got = connect(&app, "B", &new, true);
        connect(&app, "B", &old, false);
        let sender = base64url_encode(&[9u8; 16]);
        let a = me("A", &sender);
        let reply = object(binary_frame(
            &app,
            &a,
            &bin(0, &[raw, old_raw, [8; 16]], 0, b"payload"),
        ));
        assert_eq!(reply.get("t").and_then(Value::as_str), Some("relay-missed"));
        let list = |k: &str| -> Vec<String> {
            reply
                .get(k)
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        assert_eq!(
            list("devices"),
            vec![old.clone(), base64url_encode(&[8; 16])]
        );
        assert_eq!(list("text"), vec![old]);
        assert_eq!(
            reply.get("ref").and_then(Value::as_str),
            Some(base64url_encode(&[7; 8]).as_str())
        );
        std::thread::sleep(Duration::from_millis(50));
        let g = got.lock().expect("lock");
        let Some(Push::Binary(b)) = g.first() else {
            panic!("no binary frame")
        };
        let mut want = vec![BIN_DELIVER];
        want.extend_from_slice(&[9; 16]);
        want.push(1);
        want.extend_from_slice(b"A");
        want.extend_from_slice(&0i64.to_be_bytes());
        want.extend_from_slice(b"payload");
        assert_eq!(b.as_ref(), want.as_slice());
    }

    #[test]
    fn binary_errors_carry_the_ref() {
        let app = app();
        let raw = [5u8; 16];
        connect(&app, "B", &base64url_encode(&raw), true);
        let a = me("A", &base64url_encode(&[9u8; 16]));
        let chunk = vec![0u8; MAX_RELAY_BIN];
        let mut last = Map::new();
        for _ in 0..=RELAY_PEER_BYTES as usize / MAX_RELAY_BIN {
            last = object(binary_frame(&app, &a, &bin(0, &[raw], 0, &chunk)));
        }
        assert_eq!(
            last.get("error").and_then(Value::as_str),
            Some("rate_limited")
        );
        assert_eq!(
            last.get("id").and_then(Value::as_str),
            Some(base64url_encode(&[7; 8]).as_str())
        );
        let bad = object(binary_frame(&app, &a, &[1, 2, 3]));
        assert_eq!(bad.get("error").and_then(Value::as_str), Some("bad_relay"));
    }

    /// A `send` to one device, with `ttl` as the given JSON value (or absent).
    fn send_one(app: &Arc<App>, me: &Authed, ttl: Option<Value>) -> Map {
        let mut item = Map::new().with("device", "b1").with("env", "e");
        if let Some(ttl) = ttl {
            item.insert("ttl", ttl);
        }
        let f = Map::new()
            .with("t", "send")
            .with("id", "s")
            .with("to", Value::Array(vec![Value::Object(item)]));
        match handle(app, me, &f).now() {
            Some(Message::Text(t)) => match parse_limited(t.as_bytes(), MAX_FRAME) {
                Ok(Value::Object(m)) => m,
                _ => panic!("not an object"),
            },
            _ => panic!("no reply"),
        }
    }

    fn newest_expires(app: &Arc<App>) -> i64 {
        app.db
            .conn()
            .expect("conn")
            .query_row(
                "SELECT expires FROM mailbox ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("expires")
    }

    fn sender_with_known_device() -> (Arc<App>, Authed) {
        let app = app();
        app.db
            .put_prekey("B", "b1", &Value::from("p"))
            .expect("prekey");
        (app, me("A", "a1"))
    }

    /// One frame from `me` with `n` envelopes for `device`; how many of them were refused.
    fn send_many(app: &Arc<App>, me: &Authed, device: &str, n: usize) -> usize {
        let item: Value = Map::new().with("device", device).with("env", "e").into();
        let f = Map::new()
            .with("t", "send")
            .with("id", "s")
            .with("to", Value::Array(vec![item; n]));
        let r = object(handle(app, me, &f));
        assert_eq!(r.get("t").and_then(Value::as_str), Some("sent"), "{r:?}");
        r.get("failed")
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    }

    fn fill(app: &Arc<App>, me: &Authed, device: &str, mut n: usize) -> usize {
        let mut refused = 0;
        while n > 0 {
            let k = n.min(MAX_RECIPIENTS);
            refused += send_many(app, me, device, k);
            n -= k;
        }
        refused
    }

    fn known(app: &Arc<App>, account: &str, device: &str) {
        app.db
            .put_prekey(account, device, &Value::from("p"))
            .expect("prekey");
    }

    #[test]
    fn a_stranger_gets_a_small_share_of_a_mailbox() {
        let app = app();
        known(&app, "A", "a1");
        known(&app, "B", "b1");
        let share = usize::try_from(SHARE_STRANGER).unwrap_or_default();
        // A has never been written to by B: only its small share of b1's mailbox, the rest is refused per device.
        assert_eq!(fill(&app, &me("A", "a1"), "b1", share), 0);
        assert_eq!(fill(&app, &me("A", "a2"), "b1", 3), 3);
        // Another sender has its own share.
        assert_eq!(fill(&app, &me("C", "c1"), "b1", 3), 0);
    }

    #[test]
    fn a_contact_gets_a_larger_share_and_own_devices_the_whole_mailbox() {
        let app = app();
        known(&app, "A", "a1");
        known(&app, "A", "a2");
        known(&app, "B", "b1");
        // B wrote to A (accepted its request, say): from then on A is a contact of B's devices.
        assert_eq!(send_many(&app, &me("B", "b1"), "a1", 1), 0);
        let stranger = usize::try_from(SHARE_STRANGER).unwrap_or_default();
        let contact = usize::try_from(SHARE_CONTACT).unwrap_or_default();
        assert_eq!(fill(&app, &me("A", "a1"), "b1", stranger + 10), 0);
        assert_eq!(fill(&app, &me("A", "a1"), "b1", contact - stranger - 10), 0);
        assert_eq!(
            fill(&app, &me("A", "a2"), "b1", 1),
            1,
            "the contact share is used up"
        );
        // A's own other device takes more than any share.
        assert_eq!(fill(&app, &me("A", "a1"), "a2", contact + 10), 0);
    }

    #[test]
    fn another_server_shares_one_part_of_a_mailbox() {
        let app = app();
        known(&app, "B", "b1");
        let t = now();
        let share = share_for(&app, "B", Sender::Server("https://x.example"), t)
            .expect("share")
            .expect("not own");
        assert_eq!(share.max, SHARE_SERVER_STRANGER);
        // Once B wrote to someone there, the server counts as a contact.
        note_writes(&app, "B", ["@https://x.example"], t);
        let contact = share_for(&app, "B", Sender::Server("https://x.example"), t)
            .expect("share")
            .expect("not own");
        assert_eq!(contact.max, SHARE_SERVER);
        assert_eq!(contact.sender, share.sender);
        // Another server is still a stranger; the account's own name is no server's.
        let other = share_for(&app, "B", Sender::Server("https://y.example"), t)
            .expect("share")
            .expect("not own");
        assert_eq!(other.max, SHARE_SERVER_STRANGER);
        assert_ne!(other.sender, share.sender);
        assert!(
            share_for(&app, "B", Sender::Account("B"), t)
                .expect("share")
                .is_none()
        );
        // What one server queued counts against its share only.
        for i in 0..SHARE_SERVER_STRANGER {
            assert!(
                app.db
                    .enqueue("b1", "e", t + 60, MAX_QUEUE, None, Some(&other))
                    .expect("enqueue")
                    .is_some(),
                "envelope {i}"
            );
        }
        assert!(
            app.db
                .enqueue("b1", "e", t + 60, MAX_QUEUE, None, Some(&other))
                .expect("enqueue")
                .is_none()
        );
        assert!(
            app.db
                .enqueue("b1", "e", t + 60, MAX_QUEUE, None, Some(&share))
                .expect("enqueue")
                .is_some()
        );
    }

    fn mailbox_len(app: &Arc<App>) -> i64 {
        app.db
            .conn()
            .expect("conn")
            .query_row("SELECT COUNT(*) FROM mailbox", [], |r| r.get(0))
            .expect("count")
    }

    fn send_to(app: &Arc<App>, me: &Authed, to: Vec<Value>) -> Map {
        let f = Map::new()
            .with("t", "send")
            .with("id", "s")
            .with("to", Value::Array(to));
        object(handle(app, me, &f))
    }

    #[test]
    fn a_bad_recipient_fails_the_frame_before_anything_is_queued() {
        let (app, a) = sender_with_known_device();
        let good = Map::new().with("device", "b1").with("env", "e");
        for bad in [
            Map::new()
                .with("device", "b1")
                .with("env", "not base64url!"),
            Map::new()
                .with("device", "b1")
                .with("env", "e")
                .with("ttl", 0i64),
            Map::new().with("env", "e"),
        ] {
            let r = send_to(&app, &a, vec![good.clone().into(), bad.into()]);
            assert_eq!(r.get("t").and_then(Value::as_str), Some("error"));
            assert_eq!(mailbox_len(&app), 0, "nothing queued for the good one");
        }
        // Per device failures are reported per device, and the others are queued.
        let r = send_to(
            &app,
            &a,
            vec![
                good.clone().into(),
                Map::new().with("device", "nobody").with("env", "e").into(),
            ],
        );
        assert_eq!(r.get("t").and_then(Value::as_str), Some("sent"));
        assert_eq!(
            r.get("failed").and_then(Value::as_array).map(Vec::len),
            Some(1)
        );
        assert_eq!(mailbox_len(&app), 1);
    }

    #[test]
    fn ttl_shortens_mailbox_lifetime() {
        let (app, a) = sender_with_known_device();
        let before = now();
        let r = send_one(&app, &a, Some(60i64.into()));
        let after = now();
        assert_eq!(r.get("t").and_then(Value::as_str), Some("sent"));
        let expires = newest_expires(&app);
        assert!(
            (before + 60..=after + 60).contains(&expires),
            "expires {expires} outside [{}, {}]",
            before + 60,
            after + 60
        );
    }

    #[test]
    fn absent_ttl_keeps_the_mailbox_default() {
        let (app, a) = sender_with_known_device();
        let before = now();
        let r = send_one(&app, &a, None);
        let after = now();
        assert_eq!(r.get("t").and_then(Value::as_str), Some("sent"));
        let expires = newest_expires(&app);
        assert!(
            (before + MAILBOX_TTL..=after + MAILBOX_TTL).contains(&expires),
            "expires {expires}"
        );
    }

    #[test]
    fn ttl_above_mailbox_ttl_is_capped() {
        let (app, a) = sender_with_known_device();
        let before = now();
        let r = send_one(&app, &a, Some((MAILBOX_TTL * 10).into()));
        let after = now();
        assert_eq!(r.get("t").and_then(Value::as_str), Some("sent"));
        let expires = newest_expires(&app);
        assert!(
            (before + MAILBOX_TTL..=after + MAILBOX_TTL).contains(&expires),
            "expires {expires}"
        );
    }

    #[test]
    fn bad_ttl_is_rejected() {
        let (app, a) = sender_with_known_device();
        for bad in [
            Value::from("soon"),
            0i64.into(),
            (-5i64).into(),
            Value::Bool(false),
        ] {
            let r = send_one(&app, &a, Some(bad));
            assert_eq!(
                r.get("error").and_then(Value::as_str),
                Some("bad_field"),
                "ttl should be rejected"
            );
        }
    }

    /// A queued `relay` to the unconnected device b1, with `ttl` as the given JSON value (or absent).
    fn relay_queued(app: &Arc<App>, me: &Authed, ttl: Option<Value>) -> Option<Map> {
        let mut f = Map::new()
            .with("t", "relay")
            .with("to", Value::Array(vec![Value::from("b1")]))
            .with("data", "abc")
            .with("store", Value::Bool(true));
        if let Some(ttl) = ttl {
            f.insert("ttl", ttl);
        }
        match handle(app, me, &f).now() {
            Some(Message::Text(t)) => match parse_limited(t.as_bytes(), MAX_FRAME) {
                Ok(Value::Object(m)) => Some(m),
                _ => panic!("not an object"),
            },
            None => None,
            _ => panic!("unexpected reply"),
        }
    }

    fn newest_chunk_expires(app: &Arc<App>) -> i64 {
        app.db
            .conn()
            .expect("conn")
            .query_row(
                "SELECT expires FROM relay_queue ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("expires")
    }

    fn queue_sender() -> (Arc<App>, Authed) {
        let app = app_with_queue(1 << 20);
        app.db
            .put_prekey("B", "b1", &Value::from("p"))
            .expect("prekey");
        (app, me("A", "a1"))
    }

    #[test]
    fn relay_ttl_shortens_queued_chunk_lifetime() {
        let (app, a) = queue_sender();
        for (ttl, want) in [
            (Some(Value::from(60i64)), 60),
            (None, MAILBOX_TTL),
            (Some(Value::from(MAILBOX_TTL * 10)), MAILBOX_TTL),
        ] {
            let before = now();
            assert!(
                relay_queued(&app, &a, ttl).is_none(),
                "queued, nothing missed"
            );
            let after = now();
            let expires = newest_chunk_expires(&app);
            assert!(
                (before + want..=after + want).contains(&expires),
                "expires {expires}, want about now + {want}"
            );
        }
    }

    #[test]
    fn relay_bad_ttl_is_rejected() {
        let (app, a) = queue_sender();
        for bad in [Value::from("soon"), 0i64.into(), (-5i64).into()] {
            let r = relay_queued(&app, &a, Some(bad)).expect("an error");
            assert_eq!(r.get("error").and_then(Value::as_str), Some("bad_field"));
        }
    }
}
