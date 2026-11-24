//! The bridge (optional, `MURMO_BRIDGE=1`, DESIGN.md §16): lets any program talk with Murmo users over HTTPS.
//!
//! An owner logs in at `/bridge/` with a rootcard identity from this server's home or another allowed home (a rootcard
//! proof for a challenge, as for linking a device), makes a **bot**, and gets its address and an **API key**. A bot is an
//! ordinary Murmo account whose one device lives here ([`bot`]); with its key a program sends and receives messages:
//!
//! | Method | Path (under `/bridge/api/v1`) | Auth | Purpose |
//! |---|---|---|---|
//! | POST | `/challenge` | – | single-use challenge for the owner's proof |
//! | POST | `/login` | proof | `{ account, home, nonce, proof }` → owner session |
//! | POST | `/logout` | session | end the session |
//! | GET, POST | `/bots` | session | the owner's bots; make one `{ name, auto_accept?, retention_days?, owner_only? }` |
//! | POST, DELETE | `/bots/{account}` | session | change `{ auto_accept?, retention_days?, owner_only? }`; delete the bot |
//! | POST | `/bots/{account}/key` | session | a new API key (the old one stops working) |
//! | GET | `/me` | API key | the bot's account, handle and address |
//! | GET | `/messages?after=&wait=` | API key | new events, waiting up to `wait` s; deleted when handed out, or kept until confirmed with `after` for at most `retention_days` |
//! | POST | `/messages` | API key | `{ to, text }`: a text, or a message request to someone new |
//! | GET | `/contacts` | API key | contacts and their states |
//! | POST | `/contacts/{account}/{accept,decline,block}` | API key | answer a request |
//!
//! It is apart from everything else: its own pages, its own API, its own sessions, its own table. Nothing of it exists
//! while it is off.

pub mod bot;
pub mod store;

use crate::app::{App, Challenges, Locked, now, random};
use crate::error::{ApiError, json};
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use bot::{Me, State as BotState};
use rootcard::crypto::{frame, hkdf, sha256};
use rootcard::encoding::{base64url_decode_fixed, base64url_encode};
use rootcard::json::{Map, Value};
use rootcard::log::VerifyOptions;
use rootcard::proof::verify_proof;
use rootcard_host::store::IdentityStore;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::{BotRow, Store};
use zeroize::Zeroizing;

/// The path of the bridge's pages and API.
pub const PREFIX: &str = "/bridge";
/// Label of the key that encrypts bot states (derived from the host key).
const KEY_LABEL: &str = "murmo/bridge/key/v1";
/// Label of the stored hash of an API key.
const API_KEY_LABEL: &str = "murmo/bridge/api-key/v1";
/// How an API key starts.
pub const API_KEY_PREFIX: &str = "mbk_";
/// How an owner session token starts.
const SESSION_PREFIX: &str = "mbs_";
/// How long an owner session lasts (seconds).
const SESSION_TTL: i64 = 12 * 3600;
/// The longest a `GET /messages` waits for something to arrive (seconds).
pub const MAX_WAIT: i64 = 30;
/// Most events in one answer.
const MAX_EVENTS: usize = 200;
/// The longest a bot may keep events for its program (days).
pub const MAX_RETENTION: i64 = 30;

/// A boolean member of a request, if given.
fn bool_of(m: &Map, k: &str) -> Result<Option<bool>, ApiError> {
    match m.get(k) {
        None => Ok(None),
        Some(v) => v.as_bool().map(Some).ok_or(ApiError::new(400, "bad_field")),
    }
}

/// `retention_days` of a request: 0 to [`MAX_RETENTION`].
fn retention_of(m: &Map) -> Result<Option<i64>, ApiError> {
    match m.get("retention_days") {
        None => Ok(None),
        Some(v) => v
            .as_int()
            .filter(|d| (0..=MAX_RETENTION).contains(d))
            .map(Some)
            .ok_or(ApiError::new(400, "bad_retention")),
    }
}

