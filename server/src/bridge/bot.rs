//! A bot: an ordinary Murmo account whose one device lives in the bridge (DESIGN.md §16). It speaks the same protocol
//! as the web client (`client/js/protocol.js`, DESIGN.md §4–§6): a device list, signed prekeys, envelopes per device
//! and signed messages inside them. Contacts see a bot as any other account.
//!
//! The functions here do no HTTP; [`super`] calls them for the API. Storage is the server's own (the bot's device list,
//! prekeys and mailbox are where every account's are), and the bot's secrets are in its encrypted state.

use super::store::BotRow;
use crate::app::{App, Push, now, random, text};
use crate::devices::{Device, device_id, verify_list, verify_prekey};
use crate::error::ApiError;
use crate::ws::{MAILBOX_TTL, MAX_QUEUE, Sender, note_writes, share_for};
use rootcard::crypto::{
    aes_gcm_decrypt, aes_gcm_encrypt, ed25519_public, ed25519_sign, ed25519_verify, frame, hkdf,
    usable_seed, x25519, x25519_public,
};
use rootcard::encoding::{
    base32_encode, base64url_decode, base64url_decode_fixed, base64url_encode,
};
use rootcard::json::{Map, Value, canonical, parse_limited};
use rootcard::keys::{KeyType, format_key, parse_key};
use rootcard_host::store::IdentityStore;
use std::collections::BTreeMap;
use std::sync::Arc;
use zeroize::Zeroizing;

// Protocol labels: the client's (`LABELS` in protocol.js), with the project's old name.
/// Label of signed messages.
pub const MESSAGE_LABEL: &str = "mesg/message/v1";
/// HKDF info of the envelope key.
pub const BOX_LABEL: &str = "mesg/box/v1";
/// Label of the key that encrypts a bot's state at rest (bridge only).
pub const STATE_LABEL: &str = "murmo/bridge/state/v1";

/// A device publishes a new prekey this often (seconds).
pub const PREKEY_ROTATE: i64 = 7 * 24 * 3600;
/// ...and deletes a replaced prekey's private key this long after it was made plus `PREKEY_ROTATE`.
pub const PREKEY_KEEP: i64 = 21 * 24 * 3600;
/// The oldest prekey a sender uses.
pub const PREKEY_MAX_AGE: i64 = PREKEY_ROTATE + PREKEY_KEEP;
/// How far in the future a prekey's time may be.
const PREKEY_SKEW: i64 = 24 * 3600;
/// Longest note of a message request (characters).
pub const NOTE_MAX: usize = 500;
/// Longest text (characters).
pub const TEXT_MAX: usize = 8000;
/// Most events kept for the API client before the oldest go.
pub const INBOX_MAX: usize = 1000;
/// Message ids remembered to drop copies that come again.
const SEEN_MAX: usize = 2000;
/// Envelopes read from the mailbox per call.
const READ_BATCH: i64 = 200;
/// Most ids in one receipt.
const RECEIPT_MAX: usize = 200;
/// Most contacts a bot keeps: requests from more new accounts are dropped (its state stays small).
pub const MAX_CONTACTS: usize = 2000;
/// The bot device's label in its device list (visible to contacts).
pub const DEVICE_LABEL: &str = "Murmo Bridge";

/// Kinds the client knows (`KINDS` in protocol.js); anything else is not a message.
const KINDS: &[&str] = &[
    "request",
    "accept",
    "text",
    "file",
    "sync",
    "history",
    "receipt",
    "reaction",
    "gifs",
    "names",
    "read",
    "retract",
    "edit",
    "ephemeral",
];

fn b64(b: &[u8]) -> String {
    base64url_encode(b)
}

fn bad(status: u16, code: &'static str) -> ApiError {
    ApiError::new(status, code)
}

/// 32 random bytes that make a usable Ed25519 seed ([CRY-9]).
pub fn draw_seed() -> Zeroizing<[u8; 32]> {
    loop {
        let s = Zeroizing::new(random::<32>());
        if usable_seed(&s) {
            return s;
        }
    }
}

/// `sig` over `frame(label, canonical(m))`, added to `m`.
pub fn sign(label: &str, m: Map, seed: &[u8; 32]) -> Map {
    let sig = ed25519_sign(seed, &frame(label, &canonical(&Value::Object(m.clone()))));
    m.with("sig", b64(&sig))
}

/// Check `sig` over `frame(label, canonical(m without sig))`.
fn verify_sig(label: &str, m: &Map, key: &[u8; 32]) -> bool {
    let Some(sig) = m
        .get("sig")
        .and_then(Value::as_str)
        .and_then(|s| base64url_decode_fixed::<64>(s).ok())
    else {
        return false;
    };
    ed25519_verify(
        key,
        &frame(label, &canonical(&Value::Object(m.without("sig")))),
        &sig,
    )
    .is_ok()
}

// ── state ───────────────────────────────────────────────────────────────────────────────────────────────────────

/// A prekey's private key.
pub struct PrekeySecret {
    /// The prekey id (8 random bytes, base64url).
    pub id: String,
    /// The X25519 secret.
    pub secret: Zeroizing<[u8; 32]>,
    /// When it was made.
    pub time: i64,
}

/// What the bot knows about another account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contact {
    /// `Name#TAG`, as last seen.
    pub handle: String,
    /// `incoming` (it asked), `outgoing` (we asked), `accepted`, `declined` or `blocked`.
    pub state: String,
    /// When the state last changed.
    pub updated: i64,
    /// When the bot declined it (0: never): only a request signed later brings it back.
    pub declined: i64,
}

/// A bot's secrets and memory, kept encrypted in the bridge's table.
pub struct State {
    /// The device key's seed.
    pub device_seed: Zeroizing<[u8; 32]>,
    /// Private keys of its prekeys, newest last.
    pub prekeys: Vec<PrekeySecret>,
    /// Contacts by account id.
    pub contacts: BTreeMap<String, Contact>,
    /// Events not yet confirmed by the API client, oldest first.
    pub inbox: Vec<Value>,
    /// The number of the last event made.
    pub seq: i64,
    /// Ids of messages taken (`<account> <id>`), oldest first.
    pub seen: Vec<String>,
}

