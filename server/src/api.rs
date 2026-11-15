//! `/api/v1`: server info, exact-identifier lookup, connecting identities from other homes, device lists, prekeys and
//! link requests (DESIGN.md §3, §4, §10).

use crate::app::{App, LINK_TTL, LinkRequest, Push, now, text};
use crate::devices::{DeviceList, parse_device, verify_list, verify_prekey};
use crate::error::{ApiError, json};
use crate::remote;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::Uri;
use axum::response::{IntoResponse, Response};
use rootcard::encoding::base64url_decode_fixed;
use rootcard::json::{Map, Value, parse_limited};
use rootcard::log::VerifyOptions;
use rootcard::proof::verify_proof;
use rootcard_host::store::{HandleKey, IdentityStore};
use std::sync::Arc;

/// Largest request body of this API.
pub const MAX_BODY: usize = 64 * 1024;
/// At most this many entries appended at once.
const MAX_APPEND: usize = 8;
/// A remote identity's log is refreshed when older than this (seconds).
const REMOTE_MAX_AGE: i64 = 300;

pub(crate) fn body_object(body: &Bytes) -> Result<Map, ApiError> {
    if body.len() > MAX_BODY {
        return Err(ApiError::new(413, "too_large"));
    }
    match parse_limited(body, MAX_BODY) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(ApiError::new(400, "bad_json")),
    }
}

pub(crate) fn check_account(account: &str) -> Result<(), ApiError> {
    // 52 characters of strict Crockford base32 ([ID-3]).
    let crockford = |b: u8| {
        b.is_ascii_digit() || (b.is_ascii_uppercase() && !matches!(b, b'I' | b'L' | b'O' | b'U'))
    };
    if account.len() == 52 && account.bytes().all(crockford) {
        Ok(())
    } else {
        Err(ApiError::new(400, "bad_account"))
    }
}

fn respond(r: Result<Response, ApiError>) -> Response {
    r.unwrap_or_else(IntoResponse::into_response)
}

/// Percent-decode a query value.
pub(crate) fn decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(if b[i] == b'+' { b' ' } else { b[i] });
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn query(uri: &Uri, name: &str) -> Option<String> {
    uri.query()?
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == name)
        .and_then(|(_, v)| decode(v))
}

/// `GET /api/v1/info`: what this server accepts.
pub async fn info(State(app): State<Arc<App>>) -> Response {
    let homes: Value = if app.cfg.any_home {
        Value::Array(vec!["*".into()])
    } else {
        Value::Array(
            app.cfg
                .remote_homes
                .iter()
                .map(|h| h.as_str().into())
                .collect(),
        )
    };
    let mut realms: Vec<Value> = vec![app.cfg.realm.as_str().into()];
    for r in &app.cfg.realms {
        if *r != app.cfg.realm {
            realms.push(r.as_str().into());
        }
    }
    let mut m = Map::new()
        .with("v", 1i64)
        .with("origin", app.cfg.origin.as_str())
        .with(
            "origins",
            Value::Array(app.origins().map(Value::from).collect()),
        )
        .with("home", app.local_home())
        .with("realm", app.cfg.realm.as_str())
        .with("realms", Value::Array(realms))
        .with("homes", homes)
        .with("file_queue", app.cfg.file_queue > 0)
        .with("version", env!("CARGO_PKG_VERSION"))
        .with("source", env!("CARGO_PKG_REPOSITORY"));
    if !env!("MURMO_COMMIT").is_empty() {
        m.insert("commit", env!("MURMO_COMMIT").into());
    }
    if app.push.enabled() {
        m.insert("push_key", app.push.public.as_str().into());
    }
    if let Some(build) = client_build(&app.cfg.client_dir) {
        m.insert("build", build.into());
    }
    json(200, &m.into())
}