/// An owner's session (memory only).
struct Session {
    owner: String,
    handle: String,
    expires: i64,
}

/// The bridge's state in the server.
pub struct Bridge {
    /// Its table.
    pub store: Store,
    /// Encrypts bot states (from the host key, so a backup of database and key has everything).
    key: Zeroizing<[u8; 32]>,
    /// Who may log in: account ids or `Name#TAG` (empty: any identity this server accepts).
    owners: Vec<String>,
    /// Most bots per owner.
    max_bots: usize,
    sessions: Mutex<HashMap<[u8; 32], Session>>,
    challenges: Challenges,
    /// One operation at a time per bot.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// `GET /messages` that wait, per bot.
    waits: Mutex<HashMap<String, usize>>,
}

/// Most `GET /messages` of one bot that wait at once; more answer at once (a program needs one).
const MAX_WAITING: usize = 2;

/// A waiting `GET /messages`, counted while it lives.
struct Waiting<'a> {
    bridge: &'a Bridge,
    account: String,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut g = self.bridge.waits.locked();
        if let Some(n) = g.get_mut(&self.account) {
            *n -= 1;
            if *n == 0 {
                g.remove(&self.account);
            }
        }
    }
}

impl Bridge {
    /// The bridge over the server's database, with a key derived from the host key seed.
    pub fn open(
        db: crate::db::Db,
        host_seed: &[u8; 32],
        owners: Vec<String>,
        max_bots: usize,
    ) -> Result<Bridge, String> {
        Ok(Bridge {
            store: Store::open(db)?,
            key: hkdf(host_seed, b"", KEY_LABEL.as_bytes()),
            owners,
            max_bots,
            sessions: Mutex::new(HashMap::new()),
            challenges: Challenges::default(),
            locks: Mutex::new(HashMap::new()),
            waits: Mutex::new(HashMap::new()),
        })
    }

    fn lock(&self, account: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut g = self.locks.locked();
        g.retain(|_, l| Arc::strong_count(l) > 1);
        g.entry(account.to_string()).or_default().clone()
    }

    fn load(&self, account: &str) -> Result<BotState, ApiError> {
        let blob = self
            .store
            .state(account)
            .map_err(ApiError::internal)?
            .ok_or(ApiError::new(404, "unknown_bot"))?;
        BotState::open(&self.key, account, &blob)
    }

    fn save(&self, account: &str, st: &BotState) -> Result<(), ApiError> {
        self.store
            .put_state(account, &st.seal(&self.key, account)?)
            .map_err(ApiError::internal)
    }

    /// Count a waiting request of `account`, unless it has [`MAX_WAITING`] already.
    fn wait(&self, account: &str) -> Option<Waiting<'_>> {
        let mut g = self.waits.locked();
        let n = g.entry(account.to_string()).or_insert(0);
        if *n >= MAX_WAITING {
            return None;
        }
        *n += 1;
        Some(Waiting {
            bridge: self,
            account: account.to_string(),
        })
    }

    fn sweep(&self) {
        let t = now();
        self.sessions.locked().retain(|_, s| s.expires > t);
    }
}

fn token_hash(label: &str, token: &str) -> [u8; 32] {
    sha256(&frame(label, token.as_bytes()))
}

/// A new API key and the hash that is stored.
fn new_api_key() -> (String, [u8; 32], String) {
    let key = format!("{API_KEY_PREFIX}{}", base64url_encode(&random::<32>()));
    let hint = key[key.len() - 4..].to_string();
    (key.clone(), token_hash(API_KEY_LABEL, &key), hint)
}

fn bridge(app: &App) -> Result<&Bridge, ApiError> {
    app.bridge.as_ref().ok_or(ApiError::new(404, "not_found"))
}

fn respond(r: Result<Response, ApiError>) -> Response {
    r.unwrap_or_else(IntoResponse::into_response)
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
}