impl State {
    /// A new state for a device key.
    pub fn new(device_seed: Zeroizing<[u8; 32]>) -> State {
        State {
            device_seed,
            prekeys: Vec::new(),
            contacts: BTreeMap::new(),
            inbox: Vec::new(),
            seq: 0,
            seen: Vec::new(),
        }
    }

    /// The device's public key.
    pub fn device_key(&self) -> [u8; 32] {
        ed25519_public(&self.device_seed)
    }

    /// The device id.
    pub fn device_id(&self) -> String {
        device_id(&self.device_key())
    }

    fn to_value(&self) -> Value {
        let prekeys: Vec<Value> = self
            .prekeys
            .iter()
            .map(|p| {
                Map::new()
                    .with("id", p.id.as_str())
                    .with("secret", b64(&p.secret[..]))
                    .with("time", p.time)
                    .into()
            })
            .collect();
        let mut contacts = Map::new();
        for (a, c) in &self.contacts {
            contacts.insert(
                a.as_str(),
                Map::new()
                    .with("handle", c.handle.as_str())
                    .with("state", c.state.as_str())
                    .with("updated", c.updated)
                    .with("declined", c.declined)
                    .into(),
            );
        }
        Map::new()
            .with("v", 1i64)
            .with("device", b64(&self.device_seed[..]))
            .with("prekeys", Value::Array(prekeys))
            .with("contacts", contacts)
            .with("inbox", Value::Array(self.inbox.clone()))
            .with("seq", self.seq)
            .with(
                "seen",
                Value::Array(self.seen.iter().map(Value::from).collect()),
            )
            .into()
    }

    fn from_value(v: &Value) -> Option<State> {
        let m = v.as_object()?;
        if m.get("v")?.as_int()? != 1 {
            return None;
        }
        let seed = |s: &str| -> Option<Zeroizing<[u8; 32]>> {
            Some(Zeroizing::new(base64url_decode_fixed::<32>(s).ok()?))
        };
        let mut prekeys = Vec::new();
        for p in m.get("prekeys")?.as_array()? {
            let p = p.as_object()?;
            prekeys.push(PrekeySecret {
                id: p.get("id")?.as_str()?.to_string(),
                secret: seed(p.get("secret")?.as_str()?)?,
                time: p.get("time")?.as_int()?,
            });
        }
        let mut contacts = BTreeMap::new();
        for (a, c) in m.get("contacts")?.as_object()?.iter() {
            let c = c.as_object()?;
            contacts.insert(
                a.to_string(),
                Contact {
                    handle: c.get("handle")?.as_str()?.to_string(),
                    state: c.get("state")?.as_str()?.to_string(),
                    updated: c.get("updated")?.as_int()?,
                    declined: c.get("declined")?.as_int()?,
                },
            );
        }
        Some(State {
            device_seed: seed(m.get("device")?.as_str()?)?,
            prekeys,
            contacts,
            inbox: m.get("inbox")?.as_array()?.clone(),
            seq: m.get("seq")?.as_int()?,
            seen: m
                .get("seen")?
                .as_array()?
                .iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect(),
        })
    }

