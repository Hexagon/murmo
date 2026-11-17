//! The rootcard home, mounted at `<origin>/id` (rootcard HOST_PROTOCOL.md), with rate limits in front ([HST-16]).

use crate::app::{App, now};
use crate::error::ApiError;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rootcard_host::http::{Request, route, well_known};
use std::sync::Arc;

/// The path prefix of the rootcard base URL.
pub const PREFIX: &str = "/id";

/// The limits a rootcard request falls under (HOST_PROTOCOL.md §6): `(name, max, window seconds)` per network
/// address, and optionally per identity for vault fetches (failed fetches are online password guesses, T11).
fn limits_for(method: &Method, path: &str) -> Vec<(String, u32, i64, bool)> {
    let p = path.split('?').next().unwrap_or("");
    let account = p.split('/').nth(3).unwrap_or("").to_string();
    let post = method == Method::POST;
    if p.ends_with("/id/lookup") {
        vec![("lookup".into(), 20, 60, false)]
    } else if p.ends_with("/id/register") {
        vec![("register".into(), 5, 3600, false)]
    } else if post && p.ends_with("/fetch") {
        vec![
            ("fetch".into(), 30, 3600, false),
            (format!("fetch-account:{account}"), 10, 3600, true),
        ]
    } else if post && p.ends_with("/challenge") {
        vec![("challenge".into(), 10, 60, false)]
    } else if post && p.ends_with("/login") {
        vec![("login".into(), 10, 60, false)]
    } else if p.ends_with("/locks") {
        vec![("locks".into(), 30, 3600, false)]
    } else if post && (p.ends_with("/events") || p.ends_with("/instance")) {
        vec![("events".into(), 30, 3600, false)]
    } else {
        vec![("rootcard".into(), 120, 60, false)]
    }
}

/// Convert a rootcard response.
fn respond(res: rootcard_host::http::Response) -> Response {
    let status = StatusCode::from_u16(res.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = res.body.unwrap_or_default();
    let has_body = !body.is_empty();
    let mut out = (status, body).into_response();
    let h = out.headers_mut();
    if has_body {
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
    }
    for (k, v) in res.headers {
        if let (Ok(k), Ok(v)) = (HeaderName::try_from(k), HeaderValue::try_from(v)) {
            h.insert(k, v);
        }
    }
    out
}

/// Every request below `/id`.
pub async fn handle(
    State(app): State<Arc<App>>,
    crate::ClientAddr(addr): crate::ClientAddr,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let full = uri.path_and_query().map_or(uri.path(), |p| p.as_str());
    let Some(rel) = full.strip_prefix(PREFIX) else {
        return ApiError::new(404, "not_found").into_response();
    };
    if method != Method::OPTIONS {
        for (what, max, window, per_identity) in limits_for(&method, rel) {
            let r = if per_identity {
                app.limits.check(what, max, window)
            } else {
                app.limits.by_addr(&what, addr, max, window)
            };
            if let Err(e) = r {
                return e.into_response();
            }
        }
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string);
    let req = Request {
        method: method.to_string(),
        path: rel.to_string(),
        bearer,
        peer: None,
        body: body.to_vec(),
    };
    // A log change can start a new instance (reset, restore, move): devices of the old one are then disconnected.
    let changed_account = (method == Method::POST)
        .then(|| instance_change(rel))
        .flatten()
        .map(str::to_string);
    let app2 = app.clone();
    let res = tokio::task::spawn_blocking(move || {
        route(&app2.host, &req, now(), &mut |b| {
            b.copy_from_slice(&random_vec(b.len()));
        })
    })
    .await;
    match res {
        Ok(r) => {
            if let Some(account) = changed_account
                && (200..300).contains(&r.status)
            {
                app.disconnect_stale(&account);
            }
            respond(r)
        }
        Err(e) => ApiError::internal(e).into_response(),
    }
}

/// The account of a request that may change its instance: `POST /<version>/id/{account}/instance` or `.../events`.
fn instance_change(path: &str) -> Option<&str> {
    let p = path.split('?').next().unwrap_or("");
    match p.split('/').collect::<Vec<_>>()[..] {
        ["", _, "id", account, "instance" | "events"] if !account.is_empty() => Some(account),
        _ => None,
    }
}

fn random_vec(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    getrandom::fill(&mut v).expect("operating system random generator");
    v
}

/// `GET /.well-known/rootcard` ([HST-23]).
pub async fn pointer(State(app): State<Arc<App>>, headers: axum::http::HeaderMap) -> Response {
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok());
    respond(well_known(&app.host.config, app.origin_for_host(host)))
}

#[cfg(test)]
mod tests {
    use super::instance_change;

    #[test]
    fn instance_changes() {
        assert_eq!(instance_change("/v0/id/abc/instance"), Some("abc"));
        assert_eq!(instance_change("/v0/id/abc/events"), Some("abc"));
        assert_eq!(instance_change("/v0/id/abc/vault"), None);
        assert_eq!(instance_change("/v0/id//instance"), None);
        assert_eq!(instance_change("/v0/id/register"), None);
    }
}