/// The owner of a session.
fn owner(app: &App, headers: &HeaderMap) -> Result<(String, String), ApiError> {
    let b = bridge(app)?;
    let t = bearer(headers)
        .filter(|t| t.starts_with(SESSION_PREFIX))
        .ok_or(ApiError::new(401, "unauthorized"))?;
    let g = b.sessions.locked();
    match g.get(&token_hash(SESSION_PREFIX, t)) {
        Some(s) if s.expires > now() => Ok((s.owner.clone(), s.handle.clone())),
        _ => Err(ApiError::new(401, "unauthorized")),
    }
}

/// The bot of an API key.
fn bot_of(app: &App, headers: &HeaderMap, addr: std::net::IpAddr) -> Result<BotRow, ApiError> {
    let b = bridge(app)?;
    app.limits.by_addr("bridge-api", addr, 600, 60)?;
    let k = bearer(headers)
        .filter(|t| t.starts_with(API_KEY_PREFIX) && t.len() <= 128)
        .ok_or(ApiError::new(401, "unauthorized"))?;
    match b
        .store
        .by_key(&token_hash(API_KEY_LABEL, k))
        .map_err(ApiError::internal)?
    {
        Some(row) => Ok(row),
        None => {
            // Keys cannot be guessed, but a client that keeps sending a wrong one is told to stop.
            app.limits.by_addr("bridge-bad-key", addr, 30, 600)?;
            Err(ApiError::new(401, "unauthorized"))
        }
    }
}

/// The bot `account` of this owner.
fn owned(app: &App, owner: &str, account: &str) -> Result<BotRow, ApiError> {
    match bridge(app)?
        .store
        .get(account)
        .map_err(ApiError::internal)?
    {
        Some(r) if r.owner == owner => Ok(r),
        _ => Err(ApiError::new(404, "unknown_bot")),
    }
}

/// The address a user types to reach an account of this server: `Name#TAG@host`.
fn address(app: &App, handle: &str) -> String {
    match app.cfg.origin.split("://").nth(1) {
        Some(host) => format!("{handle}@{host}"),
        None => handle.to_string(),
    }
}

fn bot_value(app: &App, r: &BotRow) -> Value {
    Map::new()
        .with("account", r.account.as_str())
        .with("handle", r.handle.as_str())
        .with("address", address(app, &r.handle))
        .with("device", r.device.as_str())
        .with("created", r.created)
        .with("auto_accept", r.auto_accept)
        .with("owner_only", r.owner_only)
        .with("retention_days", r.retention)
        .with("key_hint", r.key_hint.as_str())
        .with("key_created", r.key_created)
        .into()
}

fn query(uri: &Uri, name: &str) -> Option<String> {
    uri.query()?
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == name)
        .and_then(|(_, v)| crate::api::decode(v))
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// The bridge's routes: its pages from `<client dir>/bridge` and its API. Without the bridge, `/bridge` is not found.
pub fn routes(app: &Arc<App>) -> Router<Arc<App>> {
    if app.bridge.is_none() {
        let gone = any(|| async { ApiError::new(404, "not_found") });
        return Router::new()
            .route(PREFIX, gone.clone())
            .route(&format!("{PREFIX}/"), gone.clone())
            .route(&format!("{PREFIX}/{{*rest}}"), gone);
    }
    let api = |p: &str| format!("{PREFIX}/api/v1{p}");
    let mut r = Router::new()
        .route(&api("/challenge"), post(challenge))
        .route(&api("/login"), post(login))
        .route(&api("/logout"), post(logout))
        .route(&api("/bots"), get(list_bots).post(create_bot))
        .route(&api("/bots/{account}"), post(change_bot).delete(delete_bot))
        .route(&api("/bots/{account}/key"), post(rotate_key))
        .route(&api("/me"), get(me))
        .route(&api("/messages"), get(messages).post(send))
        .route(&api("/contacts"), get(contacts))
        .route(&api("/contacts/{account}/{action}"), post(contact_action))
        .route(
            &api("/{*rest}"),
            any(|| async { ApiError::new(404, "not_found") }),
        );
    // The pages (`/bridge` itself is redirected to `/bridge/` by the file service).
    if !app.cfg.client_dir.is_empty() {
        let dir = std::path::Path::new(&app.cfg.client_dir).join("bridge");
        r = r.nest_service(PREFIX, tower_http::services::ServeDir::new(dir));
    }
    r
}