/// An identifier of the client that is served now: it changes when any file of the client changes, so an open page
/// can offer a reload. Not a security measure. Read from disk at most every 30 seconds.
fn client_build(dir: &str) -> Option<String> {
    use std::hash::Hasher;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static CACHE: Mutex<Option<(Instant, String)>> = Mutex::new(None);

    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                walk(&path, out);
            } else {
                out.push(path);
            }
        }
    }

    if dir.is_empty() {
        return None;
    }
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, build)) = cache.as_ref()
        && at.elapsed() < Duration::from_secs(30)
    {
        return Some(build.clone());
    }
    let mut files = Vec::new();
    walk(std::path::Path::new(dir), &mut files);
    files.sort();
    let mut h = std::hash::DefaultHasher::new();
    for f in &files {
        let Ok(bytes) = std::fs::read(f) else {
            continue;
        };
        h.write(f.to_string_lossy().as_bytes());
        h.write_u64(bytes.len() as u64);
        h.write(&bytes);
    }
    let build = format!("{}-{:016x}", env!("CARGO_PKG_VERSION"), h.finish());
    *cache = Some((Instant::now(), build.clone()));
    Some(build)
}

/// `POST /api/v1/challenge`: a single-use challenge for a rootcard proof.
pub async fn challenge(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
) -> Response {
    respond((|| {
        app.limits.by_addr("challenge", addr, 30, 60)?;
        Ok(json(
            200,
            &Map::new().with("nonce", app.challenges.issue()?).into(),
        ))
    })())
}

/// `GET /api/v1/lookup?handle=Name#TAG[@host]`: an exact identifier among the identities this server knows (its own
/// and connected ones from other homes). There is no search: the full handle is required.
pub async fn lookup(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    uri: Uri,
) -> Response {
    respond((|| {
        app.limits.by_addr("lookup", addr, 20, 60)?;
        let raw = query(&uri, "handle").ok_or(ApiError::new(400, "bad_handle"))?;
        let (handle, host) = match raw.rsplit_once('@') {
            Some((h, d)) => (h.to_string(), Some(d.to_ascii_lowercase())),
            None => (raw, None),
        };
        let h =
            rootcard::id::parse_handle(&handle).map_err(|_| ApiError::new(400, "bad_handle"))?;
        let mut found: Vec<(String, String, String)> = Vec::new(); // account, home, username
        let key = HandleKey {
            realm: app.cfg.realm.clone(),
            username: h.username.to_ascii_lowercase(),
            tag: h.tag.clone(),
        };
        for a in app.host.store.by_handle(&key).map_err(ApiError::internal)? {
            if let Some(s) = app.host.store.load(&a).map_err(ApiError::internal)?
                && s.vault.is_some()
                && h.matches(&s.state.username, &s.state.account)
            {
                let home = s
                    .state
                    .instance
                    .as_ref()
                    .map_or_else(|| app.local_home(), |i| i.home.url.clone());
                found.push((a, home, s.state.username));
            }
        }
        for (a, home, username) in app
            .db
            .find_remote(&key.username, &key.tag)
            .map_err(ApiError::internal)?
        {
            if h.matches(&username, &a) {
                found.push((a, home, username));
            }
        }
        if let Some(host) = &host {
            found.retain(|(_, home, _)| {
                remote::origin_of(home)
                    .is_some_and(|o| o.split("://").nth(1).is_some_and(|x| x == host))
            });
        }
        match found.as_slice() {
            [] => Err(ApiError::new(404, "unknown_account")),
            [(account, home, username)] => Ok(json(
                200,
                &Map::new()
                    .with("account", account.as_str())
                    .with("home", home.as_str())
                    .with(
                        "handle",
                        format!("{username}#{}", rootcard::id::tag(account)),
                    )
                    .into(),
            )),
            _ => Err(ApiError::new(409, "ambiguous_handle")),
        }
    })())
}

/// `POST /api/v1/accounts/{account}/connect` with `{ home }`: make an identity from another allowed home known to this
/// server (the server fetches and verifies its log). For this server's own identities it only answers the home.
pub async fn connect(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    Path(account): Path<String>,
    body: Bytes,
) -> Response {
    let run = async {
        app.limits.by_addr("connect", addr, 30, 3600)?;
        check_account(&account)?;
        if app
            .host
            .store
            .load(&account)
            .map_err(ApiError::internal)?
            .is_none()
        {
            let m = body_object(&body)?;
            let home = m
                .get("home")
                .and_then(Value::as_str)
                .ok_or(ApiError::new(400, "bad_field"))?;
            remote::refresh(&app, &account, Some(home), 0).await?;
        }
        let cur = app.current(&account)?;
        Ok(json(
            200,
            &Map::new()
                .with("account", account.as_str())
                .with("home", cur.home)
                .into(),
        ))
    };
    respond(run.await)
}