    /// Encrypt for storage under the bridge key, bound to the bot's account: `nonce ‖ AES-GCM(...)`.
    pub fn seal(&self, bridge_key: &[u8; 32], account: &str) -> Result<Vec<u8>, ApiError> {
        let key = hkdf(bridge_key, account.as_bytes(), STATE_LABEL.as_bytes());
        let n = random::<12>();
        let plain = Zeroizing::new(canonical(&self.to_value()));
        let ct =
            aes_gcm_encrypt(&key, &n, &plain, account.as_bytes()).map_err(ApiError::internal)?;
        let mut out = n.to_vec();
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// Decrypt what [`State::seal`] made.
    pub fn open(bridge_key: &[u8; 32], account: &str, blob: &[u8]) -> Result<State, ApiError> {
        // No account id in what the server prints (DESIGN.md §11).
        let corrupt = || ApiError::internal("bridge: a bot's state does not open");
        if blob.len() < 12 {
            return Err(corrupt());
        }
        let key = hkdf(bridge_key, account.as_bytes(), STATE_LABEL.as_bytes());
        let mut n = [0u8; 12];
        n.copy_from_slice(&blob[..12]);
        let plain =
            aes_gcm_decrypt(&key, &n, &blob[12..], account.as_bytes()).map_err(|_| corrupt())?;
        let v = parse_limited(&plain, plain.len().max(1)).map_err(|_| corrupt())?;
        State::from_value(&v).ok_or_else(corrupt)
    }

    /// Add an event for the API client (numbered; the oldest go when there are too many).
    fn event(&mut self, kind: &str, fields: Map) {
        self.seq += 1;
        let mut m = Map::new()
            .with("seq", self.seq)
            .with("type", kind)
            .with("received", now());
        for (k, v) in fields.iter() {
            m.insert(k, v.clone());
        }
        self.inbox.push(m.into());
        if self.inbox.len() > INBOX_MAX {
            let extra = self.inbox.len() - INBOX_MAX;
            self.inbox.drain(..extra);
        }
    }

    /// Hand out up to `n` events and forget them at once (a bot that keeps nothing: retention 0).
    pub fn take(&mut self, n: usize) -> Vec<Value> {
        let n = n.min(self.inbox.len());
        self.inbox.drain(..n).collect()
    }

    /// Forget events received more than `days` days ago, confirmed or not (`days` 0: nothing to do here, they go
    /// when handed out).
    pub fn prune(&mut self, days: i64) {
        if days <= 0 {
            return;
        }
        let oldest = now() - days * 24 * 3600;
        self.inbox.retain(|e| {
            e.as_object()
                .and_then(|m| m.get("received"))
                .and_then(Value::as_int)
                .is_some_and(|t| t >= oldest)
        });
    }

    /// Drop the events up to `seq` (the API client has them).
    pub fn confirm(&mut self, seq: i64) {
        self.inbox.retain(|e| {
            e.as_object()
                .and_then(|m| m.get("seq"))
                .and_then(Value::as_int)
                > Some(seq)
        });
    }

    /// Whether a message id from `account` was taken before; remembers it.
    fn seen_before(&mut self, account: &str, id: &str) -> bool {
        let k = format!("{account} {id}");
        if self.seen.contains(&k) {
            return true;
        }
        self.seen.push(k);
        if self.seen.len() > SEEN_MAX {
            let extra = self.seen.len() - SEEN_MAX;
            self.seen.drain(..extra);
        }
        false
    }
}

// ── envelopes (DESIGN.md §5.1) ──────────────────────────────────────────────────────────────────────────────────

/// Encrypt `plaintext` to a device's prekey `(id, X25519 public key)`. Returns the packed envelope.
pub fn seal(
    to_device: &str,
    prekey_id: &str,
    spk: &[u8; 32],
    plaintext: &[u8],
) -> Result<String, ApiError> {
    let e = Zeroizing::new(random::<32>());
    let epk = x25519_public(&e);
    let shared = x25519(&e, spk).map_err(|_| bad(400, "bad_key"))?;
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(&epk);
    salt[32..].copy_from_slice(spk);
    let key = hkdf(&shared[..], &salt, BOX_LABEL.as_bytes());
    let head = Map::new()
        .with("v", 1i64)
        .with("to", to_device)
        .with("spk", prekey_id)
        .with("epk", format_key(KeyType::X25519, &epk));
    let n = random::<12>();
    let ct = aes_gcm_encrypt(
        &key,
        &n,
        plaintext,
        &canonical(&Value::Object(head.clone())),
    )
    .map_err(ApiError::internal)?;
    let env = head.with("n", b64(&n)).with("ct", b64(&ct));
    Ok(b64(&canonical(&env.into())))
}

/// Decrypt a packed envelope for `my_device` with its prekeys. `None` when it cannot be (for good).
pub fn open(my_device: &str, prekeys: &[PrekeySecret], packed: &str) -> Option<Zeroizing<Vec<u8>>> {
    let bytes = base64url_decode(packed).ok()?;
    let env = parse_limited(&bytes, bytes.len().max(1)).ok()?;
    let m = env.as_object()?;
    if m.get("v")?.as_int()? != 1 || m.get("to")?.as_str()? != my_device {
        return None;
    }
    let spk_id = m.get("spk")?.as_str()?;
    let epk_text = m.get("epk")?.as_str()?;
    let pk = prekeys.iter().find(|p| p.id == spk_id)?;
    let epk = parse_key(epk_text, KeyType::X25519).ok()?;
    let spk = x25519_public(&pk.secret);
    let shared = x25519(&pk.secret, &epk).ok()?;
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(&epk);
    salt[32..].copy_from_slice(&spk);
    let key = hkdf(&shared[..], &salt, BOX_LABEL.as_bytes());
    let head = Map::new()
        .with("v", 1i64)
        .with("to", my_device)
        .with("spk", spk_id)
        .with("epk", epk_text);
    let n = base64url_decode_fixed::<12>(m.get("n")?.as_str()?).ok()?;
    let ct = base64url_decode(m.get("ct")?.as_str()?).ok()?;
    aes_gcm_decrypt(&key, &n, &ct, &canonical(&Value::Object(head))).ok()
}

// ── the bot ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// The bot as the protocol needs it.
pub struct Me<'a> {
    /// Its account.
    pub account: &'a str,
    /// Its device.
    pub device: &'a str,
    /// The only account it talks with, when its owner chose so (the owner's own).
    pub only: Option<&'a str>,
}