/// Background work: a fresh prekey for every bot whose newest is a week old (so that a bot whose program is away still
/// receives), and expired sessions. Every hour.
pub async fn maintain(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_secs(3600));
    loop {
        tick.tick().await;
        let Some(b) = app.bridge.as_ref() else {
            return;
        };
        b.sweep();
        for account in b.store.all().unwrap_or_default() {
            let lock = b.lock(&account);
            let _g = lock.lock().await;
            let Ok(Some(row)) = b.store.get(&account) else {
                continue;
            };
            let r = (|| {
                let mut st = b.load(&account)?;
                let before = st.inbox.len();
                st.prune(row.retention);
                if bot::rotate_prekey(&app, &Me::of(&row), &mut st)? || st.inbox.len() != before {
                    b.save(&account, &st)?;
                }
                Ok::<(), ApiError>(())
            })();
            if let Err(e) = r {
                eprintln!("bridge: a bot's prekey: {}", e.code); // no account id (DESIGN.md §11)
            }
        }
    }
}

// ── owners ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// `POST /bridge/api/v1/challenge`
async fn challenge(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
) -> Response {
    respond((|| {
        let b = bridge(&app)?;
        app.limits.by_addr("bridge-challenge", addr, 30, 60)?;
        Ok(json(
            200,
            &Map::new().with("nonce", b.challenges.issue()?).into(),
        ))
    })())
}

/// `POST /bridge/api/v1/login` with `{ account, home, nonce, proof }`: a rootcard proof (SPEC §14) by the identity, for
/// the challenge, addressed to `<origin>/bridge`. The log is this server's for its own identities, otherwise fetched
/// from the home (an allowed one) and verified here; it is not kept.
async fn login(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    body: Bytes,
) -> Response {
    let run = async {
        let b = bridge(&app)?;
        app.limits.by_addr("bridge-login", addr, 10, 60)?;
        let m = crate::api::body_object(&body)?;
        let field = |k: &str| {
            m.get(k)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or(ApiError::new(400, "bad_field"))
        };
        let (account, home, nonce) = (field("account")?, field("home")?, field("nonce")?);
        crate::api::check_account(&account)?;
        let challenge =
            base64url_decode_fixed::<32>(&nonce).map_err(|_| ApiError::new(400, "bad_field"))?;
        if !b.challenges.take(&nonce) {
            return Err(ApiError::new(401, "bad_challenge"));
        }
        let proof = m.get("proof").ok_or(ApiError::new(400, "bad_field"))?;
        let recipient = proof
            .as_object()
            .and_then(|p| p.get("recipient"))
            .and_then(Value::as_str)
            .filter(|r| app.origins().any(|o| *r == format!("{o}{PREFIX}")))
            .ok_or(ApiError::new(401, "bad_proof"))?
            .to_string();
        let events = if app.is_local_home(&home) {
            app.host
                .store
                .load(&account)
                .map_err(ApiError::internal)?
                .ok_or(ApiError::new(404, "unknown_account"))?
                .events
        } else {
            let (events, _) = crate::remote::fetch_verified(&app, &account, &home).await?;
            // A home must not take an identity this server knows back to an older log ([VER-4]).
            match app.db.remote(&account).map_err(ApiError::internal)? {
                Some(kept) => match rootcard::log::compare_logs(&kept.events, &events)
                    .map_err(|_| ApiError::new(502, "bad_log"))?
                {
                    rootcard::log::LogOrder::Older => kept.events,
                    rootcard::log::LogOrder::Fork => return Err(ApiError::new(409, "fork")),
                    _ => events,
                },
                None => events,
            }
        };
        let mut realms = app.cfg.realms.clone();
        realms.push(app.cfg.realm.clone());
        let state = verify_proof(
            proof,
            &events,
            &challenge,
            &recipient,
            &VerifyOptions::new(realms).at(now()),
        )
        .map_err(|_| ApiError::new(401, "bad_proof"))?;
        if state.account != account {
            return Err(ApiError::new(401, "bad_proof"));
        }
        // An own identity must still live here (not moved away).
        if app.is_local_home(&home)
            && state
                .instance
                .as_ref()
                .is_none_or(|i| !app.is_local_home(&i.home.url))
        {
            return Err(ApiError::new(409, "not_home"));
        }
        let handle = rootcard::id::handle(&state.username, &account);
        if b.store.is_bot(&account).map_err(ApiError::internal)? {
            return Err(ApiError::new(403, "is_bot"));
        }
        if !b.owners.is_empty() && !b.owners.iter().any(|o| owner_matches(o, &account)) {
            return Err(ApiError::new(403, "not_allowed"));
        }
        let token = format!("{SESSION_PREFIX}{}", base64url_encode(&random::<32>()));
        let expires = now() + SESSION_TTL;
        b.sweep();
        b.sessions.locked().insert(
            token_hash(SESSION_PREFIX, &token),
            Session {
                owner: account.clone(),
                handle: handle.clone(),
                expires,
            },
        );
        Ok(json(
            200,
            &Map::new()
                .with("token", token)
                .with("account", account.as_str())
                .with("handle", handle)
                .with("expires", expires)
                .with("max_bots", i64::try_from(b.max_bots).unwrap_or(0))
                .into(),
        ))
    };
    respond(run.await)
}