/// The public view of a device list with the current prekeys of its devices.
fn list_value(
    app: &App,
    account: &str,
    home: &str,
    instance: &str,
    list: Option<&DeviceList>,
) -> Result<Value, ApiError> {
    let mut prekeys: Vec<Value> = Vec::new();
    if let Some(l) = list {
        for d in &l.present {
            if let Some(p) = app.db.prekey(&d.id).map_err(ApiError::internal)? {
                prekeys.push(p);
            }
        }
    }
    let mut m = Map::new()
        .with("account", account)
        .with("home", home)
        .with("instance", instance)
        .with(
            "entries",
            Value::Array(list.map(|l| l.entries.clone()).unwrap_or_default()),
        )
        .with("prekeys", Value::Array(prekeys));
    if let Some(l) = list {
        m.insert("head", l.head.as_str().into());
    }
    Ok(m.into())
}

/// `GET /api/v1/accounts/{account}/devices`
pub async fn get_devices(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    Path(account): Path<String>,
) -> Response {
    let run = async {
        app.limits.by_addr("devices", addr, 120, 60)?;
        check_account(&account)?;
        remote::refresh_if_remote(&app, &account, REMOTE_MAX_AGE).await;
        let cur = app.current(&account)?;
        Ok(json(
            200,
            &list_value(&app, &account, &cur.home, &cur.instance, cur.list.as_ref())?,
        ))
    };
    respond(run.await)
}