impl<'a> Me<'a> {
    /// The bot of a row.
    pub fn of(row: &'a BotRow) -> Me<'a> {
        Me {
            account: &row.account,
            device: &row.device,
            only: row.owner_only.then_some(row.owner.as_str()),
        }
    }

    /// Whether the bot may talk with `peer`.
    pub fn allows(&self, peer: &str) -> bool {
        self.only.is_none_or(|o| o == peer)
    }
}

/// `Name#TAG` of an account this server knows (its own or one from another home), or the account id.
pub fn handle_of(app: &App, account: &str) -> String {
    let username = app
        .host
        .store
        .load(account)
        .ok()
        .flatten()
        .map(|s| s.state.username)
        .or_else(|| {
            app.db
                .remote(account)
                .ok()
                .flatten()
                .map(|r| r.state.username)
        });
    match username {
        Some(u) => rootcard::id::handle(&u, account),
        None => account.to_string(),
    }
}

fn who(app: &App, account: &str) -> Value {
    Map::new()
        .with("account", account)
        .with("handle", handle_of(app, account))
        .into()
}

/// Make a new prekey if the newest is older than [`PREKEY_ROTATE`], publish it, and forget private keys older than
/// [`PREKEY_MAX_AGE`] (except the newest). Returns whether the state changed.
pub fn rotate_prekey(app: &App, me: &Me<'_>, st: &mut State) -> Result<bool, ApiError> {
    let t = now();
    let newest = st.prekeys.iter().map(|p| p.time).max().unwrap_or(0);
    let mut changed = false;
    if t - newest > PREKEY_ROTATE {
        let secret = Zeroizing::new(random::<32>());
        let id = b64(&random::<8>());
        let value: Value = sign(
            crate::devices::PREKEY_LABEL,
            Map::new()
                .with("v", 1i64)
                .with("account", me.account)
                .with("device", me.device)
                .with("id", id.as_str())
                .with("key", format_key(KeyType::X25519, &x25519_public(&secret)))
                .with("time", t),
            &st.device_seed,
        )
        .into();
        let dev = Device {
            id: me.device.to_string(),
            key: st.device_key(),
            label: DEVICE_LABEL.into(),
        };
        verify_prekey(me.account, &dev, &value)?;
        app.db
            .put_prekey(me.account, me.device, &value)
            .map_err(ApiError::internal)?;
        st.prekeys.push(PrekeySecret {
            id,
            secret,
            time: t,
        });
        changed = true;
    }
    let newest = st.prekeys.iter().map(|p| p.time).max().unwrap_or(0);
    let before = st.prekeys.len();
    st.prekeys
        .retain(|p| p.time == newest || t - p.time <= PREKEY_MAX_AGE);
    Ok(changed || st.prekeys.len() != before)
}

/// A recipient device with a usable prekey.
struct Target {
    device: String,
    prekey_id: String,
    spk: [u8; 32],
}

/// The present devices of `account` that can receive (a fresh, valid prekey), and the list's head.
fn targets(app: &App, account: &str) -> Result<(Vec<Target>, String), ApiError> {
    let cur = app.current(account)?;
    let list = cur.list.ok_or(bad(409, "no_devices"))?;
    let t = now();
    let mut out = Vec::new();
    for d in &list.present {
        let Some(v) = app.db.prekey(&d.id).map_err(ApiError::internal)? else {
            continue; // a paper key, or a device that never published one
        };
        let Ok(p) = verify_prekey(account, d, &v) else {
            continue;
        };
        let m = p.value.as_object().ok_or(bad(500, "internal"))?;
        let time = m.get("time").and_then(Value::as_int).unwrap_or(0);
        if time > t + PREKEY_SKEW || t - time > PREKEY_MAX_AGE {
            continue;
        }
        let Some(spk) = m
            .get("key")
            .and_then(Value::as_str)
            .and_then(|k| parse_key(k, KeyType::X25519).ok())
        else {
            continue;
        };
        out.push(Target {
            device: d.id.clone(),
            prekey_id: p.id,
            spk,
        });
    }
    Ok((out, list.head))
}

/// What a send did: the message and the devices it did not reach.
pub struct Sent {
    /// The message id.
    pub id: String,
    /// Its time.
    pub time: i64,
    /// Devices of the other party it did not reach (unknown, a full mailbox or this sender's share of it).
    pub failed: Vec<String>,
    /// How many devices it was put in the mailbox of.
    pub queued: usize,
}

/// Sign, encrypt and queue one message from the bot to every device of `peer` that can receive. The bot has no other
/// devices of its own to copy it to.
pub fn deliver(
    app: &Arc<App>,
    me: &Me<'_>,
    st: &State,
    peer: &str,
    kind: &str,
    body: Map,
) -> Result<Sent, ApiError> {
    if peer == me.account {
        return Err(bad(400, "self"));
    }
    let (devices, peer_head) = targets(app, peer)?;
    if devices.is_empty() {
        return Err(bad(409, "no_devices"));
    }
    let own_head = app
        .current(me.account)?
        .list
        .map(|l| l.head)
        .ok_or(bad(409, "no_devices"))?;
    let id = b64(&random::<16>());
    let t = now();
    let heads = Map::new()
        .with(me.account, own_head.as_str())
        .with(peer, peer_head.as_str());
    let notify = matches!(kind, "request" | "text");
    let share = share_for(app, peer, Sender::Account(me.account), t)?;
    let mut failed = Vec::new();
    let mut queued = 0;
    for d in &devices {
        let m = sign(
            MESSAGE_LABEL,
            Map::new()
                .with("v", 1i64)
                .with("id", id.as_str())
                .with("kind", kind)
                .with("time", t)
                .with(
                    "from",
                    Map::new()
                        .with("account", me.account)
                        .with("device", me.device),
                )
                .with(
                    "to",
                    Map::new()
                        .with("account", peer)
                        .with("device", d.device.as_str()),
                )
                .with("conv", peer)
                .with("heads", heads.clone())
                .with("body", body.clone()),
            &st.device_seed,
        );
        let env = seal(&d.device, &d.prekey_id, &d.spk, &canonical(&m.into()))?;
        crate::ws::check_envelope(&env)?;
        match app
            .db
            .enqueue(
                &d.device,
                &env,
                t + MAILBOX_TTL,
                MAX_QUEUE,
                None,
                share.as_ref(),
            )
            .map_err(ApiError::internal)?
        {
            Some(mid) => {
                queued += 1;
                let push = Map::new()
                    .with("t", "msg")
                    .with("id", mid)
                    .with("env", env.as_str());
                app.hub.to_device(&d.device, Push::Text(text(&push.into())));
                if notify {
                    crate::push::schedule(app, &d.device, mid);
                }
            }
            None => failed.push(d.device.clone()),
        }
    }
    note_writes(app, me.account, [peer], t);
    Ok(Sent {
        id,
        time: t,
        failed,
        queued,
    })
}

/// A verified message from another account.
struct Message {
    id: String,
    kind: String,
    from: String,
    time: i64,
    body: Map,
}

/// Why an envelope was not taken.
enum Refused {
    /// For good: it is dropped from the mailbox.
    Drop,
    /// Maybe later (storage failed): it stays in the mailbox.
    Later,
}

/// Check a decrypted message (`verifyMessage` in protocol.js): for this device, from a present device of another
/// account, about the conversation with the bot, signed.
fn verify_message(app: &App, me: &Me<'_>, bytes: &[u8]) -> Result<Message, Refused> {
    let v = parse_limited(bytes, bytes.len().max(1)).map_err(|_| Refused::Drop)?;
    let m = v.as_object().ok_or(Refused::Drop)?;
    let get_str = |o: &Map, k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
    let kind = get_str(m, "kind")
        .filter(|k| KINDS.contains(&k.as_str()))
        .ok_or(Refused::Drop)?;
    if m.get("v").and_then(Value::as_int) != Some(1) {
        return Err(Refused::Drop);
    }
    let id = get_str(m, "id").ok_or(Refused::Drop)?;
    let time = m.get("time").and_then(Value::as_int).ok_or(Refused::Drop)?;
    let to = m
        .get("to")
        .and_then(Value::as_object)
        .ok_or(Refused::Drop)?;
    if get_str(to, "account").as_deref() != Some(me.account)
        || get_str(to, "device").as_deref() != Some(me.device)
    {
        return Err(Refused::Drop);
    }
    let from = m
        .get("from")
        .and_then(Value::as_object)
        .ok_or(Refused::Drop)?;
    let from_account = get_str(from, "account").ok_or(Refused::Drop)?;
    let from_device = get_str(from, "device").ok_or(Refused::Drop)?;
    // The bot has no other devices: everything comes from another account, about the conversation with the bot.
    if from_account == me.account || get_str(m, "conv").as_deref() != Some(me.account) {
        return Err(Refused::Drop);
    }
    let cur = match app.current(&from_account) {
        Ok(c) => c,
        Err(e) if e.status >= 500 => return Err(Refused::Later),
        Err(_) => return Err(Refused::Drop),
    };
    let dev = cur.device(&from_device).ok_or(Refused::Drop)?;
    if !verify_sig(MESSAGE_LABEL, m, &dev.key) {
        return Err(Refused::Drop);
    }
    Ok(Message {
        id,
        kind,
        from: from_account,
        time,
        body: m
            .get("body")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    })
}

/// For the fuzz target: check `bytes` as a decrypted message to `account`'s device `device`.
#[doc(hidden)]
pub fn fuzz_message(app: &App, account: &str, device: &str, bytes: &[u8]) {
    let me = Me {
        account,
        device,
        only: None,
    };
    let _ = verify_message(app, &me, bytes).is_ok();
}

fn body_str(b: &Map, k: &str, max: usize) -> Option<String> {
    b.get(k)
        .and_then(Value::as_str)
        .map(|s| s.chars().take(max).collect())
}

/// Envelopes read per call at most (the rest wait for the next).
const READ_MAX: usize = 1000;

/// Read the bot's mailbox: decrypt, verify and act on each envelope, turn what the API client should see into events,
/// answer requests and send receipts. Returns the mailbox ids that were handled: the caller deletes them from the
/// mailbox only after it has kept the state, so a crash in between reads them again (copies are recognised by id).
pub fn receive(
    app: &Arc<App>,
    me: &Me<'_>,
    st: &mut State,
    auto_accept: bool,
) -> Result<Vec<i64>, ApiError> {
    let mut done: Vec<i64> = Vec::new();
    let mut after = 0;
    'read: while done.len() < READ_MAX {
        let batch = app
            .db
            .queued(me.device, after, READ_BATCH, now())
            .map_err(ApiError::internal)?;
        let Some(last) = batch.last() else {
            break;
        };
        after = last.0;
        let full = batch.len() >= usize::try_from(READ_BATCH).unwrap_or(usize::MAX);
        let mut receipts: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut stop = false;
        for (mid, env, origin) in &batch {
            // Envelopes from other Murmo servers (federation) are not taken by the bridge (yet).
            if origin.is_some() {
                done.push(*mid);
                continue;
            }
            let Some(plain) = open(me.device, &st.prekeys, env) else {
                done.push(*mid);
                continue;
            };
            match verify_message(app, me, &plain) {
                Ok(m) => match handle(app, me, st, &m, auto_accept, &mut receipts) {
                    Ok(()) => done.push(*mid),
                    // Storage failed: this one and everything after it are read again next time.
                    Err(e) if e.status >= 500 => {
                        stop = true;
                        break;
                    }
                    // An answer that cannot go (the other party has no devices now) does not hold up the mailbox.
                    Err(_) => done.push(*mid),
                },
                Err(Refused::Drop) => done.push(*mid),
                Err(Refused::Later) => {
                    stop = true;
                    break;
                }
            }
        }
        for (peer, ids) in receipts {
            for chunk in ids.chunks(RECEIPT_MAX) {
                let ids: Vec<Value> = chunk.iter().map(Value::from).collect();
                // A receipt that cannot go now is not worth keeping the message for.
                let _ = deliver(
                    app,
                    me,
                    st,
                    &peer,
                    "receipt",
                    Map::new().with("ids", Value::Array(ids)),
                );
            }
        }
        if stop || !full {
            break 'read;
        }
    }
    Ok(done)
}