/// Whether an entry of `MURMO_BRIDGE_OWNERS` names this identity: account ids only. A `Name#TAG` is not enough, since
/// a 4-character tag can be found for any name by trying recovery keys.
fn owner_matches(entry: &str, account: &str) -> bool {
    entry == account
}

/// `POST /bridge/api/v1/logout`
async fn logout(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    respond((|| {
        let b = bridge(&app)?;
        if let Some(t) = bearer(&headers) {
            b.sessions.locked().remove(&token_hash(SESSION_PREFIX, t));
        }
        Ok(json(200, &Map::new().into()))
    })())
}

/// `GET /bridge/api/v1/bots`
async fn list_bots(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    respond((|| {
        let (owner, handle) = owner(&app, &headers)?;
        let b = bridge(&app)?;
        let bots: Vec<Value> = b
            .store
            .by_owner(&owner)
            .map_err(ApiError::internal)?
            .iter()
            .map(|r| bot_value(&app, r))
            .collect();
        Ok(json(
            200,
            &Map::new()
                .with(
                    "owner",
                    Map::new()
                        .with("account", owner.as_str())
                        .with("handle", handle),
                )
                .with("bots", Value::Array(bots))
                .with("max_bots", i64::try_from(b.max_bots).unwrap_or(0))
                .into(),
        ))
    })())
}

/// `POST /bridge/api/v1/bots` with `{ name, auto_accept?, retention_days?, owner_only? }`: a new bot. The answer has the API key and the recovery card,
/// both shown once: the bridge keeps neither.
async fn create_bot(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    let run = async {
        let (owner, _) = owner(&app, &headers)?;
        let b = bridge(&app)?;
        let m = crate::api::body_object(&body)?;
        let name = m
            .get("name")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(400, "bad_field"))?
            .trim()
            .to_string();
        let auto_accept = m
            .get("auto_accept")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let retention = retention_of(&m)?.unwrap_or(0);
        let owner_only = bool_of(&m, "owner_only")?.unwrap_or(false);
        if b.store.by_owner(&owner).map_err(ApiError::internal)?.len() >= b.max_bots {
            return Err(ApiError::new(409, "too_many_bots"));
        }
        // Each bot is a registration (Argon2id on this server): per owner, and for all owners together.
        app.limits.charge(
            &[
                (format!("bridge-create:{owner}"), 1, 10),
                ("bridge-create".to_string(), 1, 60),
            ],
            3600,
        )?;
        let app2 = app.clone();
        let created = tokio::task::spawn_blocking(move || bot::create(&app2, &name))
            .await
            .map_err(ApiError::internal)??;
        let (key, hash, hint) = new_api_key();
        let t = now();
        let row = BotRow {
            account: created.account.clone(),
            owner,
            handle: created.handle.clone(),
            device: created.state.device_id(),
            created: t,
            auto_accept,
            key_hint: hint,
            key_created: t,
            retention,
            owner_only,
        };
        b.store
            .insert(&row, &hash, &created.state.seal(&b.key, &row.account)?)
            .map_err(ApiError::internal)?;
        Ok(json(
            201,
            &Map::new()
                .with("bot", bot_value(&app, &row))
                .with("api_key", key)
                .with("card_text", created.card_text)
                .with("card", created.card)
                .into(),
        ))
    };
    respond(run.await)
}