/// `POST /api/v1/accounts/{account}/devices` with `{ entries: [...], prekeys?: [...] }`.
pub async fn post_devices(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    Path(account): Path<String>,
    body: Bytes,
) -> Response {
    let run = async {
        app.limits.by_addr("devices-write", addr, 30, 3600)?;
        check_account(&account)?;
        let m = body_object(&body)?;
        remote::refresh_if_remote(&app, &account, 60).await;
        let new = m
            .get("entries")
            .and_then(Value::as_array)
            .ok_or(ApiError::new(400, "bad_field"))?;
        if new.is_empty() || new.len() > MAX_APPEND {
            return Err(ApiError::new(400, "bad_field"));
        }
        let cur = app.current(&account)?;
        let old_entries = cur
            .list
            .as_ref()
            .map(|l| l.entries.clone())
            .unwrap_or_default();
        let mut all = old_entries.clone();
        all.extend(new.iter().cloned());
        let list = verify_list(&account, &cur.account_key, &all)?;
        let removed: Vec<String> = cur
            .list
            .as_ref()
            .map(|l| {
                l.present
                    .iter()
                    .filter(|d| list.device(&d.id).is_none())
                    .map(|d| d.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        // Prekeys of devices present after the change (the approving device sends the new device's prekey along).
        let mut prekeys = Vec::new();
        if let Some(arr) = m.get("prekeys").and_then(Value::as_array) {
            if arr.len() > crate::devices::MAX_DEVICES {
                return Err(ApiError::new(400, "bad_field"));
            }
            for p in arr {
                let dev_id = p
                    .as_object()
                    .and_then(|o| o.get("device"))
                    .and_then(Value::as_str)
                    .ok_or(ApiError::new(400, "bad_prekey"))?;
                let dev = list
                    .device(dev_id)
                    .ok_or(ApiError::new(400, "bad_prekey"))?;
                prekeys.push(verify_prekey(&account, dev, p)?);
            }
        }
        if !app
            .db
            .swap_device_list(&account, &cur.instance, old_entries.len(), &all, &removed)
            .map_err(ApiError::internal)?
        {
            return Err(ApiError::new(409, "conflict"));
        }
        if !cur.stale.is_empty() {
            app.db
                .drop_devices(&cur.stale)
                .map_err(ApiError::internal)?;
        }
        for p in &prekeys {
            app.db
                .put_prekey(&account, &p.device, &p.value)
                .map_err(ApiError::internal)?;
        }
        for d in &list.present {
            app.links.remove(&account, |r| r.device == d.id);
        }
        for d in &removed {
            app.hub.disconnect(d);
        }
        let note = Map::new()
            .with("t", "devices")
            .with("account", account.as_str())
            .with("head", list.head.as_str());
        app.hub
            .to_account(&account, &Push::Text(text(&note.into())));
        Ok(json(
            200,
            &Map::new().with("head", list.head.as_str()).into(),
        ))
    };
    respond(run.await)
}

/// `POST /api/v1/accounts/{account}/link` with `{ request, proof, nonce }`. The proof (rootcard SPEC §14, by the account
/// key, for a challenge from `/challenge`, to this server's origin) shows that the caller unlocked the account. It works
/// the same for identities from other homes. The request still needs approval on an existing device.
pub async fn post_link(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    Path(account): Path<String>,
    body: Bytes,
) -> Response {
    let run = async {
        app.limits.by_addr("link", addr, 5, 3600)?;
        check_account(&account)?;
        let m = body_object(&body)?;
        remote::refresh_if_remote(&app, &account, 60).await;
        let nonce = m
            .get("nonce")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(400, "bad_field"))?;
        let challenge =
            base64url_decode_fixed::<32>(nonce).map_err(|_| ApiError::new(400, "bad_field"))?;
        if !app.challenges.take(nonce) {
            return Err(ApiError::new(401, "bad_challenge"));
        }
        let proof = m.get("proof").ok_or(ApiError::new(400, "bad_field"))?;
        let by_account = proof
            .as_object()
            .and_then(|p| p.get("by"))
            .and_then(Value::as_str)
            == Some("account");
        let mut realms = app.cfg.realms.clone();
        realms.push(app.cfg.realm.clone());
        let options = VerifyOptions::new(realms).at(now());
        // The proof is for the origin the page was opened on: any of this server's origins.
        let recipient = proof
            .as_object()
            .and_then(|p| p.get("recipient"))
            .and_then(Value::as_str)
            .filter(|r| app.is_origin(r))
            .ok_or(ApiError::new(401, "bad_proof"))?
            .to_string();
        let state = verify_proof(
            proof,
            &app.events(&account)?,
            &challenge,
            &recipient,
            &options,
        )
        .map_err(|_| ApiError::new(401, "bad_proof"))?;
        if state.account != account || !by_account {
            return Err(ApiError::new(401, "bad_proof"));
        }
        let cur = app.current(&account)?;
        if cur.list.is_none() {
            return Err(ApiError::new(409, "no_devices"));
        }
        let req = m
            .get("request")
            .and_then(Value::as_object)
            .ok_or(ApiError::new(400, "bad_field"))?;
        for k in req.keys() {
            if !["v", "account", "id", "device", "prekey", "time"].contains(&k) {
                return Err(ApiError::new(400, "bad_field"));
            }
        }
        if req.get("v").and_then(Value::as_int) != Some(1)
            || req.get("account").and_then(Value::as_str) != Some(account.as_str())
            || req.get("time").and_then(Value::as_int).is_none()
        {
            return Err(ApiError::new(400, "bad_field"));
        }
        let id = req
            .get("id")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(400, "bad_field"))?;
        base64url_decode_fixed::<16>(id).map_err(|_| ApiError::new(400, "bad_field"))?;
        let device = parse_device(req.get("device").ok_or(ApiError::new(400, "bad_field"))?)?;
        if cur.device(&device.id).is_some() {
            return Err(ApiError::new(409, "already_linked"));
        }
        verify_prekey(
            &account,
            &device,
            req.get("prekey").ok_or(ApiError::new(400, "bad_field"))?,
        )?;
        let value: Value = Value::Object(req.clone());
        app.links.add(
            &account,
            LinkRequest {
                id: id.to_string(),
                device: device.id.clone(),
                value: value.clone(),
                expires: now() + LINK_TTL,
            },
        )?;
        let note = Map::new().with("t", "link").with("request", value);
        app.hub
            .to_account(&account, &Push::Text(text(&note.into())));
        Ok(json(
            200,
            &Map::new().with("expires", now() + LINK_TTL).into(),
        ))
    };
    respond(run.await)
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn percent_decoding() {
        assert_eq!(decode("Alice%233F9C").as_deref(), Some("Alice#3F9C"));
        assert_eq!(decode("a+b").as_deref(), Some("a b"));
        assert_eq!(decode("%2"), None);
        assert_eq!(decode("%zz"), None);
    }
}