/// Act on one verified message (`handleMessage` in core.js, for an account with one device and no history).
fn handle(
    app: &Arc<App>,
    me: &Me<'_>,
    st: &mut State,
    m: &Message,
    auto_accept: bool,
    receipts: &mut BTreeMap<String, Vec<String>>,
) -> Result<(), ApiError> {
    let peer = m.from.as_str();
    // Owner only: anyone else is not answered, not acknowledged and never shown to the program.
    if !me.allows(peer) {
        return Ok(());
    }
    let auto_accept = auto_accept || me.only == Some(peer);
    let state = st.contacts.get(peer).map(|c| c.state.clone());
    if state.as_deref() == Some("blocked") {
        return Ok(());
    }
    let accepted = state.as_deref() == Some("accepted");
    let from = who(app, peer);
    let base = |extra: Map| {
        let mut f = Map::new()
            .with("from", from.clone())
            .with("id", m.id.as_str())
            .with("time", m.time);
        for (k, v) in extra.iter() {
            f.insert(k, v.clone());
        }
        f
    };
    match m.kind.as_str() {
        "request" => {
            match state.as_deref() {
                // An accepted contact that asks again has lost its data: it is told that it is accepted.
                Some("accepted") => {
                    deliver(app, me, st, peer, "accept", Map::new())?;
                    return Ok(());
                }
                Some("incoming") => return Ok(()),
                Some("declined") if m.time <= st.contacts.get(peer).map_or(0, |c| c.declined) => {
                    return Ok(());
                }
                _ => {}
            }
            if state.is_none() && st.contacts.len() >= MAX_CONTACTS {
                return Ok(());
            }
            let note = body_str(&m.body, "note", NOTE_MAX).unwrap_or_default();
            let accept = state.as_deref() == Some("outgoing") || auto_accept;
            let declined = st.contacts.get(peer).map_or(0, |c| c.declined);
            st.contacts.insert(
                peer.to_string(),
                Contact {
                    handle: handle_of(app, peer),
                    state: if accept { "accepted" } else { "incoming" }.into(),
                    updated: now(),
                    declined,
                },
            );
            st.seen_before(peer, &m.id);
            if state.as_deref() == Some("outgoing") {
                st.event("accepted", base(Map::new()));
            } else {
                st.event(
                    "request",
                    base(
                        Map::new()
                            .with("note", note.as_str())
                            .with("accepted", accept),
                    ),
                );
            }
            if accept {
                deliver(app, me, st, peer, "accept", Map::new())?;
            }
        }
        "accept" => {
            // Only an answer to the bot's own request.
            if state.as_deref() == Some("outgoing")
                && let Some(c) = st.contacts.get_mut(peer)
            {
                c.state = "accepted".into();
                c.updated = now();
                st.event("accepted", base(Map::new()));
            }
        }
        "text" if accepted => {
            receipts
                .entry(peer.to_string())
                .or_default()
                .push(m.id.clone());
            if !st.seen_before(peer, &m.id) {
                let t = body_str(&m.body, "text", TEXT_MAX).unwrap_or_default();
                st.event("message", base(Map::new().with("text", t.as_str())));
            }
        }
        "receipt" if accepted => {
            let ids: Vec<Value> = m
                .body
                .get("ids")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter(|x| x.as_str().is_some())
                        .take(RECEIPT_MAX)
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            if !ids.is_empty() {
                st.event(
                    "delivered",
                    Map::new()
                        .with("from", from.clone())
                        .with("ids", Value::Array(ids))
                        .with("time", m.time),
                );
            }
        }
        "reaction" if accepted => {
            if let (Some(target), Some(e)) =
                (body_str(&m.body, "id", 64), body_str(&m.body, "e", 16))
            {
                st.event(
                    "reaction",
                    base(
                        Map::new()
                            .with("message", target.as_str())
                            .with("emoji", e.as_str()),
                    ),
                );
            }
        }
        "edit" if accepted => {
            if let (Some(target), Some(t)) = (
                body_str(&m.body, "id", 64),
                body_str(&m.body, "text", TEXT_MAX),
            ) && !t.is_empty()
            {
                st.event(
                    "edit",
                    base(
                        Map::new()
                            .with("message", target.as_str())
                            .with("text", t.as_str()),
                    ),
                );
            }
        }
        "retract" if accepted => {
            if let Some(target) = body_str(&m.body, "id", 64) {
                st.event("retract", base(Map::new().with("message", target.as_str())));
            }
        }
        // Files travel as live chunks the bridge does not take: the API client is told one was offered.
        "file" if accepted && !st.seen_before(peer, &m.id) => {
            let name = body_str(&m.body, "name", 256).unwrap_or_default();
            let size = m.body.get("size").and_then(Value::as_int).unwrap_or(0);
            st.event(
                "file",
                base(Map::new().with("name", name.as_str()).with("size", size)),
            );
        }
        // Disappearing messages are not taken: the bridge cannot make an API client forget them (as an older client
        // drops them, DESIGN.md §12). Everything else is for an account's own devices or not for a bot.
        _ => {}
    }
    Ok(())
}