/// `POST /bridge/api/v1/bots/{account}` with `{ auto_accept?, retention_days?, owner_only? }`.
async fn change_bot(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(account): Path<String>,
    body: Bytes,
) -> Response {
    let run = async {
        let (owner, _) = owner(&app, &headers)?;
        owned(&app, &owner, &account)?;
        let m = crate::api::body_object(&body)?;
        let on = bool_of(&m, "auto_accept")?;
        let only = bool_of(&m, "owner_only")?;
        let days = retention_of(&m)?;
        if on.is_none() && days.is_none() && only.is_none() {
            return Err(ApiError::new(400, "bad_field"));
        }
        let b = bridge(&app)?;
        if let Some(only) = only {
            b.store
                .set_owner_only(&account, only)
                .map_err(ApiError::internal)?;
        }
        if let Some(on) = on {
            b.store
                .set_auto_accept(&account, on)
                .map_err(ApiError::internal)?;
        }
        if let Some(days) = days {
            b.store
                .set_retention(&account, days)
                .map_err(ApiError::internal)?;
            // A shorter time applies to what is kept already.
            let row = owned(&app, &owner, &account)?;
            with_bot(&app, &row, |_, _, _| Ok(())).await?;
        }
        let row = owned(&app, &owner, &account)?;
        Ok(json(
            200,
            &Map::new().with("bot", bot_value(&app, &row)).into(),
        ))
    };
    respond(run.await)
}

/// `POST /bridge/api/v1/bots/{account}/key`: a new API key; the old one stops working at once.
async fn rotate_key(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(account): Path<String>,
) -> Response {
    respond((|| {
        let (owner, _) = owner(&app, &headers)?;
        owned(&app, &owner, &account)?;
        let (key, hash, hint) = new_api_key();
        bridge(&app)?
            .store
            .set_key(&account, &hash, &hint, now())
            .map_err(ApiError::internal)?;
        let row = owned(&app, &owner, &account)?;
        Ok(json(
            200,
            &Map::new()
                .with("bot", bot_value(&app, &row))
                .with("api_key", key)
                .into(),
        ))
    })())
}

/// `DELETE /bridge/api/v1/bots/{account}`: the bot's device leaves its device list, its prekey and mailbox are deleted,
/// and so is its state. The rootcard identity stays at this home; the recovery card retires it (rootcard's key tool).
async fn delete_bot(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(account): Path<String>,
) -> Response {
    let run = async {
        let (owner, _) = owner(&app, &headers)?;
        let row = owned(&app, &owner, &account)?;
        let b = bridge(&app)?;
        let lock = b.lock(&account);
        let _g = lock.lock().await;
        let st = b.load(&account)?;
        bot::retire_device(&app, &Me::of(&row), &st)?;
        b.store.delete(&account).map_err(ApiError::internal)?;
        Ok(json(200, &Map::new().into()))
    };
    respond(run.await)
}

