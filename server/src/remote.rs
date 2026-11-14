//! Identities whose rootcard home is another host, such as rootcard.org (DESIGN.md §3.1).
//!
//! The server fetches such an identity's log from its home, verifies it itself (the log is self-certifying: every
//! event is signed by the recovery key) and keeps the newest version it has seen. It never moves back to an older log
//! and refuses forks ([VER-4]). Only homes on the configured allowlist are contacted, so clients cannot make the server
//! fetch arbitrary addresses.

use crate::app::{App, now};
use crate::error::ApiError;
use rootcard::json::{Value, parse_limited};
use rootcard::log::{LogOrder, VerifyOptions, compare_logs, verify_log};
use std::sync::Arc;
use std::time::Duration;

/// Largest log answer accepted from a home.
const MAX_LOG: usize = 4 * 1024 * 1024;

/// The origin (`scheme://host[:port]`) of a base URL.
pub fn origin_of(base: &str) -> Option<String> {
    let start = base.find("://")? + 3;
    let end = base[start..].find('/').map_or(base.len(), |i| start + i);
    Some(base[..end].to_ascii_lowercase())
}

/// Whether the server may contact this home. `base` must be a rootcard base URL ([HST-22]).
pub fn allowed(app: &App, base: &str) -> bool {
    if rootcard::check_base_url(base).is_err() {
        return false;
    }
    let Some(origin) = origin_of(base) else {
        return false;
    };
    if app.cfg.any_home {
        // Any public https host; never an IP literal (no requests to internal addresses by number).
        let host = origin.trim_start_matches("https://");
        return origin.starts_with("https://")
            && host.contains('.')
            && !host.starts_with('[')
            && host
                .split(':')
                .next()
                .is_some_and(|h| h.parse::<std::net::Ipv4Addr>().is_err());
    }
    app.cfg.remote_homes.contains(&origin)
}

/// Fetch an identity's log from its home (blocking; call from a blocking task).
fn fetch_log(base: &str, account: &str) -> Result<Vec<Value>, ApiError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    let url = format!("{base}/{}/id/{account}/log", rootcard::API_VERSION);
    let mut res = agent
        .get(&url)
        .call()
        .map_err(|_| ApiError::new(502, "home_unreachable"))?;
    if res.status().as_u16() == 404 {
        return Err(ApiError::new(404, "unknown_account"));
    }
    if res.status().as_u16() != 200 {
        return Err(ApiError::new(502, "home_error"));
    }
    let body = res
        .body_mut()
        .with_config()
        .limit(MAX_LOG as u64)
        .read_to_vec()
        .map_err(|_| ApiError::new(502, "home_error"))?;
    let v = parse_limited(&body, MAX_LOG).map_err(|_| ApiError::new(502, "home_error"))?;
    v.as_object()
        .and_then(|m| m.get("events"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or(ApiError::new(502, "home_error"))
}

/// Fetch, verify and store the newest log of a remote identity, unless the stored copy is younger than `max_age`
/// seconds. `home` names the home for an identity the server has not seen yet.
pub async fn refresh(
    app: &Arc<App>,
    account: &str,
    home: Option<&str>,
    max_age: i64,
) -> Result<(), ApiError> {
    let stored = app.db.remote(account).map_err(ApiError::internal)?;
    if let Some(r) = &stored
        && now() - r.fetched < max_age
    {
        return Ok(());
    }
    let base = match (home, &stored) {
        (Some(h), _) => h.to_string(),
        (None, Some(r)) => r.home.clone(),
        (None, None) => return Err(ApiError::new(404, "unknown_account")),
    };
    if !allowed(app, &base) {
        return Err(ApiError::new(403, "home_not_allowed"));
    }
    let (b, a) = (base.clone(), account.to_string());
    let events = tokio::task::spawn_blocking(move || fetch_log(&b, &a))
        .await
        .map_err(ApiError::internal)??;
    let options = VerifyOptions::new(app.cfg.realms.clone()).at(now());
    let state = verify_log(&events, &options).map_err(|_| ApiError::new(502, "bad_log"))?;
    if state.account != account {
        return Err(ApiError::new(502, "bad_log"));
    }
    let inst = state
        .instance
        .as_ref()
        .ok_or(ApiError::new(410, "account_retired"))?;
    if inst.home.url != base {
        // The identity lives elsewhere now; follow it only to another allowed home.
        if !allowed(app, &inst.home.url) {
            return Err(ApiError::new(409, "not_home"));
        }
    }
    if let Some(r) = &stored {
        match compare_logs(&r.events, &events).map_err(|_| ApiError::new(502, "bad_log"))? {
            LogOrder::Same | LogOrder::Newer => {}
            LogOrder::Older => {
                // Never move back ([VER-4]); keep what we have and remember that we checked.
                app.db
                    .touch_remote(account, now())
                    .map_err(ApiError::internal)?;
                return Ok(());
            }
            LogOrder::Fork => return Err(ApiError::new(409, "fork")),
        }
    }
    app.db
        .put_remote(account, &inst.home.url, &events, &state, now())
        .map_err(ApiError::internal)?;
    Ok(())
}

/// Refresh a remote identity if it is one (errors are ignored: the cached log is used).
pub async fn refresh_if_remote(app: &Arc<App>, account: &str, max_age: i64) {
    if app.db.remote(account).ok().flatten().is_some() {
        let _ = refresh(app, account, None, max_age).await;
    }
}

#[cfg(test)]
mod tests {
    use super::origin_of;

    #[test]
    fn origins() {
        assert_eq!(
            origin_of("https://rootcard.org").as_deref(),
            Some("https://rootcard.org")
        );
        assert_eq!(
            origin_of("https://Example.com/id").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            origin_of("http://127.0.0.1:8080/id").as_deref(),
            Some("http://127.0.0.1:8080")
        );
    }
}