// ── what the API asks for ───────────────────────────────────────────────────────────────────────────────────────

/// The result of [`send_text`].
pub struct TextSent {
    /// What went out: `text`, or `request` (the text is the request's note).
    pub kind: &'static str,
    /// The send.
    pub sent: Sent,
    /// The contact's state afterwards.
    pub state: String,
}

/// Send a text to `peer`: a text to an accepted contact; accept and then a text for a contact that asked; otherwise
/// a message request whose note is the text.
pub fn send_text(
    app: &Arc<App>,
    me: &Me<'_>,
    st: &mut State,
    peer: &str,
    t: &str,
) -> Result<TextSent, ApiError> {
    if !me.allows(peer) {
        return Err(bad(403, "owner_only"));
    }
    if t.trim().is_empty() {
        return Err(bad(400, "empty"));
    }
    if t.chars().count() > TEXT_MAX {
        return Err(bad(400, "too_long"));
    }
    let state = st.contacts.get(peer).map(|c| c.state.clone());
    match state.as_deref() {
        Some("accepted") => {}
        Some("incoming") => {
            accept(app, me, st, peer)?;
        }
        Some("outgoing") => return Err(bad(409, "not_accepted")),
        Some("blocked") => return Err(bad(409, "blocked")),
        _ => {
            if t.chars().count() > NOTE_MAX {
                return Err(bad(400, "note_too_long"));
            }
            if state.is_none() && st.contacts.len() >= MAX_CONTACTS {
                return Err(bad(409, "too_many_contacts"));
            }
            // A request reaches someone who never wrote to the bot: fewer of those than texts.
            app.limits
                .check(format!("bridge-request:{}", me.account), 30, 3600)?;
            let sent = deliver(app, me, st, peer, "request", Map::new().with("note", t))?;
            let declined = st.contacts.get(peer).map_or(0, |c| c.declined);
            st.contacts.insert(
                peer.to_string(),
                Contact {
                    handle: handle_of(app, peer),
                    state: "outgoing".into(),
                    updated: now(),
                    declined,
                },
            );
            return Ok(TextSent {
                kind: "request",
                sent,
                state: "outgoing".into(),
            });
        }
    }
    let sent = deliver(app, me, st, peer, "text", Map::new().with("text", t))?;
    Ok(TextSent {
        kind: "text",
        sent,
        state: "accepted".into(),
    })
}