// ── bots ────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Run `f` on the bot's state after reading its mailbox, and keep the state.
async fn with_bot<T>(
    app: &Arc<App>,
    row: &BotRow,
    f: impl FnOnce(&Arc<App>, &Me<'_>, &mut BotState) -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    let b = bridge(app)?;
    let lock = b.lock(&row.account);
    let _g = lock.lock().await;
    let mut st = b.load(&row.account)?;
    let me = Me::of(row);
    bot::rotate_prekey(app, &me, &mut st)?;
    let done = bot::receive(app, &me, &mut st, row.auto_accept)?;
    st.prune(row.retention);
    let out = f(app, &me, &mut st);
    // Kept also when `f` failed; only then is what was read deleted from the mailbox.
    b.save(&row.account, &st)?;
    app.db.ack(&row.device, &done).map_err(ApiError::internal)?;
    out
}

/// `GET /bridge/api/v1/me`
async fn me(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    headers: HeaderMap,
) -> Response {
    respond((|| {
        let row = bot_of(&app, &headers, addr)?;
        Ok(json(200, &bot_value(&app, &row)))
    })())
}

/// `GET /bridge/api/v1/messages?after=<seq>&wait=<seconds>`: new events, oldest first. With `wait`, an empty answer
/// comes only after that long (at most 30 s) without news.
///
/// A bot with retention 0 (the default) forgets events as it hands them out: nothing it has delivered stays on the
/// server, and an answer that is lost on the way is lost. A bot with `retention_days` keeps them until the program
/// confirms them (`after`: every event up to that `seq`), and never longer than that many days.
async fn messages(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let run = async {
        let row = bot_of(&app, &headers, addr)?;
        let num = |k: &str| {
            query(&uri, k).map(|v| {
                v.parse::<i64>()
                    .map_err(|_| ApiError::new(400, "bad_field"))
            })
        };
        let after = num("after").transpose()?.unwrap_or(0).max(0);
        let mut wait = num("wait").transpose()?.unwrap_or(0).clamp(0, MAX_WAIT);
        let b = bridge(&app)?;
        let _waiting = if wait > 0 {
            let w = b.wait(&row.account);
            if w.is_none() {
                wait = 0;
            }
            w
        } else {
            None
        };
        let until = now() + wait;
        loop {
            let (events, last) = with_bot(&app, &row, |_, _, st| {
                let events: Vec<Value> = if row.retention == 0 {
                    st.take(MAX_EVENTS)
                } else {
                    st.confirm(after);
                    st.inbox.iter().take(MAX_EVENTS).cloned().collect()
                };
                Ok((events, st.seq))
            })
            .await?;
            if !events.is_empty() || now() >= until {
                let next = events
                    .last()
                    .and_then(Value::as_object)
                    .and_then(|m| m.get("seq"))
                    .and_then(Value::as_int)
                    .unwrap_or(after.min(last));
                return Ok(json(
                    200,
                    &Map::new()
                        .with("events", Value::Array(events))
                        .with("next", next)
                        .into(),
                ));
            }
            // Wait for an envelope without opening the state every second.
            while now() < until {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if !app
                    .db
                    .queued(&row.device, 0, 1, now())
                    .map_err(ApiError::internal)?
                    .is_empty()
                {
                    break;
                }
            }
        }
    };
    respond(run.await)
}

/// The account of `to`: an account id of an identity this server knows, or an exact `Name#TAG[@host]`.
fn recipient(app: &App, bot: &str, to: &str) -> Result<String, ApiError> {
    if crate::api::check_account(to).is_ok() {
        app.current(to)?;
        return Ok(to.to_string());
    }
    // As `/api/v1/lookup`: identifiers cannot be tried in bulk.
    app.limits.check(format!("bridge-lookup:{bot}"), 20, 60)?;
    Ok(crate::api::find_handle(app, to)?.account)
}

/// `POST /bridge/api/v1/messages` with `{ to, text }`.
async fn send(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let run = async {
        let row = bot_of(&app, &headers, addr)?;
        app.limits
            .check(format!("bridge-send:{}", row.account), 60, 60)?;
        let m = crate::api::body_object(&body)?;
        let to = m
            .get("to")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(400, "bad_field"))?;
        let t = m
            .get("text")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(400, "bad_field"))?;
        let peer = recipient(&app, &row.account, to)?;
        crate::remote::refresh_if_remote(&app, &peer, 300).await;
        let r = with_bot(&app, &row, |app, me, st| {
            bot::send_text(app, me, st, &peer, t)
        })
        .await?;
        Ok(json(
            200,
            &Map::new()
                .with("id", r.sent.id)
                .with("time", r.sent.time)
                .with("kind", r.kind)
                .with(
                    "to",
                    Map::new()
                        .with("account", peer.as_str())
                        .with("handle", bot::handle_of(&app, &peer)),
                )
                .with("state", r.state)
                .with("queued", i64::try_from(r.sent.queued).unwrap_or(0))
                .with(
                    "failed",
                    Value::Array(r.sent.failed.into_iter().map(Value::from).collect()),
                )
                .into(),
        ))
    };
    respond(run.await)
}