/// Accept a message request.
pub fn accept(app: &Arc<App>, me: &Me<'_>, st: &mut State, peer: &str) -> Result<(), ApiError> {
    if !me.allows(peer) {
        return Err(bad(403, "owner_only"));
    }
    match st.contacts.get(peer).map(|c| c.state.as_str()) {
        Some("incoming") => {}
        Some("accepted") => return Ok(()),
        _ => return Err(bad(409, "no_request")),
    }
    deliver(app, me, st, peer, "accept", Map::new())?;
    if let Some(c) = st.contacts.get_mut(peer) {
        c.state = "accepted".into();
        c.updated = now();
    }
    Ok(())
}

/// Decline or block a contact (nothing is sent: the other party is not told). A new contact counts against
/// [`MAX_CONTACTS`], as a request does.
pub fn set_state(st: &mut State, peer: &str, state: &str, app: &App) -> Result<(), ApiError> {
    if !st.contacts.contains_key(peer) && st.contacts.len() >= MAX_CONTACTS {
        return Err(bad(409, "too_many_contacts"));
    }
    let t = now();
    let c = st
        .contacts
        .entry(peer.to_string())
        .or_insert_with(|| Contact {
            handle: handle_of(app, peer),
            state: String::new(),
            updated: t,
            declined: 0,
        });
    c.state = state.to_string();
    c.updated = t;
    if state == "declined" {
        c.declined = t;
    }
    Ok(())
}

// ── making and removing a bot ───────────────────────────────────────────────────────────────────────────────────

/// A new bot, ready to store.
pub struct Created {
    /// Its account.
    pub account: String,
    /// `Name#TAG`.
    pub handle: String,
    /// Its state (device key, first prekey).
    pub state: State,
    /// The recovery card's printable text ([CRD-4]): the only way to retire or take over the identity later.
    pub card_text: String,
    /// The recovery card as a file ([CRD-1]).
    pub card: Value,
}

fn rc_err(e: rootcard::Error) -> ApiError {
    match e {
        rootcard::Error::BadUsername => bad(400, "bad_username"),
        rootcard::Error::UsernamePolicy => bad(400, "username_policy"),
        rootcard::Error::HandleTaken => bad(409, "handle_taken"),
        e => ApiError::internal(format!("bridge: {}", e.code())),
    }
}

/// Make a bot: a rootcard identity at this server's own home (registered as any identity, with a recovery key handed to
/// the owner once and a random password nobody learns), then its device list with the bot's single device, signed by
/// the account key, and the device's first prekey. Blocking (Argon2id for the vault's password lock).
pub fn create(app: &App, username: &str) -> Result<Created, ApiError> {
    use rootcard::account::register;
    use rootcard::recovery::{derive_recovery_keys, new_recovery_key};
    use rootcard::vault::{Kdf, Secret, unlock_vault};

    rootcard::id::check_username(username).map_err(|_| bad(400, "bad_username"))?;
    let realm = app.cfg.realm.clone();
    let mut fill = |b: &mut [u8]| getrandom::fill(b).expect("operating system random generator");
    let rk = new_recovery_key(&realm, username, &mut fill).map_err(rc_err)?;
    // A password nobody needs: the bot never logs in, and the recovery key can reset it.
    let password = Zeroizing::new(base32_encode(&random::<20>()));
    let home = rootcard::log::Home {
        key: app.host.config.key(),
        url: app.local_home(),
    };
    let t = now();
    let reg = register(
        &rk,
        &realm,
        username,
        &password,
        "Bridge",
        &home,
        t,
        Kdf::DEFAULT,
        &mut fill,
    )
    .map_err(rc_err)?;
    let body: Value = Map::new()
        .with("log", Value::Array(reg.log.clone()))
        .with("vault", reg.vault.clone())
        .with("public", reg.public.clone())
        .into();
    app.host.register(&body, t).map_err(|e| {
        if e.storage.is_some() {
            ApiError::internal("bridge: storage")
        } else {
            rc_err(e.error)
        }
    })?;
    let stored = app
        .host
        .store
        .load(&reg.account)
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::internal("bridge: the new identity is not stored"))?;
    let keys = derive_recovery_keys(&rk, &realm, username);
    let unlocked =
        unlock_vault(&reg.vault, &stored.state, &Secret::Recovery(&keys)).map_err(rc_err)?;
    let account_seed = Zeroizing::new(*unlocked.contents.account_seed);
    let account_key = ed25519_public(&account_seed);

    let device_seed = draw_seed();
    let st = State::new(device_seed);
    let dkey = st.device_key();
    let did = device_id(&dkey);
    let entry: Value = sign(
        crate::devices::DEVICES_LABEL,
        Map::new()
            .with("v", 1i64)
            .with("account", reg.account.as_str())
            .with("instance", format_key(KeyType::Ed25519, &account_key))
            .with("seq", 0i64)
            .with("op", "add")
            .with(
                "device",
                Map::new()
                    .with("id", did.as_str())
                    .with("key", format_key(KeyType::Ed25519, &dkey))
                    .with("label", DEVICE_LABEL),
            )
            .with("time", t)
            .with("signer", "account"),
        &account_seed,
    )
    .into();
    let entries = vec![entry];
    verify_list(&reg.account, &account_key, &entries)?;
    if !app
        .db
        .swap_device_list(
            &reg.account,
            &format_key(KeyType::Ed25519, &account_key),
            0,
            &entries,
            &[],
        )
        .map_err(ApiError::internal)?
    {
        return Err(bad(409, "conflict"));
    }
    let mut st = st;
    rotate_prekey(
        app,
        &Me {
            account: &reg.account,
            device: &did,
            only: None,
        },
        &mut st,
    )?;
    let card_text = rootcard::file::card_text(&reg.card).map_err(rc_err)?;
    Ok(Created {
        handle: rootcard::id::handle(username, &reg.account),
        account: reg.account,
        state: st,
        card_text,
        card: reg.card,
    })
}