/// `GET /bridge/api/v1/contacts`
async fn contacts(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    headers: HeaderMap,
) -> Response {
    let run = async {
        let row = bot_of(&app, &headers, addr)?;
        let list = with_bot(&app, &row, |_, _, st| {
            Ok(st
                .contacts
                .iter()
                .map(|(a, c)| {
                    Map::new()
                        .with("account", a.as_str())
                        .with("handle", c.handle.as_str())
                        .with("state", c.state.as_str())
                        .with("updated", c.updated)
                        .into()
                })
                .collect::<Vec<Value>>())
        })
        .await?;
        Ok(json(
            200,
            &Map::new().with("contacts", Value::Array(list)).into(),
        ))
    };
    respond(run.await)
}

/// `POST /bridge/api/v1/contacts/{account}/{accept|decline|block}`
async fn contact_action(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    headers: HeaderMap,
    Path((account, action)): Path<(String, String)>,
) -> Response {
    let run = async {
        let row = bot_of(&app, &headers, addr)?;
        crate::api::check_account(&account)?;
        let state = with_bot(&app, &row, |app, me, st| {
            match action.as_str() {
                "accept" => bot::accept(app, me, st, &account)?,
                "decline" => bot::set_state(st, &account, "declined", app)?,
                "block" => bot::set_state(st, &account, "blocked", app)?,
                _ => return Err(ApiError::new(404, "not_found")),
            }
            Ok(st
                .contacts
                .get(&account)
                .map(|c| c.state.clone())
                .unwrap_or_default())
        })
        .await?;
        Ok(json(
            200,
            &Map::new()
                .with("account", account.as_str())
                .with("state", state)
                .into(),
        ))
    };
    respond(run.await)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The routes fit together with the rest of the server, with and without pages, on and off.
    #[test]
    fn routes_build() {
        for (bridge, client) in [(true, "client"), (true, ""), (false, "client"), (false, "")] {
            let mut cfg = crate::app::Config::test();
            cfg.bridge = bridge;
            cfg.client_dir = client.into();
            let db = crate::db::Db::open(":memory:").expect("db");
            let app = crate::build(&cfg, db, [5; 32]).expect("app");
            assert_eq!(app.bridge.is_some(), bridge);
            let _ = crate::router(app);
        }
    }

    #[test]
    fn owners_by_account_only() {
        let acct = "3F9CABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRS";
        assert!(owner_matches(acct, acct));
        assert!(!owner_matches("Alice#3F9C", acct));
    }

    #[test]
    fn api_keys_are_random_and_hashed() {
        let (a, ha, hint) = new_api_key();
        let (b, hb, _) = new_api_key();
        assert!(a.starts_with(API_KEY_PREFIX) && a.len() == API_KEY_PREFIX.len() + 43);
        assert_ne!(a, b);
        assert_ne!(ha, hb);
        assert_eq!(ha, token_hash(API_KEY_LABEL, &a));
        assert!(a.ends_with(&hint));
        // A session token never authenticates as an API key: other label, other prefix.
        assert_ne!(token_hash(SESSION_PREFIX, &a), ha);
    }
}