/// Take the bot's device off its device list (signed by the device itself) and delete its prekey and mailbox: contacts
/// then see an account without devices, and nothing more is queued for it.
pub fn retire_device(app: &App, me: &Me<'_>, st: &State) -> Result<(), ApiError> {
    let cur = app.current(me.account)?;
    let Some(list) = cur.list else {
        return Ok(());
    };
    let Some(dev) = list.device(me.device) else {
        return Ok(());
    };
    let entry: Value = sign(
        crate::devices::DEVICES_LABEL,
        Map::new()
            .with("v", 1i64)
            .with("account", me.account)
            .with("instance", cur.instance.as_str())
            .with("seq", i64::try_from(list.entries.len()).unwrap_or(i64::MAX))
            .with("prev", list.head.as_str())
            .with("op", "remove")
            .with(
                "device",
                Map::new()
                    .with("id", dev.id.as_str())
                    .with("key", format_key(KeyType::Ed25519, &dev.key))
                    .with("label", dev.label.as_str()),
            )
            .with("time", now())
            .with("signer", me.device),
        &st.device_seed,
    )
    .into();
    let mut all = list.entries.clone();
    all.push(entry);
    verify_list(me.account, &cur.account_key, &all)?;
    if !app
        .db
        .swap_device_list(
            me.account,
            &cur.instance,
            list.entries.len(),
            &all,
            &[me.device.to_string()],
        )
        .map_err(ApiError::internal)?
    {
        return Err(bad(409, "conflict"));
    }
    app.hub.disconnect(me.device);
    let note = Map::new()
        .with("t", "devices")
        .with("account", me.account)
        .with("head", crate::devices::entry_hash(&all[all.len() - 1]));
    app.hub
        .to_account(me.account, &Push::Text(text(&note.into())));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trip() {
        let secret = Zeroizing::new([7u8; 32]);
        let spk = x25519_public(&secret);
        let env = seal("dev", "pk1", &spk, b"hello").expect("seal");
        let keys = vec![PrekeySecret {
            id: "pk1".into(),
            secret,
            time: 1,
        }];
        assert_eq!(&open("dev", &keys, &env).expect("open")[..], b"hello");
        // Not for another device, not with another prekey.
        assert!(open("other", &keys, &env).is_none());
        let other = vec![PrekeySecret {
            id: "pk1".into(),
            secret: Zeroizing::new([8u8; 32]),
            time: 1,
        }];
        assert!(open("dev", &other, &env).is_none());
        assert!(open("dev", &keys, "!!").is_none());
    }

    #[test]
    fn state_round_trip_and_binding() {
        let mut st = State::new(Zeroizing::new([9u8; 32]));
        st.prekeys.push(PrekeySecret {
            id: "a".into(),
            secret: Zeroizing::new([1u8; 32]),
            time: 5,
        });
        st.contacts.insert(
            "X".into(),
            Contact {
                handle: "x#ABCD".into(),
                state: "accepted".into(),
                updated: 3,
                declined: 0,
            },
        );
        st.event("message", Map::new().with("text", "hi"));
        st.seen_before("X", "m1");
        let key = [3u8; 32];
        let blob = st.seal(&key, "ACC").expect("seal");
        let back = State::open(&key, "ACC", &blob).expect("open");
        assert_eq!(back.device_id(), st.device_id());
        assert_eq!(back.contacts, st.contacts);
        assert_eq!(back.seq, 1);
        assert_eq!(back.inbox.len(), 1);
        assert_eq!(back.prekeys[0].time, 5);
        // Bound to the account and the key: another bot's row or another server's key does not open it.
        assert!(State::open(&key, "OTHER", &blob).is_err());
        assert!(State::open(&[4u8; 32], "ACC", &blob).is_err());
    }

    /// Declining or blocking through the API counts against the contact limit, as a request does (T53).
    #[test]
    fn declining_counts_against_the_contact_limit() {
        let cfg = crate::app::Config::test();
        let app =
            crate::build(&cfg, crate::db::Db::open(":memory:").expect("db"), [5; 32]).expect("app");
        let mut st = State::new(Zeroizing::new([9u8; 32]));
        for i in 0..MAX_CONTACTS {
            set_state(&mut st, &format!("A{i}"), "blocked", &app).expect("room");
        }
        let full = set_state(&mut st, "NEW", "declined", &app).expect_err("full");
        assert_eq!((full.status, full.code), (409, "too_many_contacts"));
        assert_eq!(st.contacts.len(), MAX_CONTACTS);
        // A contact the bot has already can still change.
        set_state(&mut st, "A0", "declined", &app).expect("known");
        assert_eq!(st.contacts["A0"].state, "declined");
    }

    #[test]
    fn inbox_is_confirmed_and_bounded() {
        let mut st = State::new(Zeroizing::new([9u8; 32]));
        for _ in 0..(INBOX_MAX + 5) {
            st.event("message", Map::new());
        }
        assert_eq!(st.inbox.len(), INBOX_MAX);
        // The oldest five went when the inbox was full; confirming up to 10 drops 6..=10.
        st.confirm(10);
        assert_eq!(st.inbox.len(), INBOX_MAX - 5);
        st.prune(1);
        assert_eq!(st.inbox.len(), INBOX_MAX - 5, "nothing is a day old");
        let taken = st.take(3);
        assert_eq!(taken.len(), 3);
        assert_eq!(st.inbox.len(), INBOX_MAX - 8);
        st.confirm(st.seq - 2);
        assert_eq!(st.inbox.len(), 2);
    }
}
