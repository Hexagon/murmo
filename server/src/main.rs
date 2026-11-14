//! mesg-server: a rootcard home and a blind mailbox for end-to-end encrypted messages.
//!
//! Configuration (environment):
//!
//! | Variable | Default | Meaning |
//! |---|---|---|
//! | `MESG_ORIGIN` | `http://127.0.0.1:8080` | public origin (https in production) |
//! | `MESG_BIND` | `127.0.0.1:8080` | address to listen on |
//! | `MESG_DB` | `mesg.sqlite` | SQLite database |
//! | `MESG_HOST_KEY_FILE` | `mesg-host.key` | rootcard host key seed (created on first start, mode 0600) |
//! | `MESG_CLIENT_DIR` | `client` | static client directory (empty: do not serve a client) |
//! | `MESG_REALM` | `global` | rootcard realm for new identities |
//! | `MESG_REMOTE_HOMES` | `https://rootcard.org` | other rootcard homes whose identities may log in (comma-separated origins; `*` for any public https host; empty for none) |
//! | `MESG_REALMS` | `global` | realms accepted for identities from other homes (comma-separated) |
//! | `MESG_TRUST_PROXY` | `0` | take the client address from the last `X-Forwarded-For` hop |
//! | `MESG_LIMIT_SCALE` | `1` | multiply every rate limit (tests only) |

#![forbid(unsafe_code)]

mod api;
mod app;
mod db;
mod devices;
mod error;
mod push;
mod rc;
mod remote;
mod ws;

use app::{App, Challenges, Config, Hub, Limiter, Links, now, random};
use axum::Router;
use axum::extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{any, get, post};
use rootcard::encoding::{hex_decode, hex_encode};
use rootcard_host::store::{MemoryChallengeStore, MemorySessionStore};
use rootcard_host::{Host, HostConfig, RealmConfig, UsernamePolicy};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tower_http::services::ServeDir;
use zeroize::Zeroizing;

/// The client's network address (for rate limits only; never stored).
pub struct ClientAddr(pub IpAddr);

impl FromRequestParts<Arc<App>> for ClientAddr {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        app: &Arc<App>,
    ) -> Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map_or(IpAddr::from([0, 0, 0, 0]), |c| c.0.ip());
        if app.cfg.trust_proxy
            && let Some(ip) = parts
                .headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.rsplit(',').next())
                .and_then(|v| v.trim().parse::<IpAddr>().ok())
        {
            return Ok(ClientAddr(ip));
        }
        Ok(ClientAddr(peer))
    }
}

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn list(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect()
}

fn megabytes(name: &str, default: i64) -> i64 {
    env(name, &default.to_string())
        .parse::<i64>()
        .unwrap_or(default)
        .clamp(0, 1 << 30)
        * 1024
        * 1024
}

fn config() -> Config {
    Config {
        origin: env("MESG_ORIGIN", "http://127.0.0.1:8080")
            .trim_end_matches('/')
            .to_string(),
        bind: env("MESG_BIND", "127.0.0.1:8080"),
        db: env("MESG_DB", "mesg.sqlite"),
        key_file: env("MESG_HOST_KEY_FILE", "mesg-host.key"),
        client_dir: env("MESG_CLIENT_DIR", "client"),
        realm: env("MESG_REALM", "global"),
        realms: list(&env("MESG_REALMS", "global")),
        remote_homes: list(&env("MESG_REMOTE_HOMES", "https://rootcard.org"))
            .into_iter()
            .filter(|h| h != "*")
            .map(|h| h.trim_end_matches('/').to_ascii_lowercase())
            .collect(),
        any_home: list(&env("MESG_REMOTE_HOMES", "https://rootcard.org"))
            .iter()
            .any(|h| h == "*"),
        trust_proxy: env("MESG_TRUST_PROXY", "0") == "1",
        limit_scale: env("MESG_LIMIT_SCALE", "1").parse().unwrap_or(1),
        file_queue: megabytes("MESG_FILE_QUEUE_MB", 150),
        file_queue_total: megabytes("MESG_FILE_QUEUE_TOTAL_MB", 2048),
        push_hosts: list(&env(
            "MESG_PUSH_HOSTS",
            "fcm.googleapis.com,updates.push.services.mozilla.com,*.push.apple.com,*.notify.windows.com",
        ))
        .into_iter()
        .map(|h| h.trim_end_matches('/').to_ascii_lowercase())
        .collect(),
        push_contact: env("MESG_PUSH_CONTACT", "")
            .chars()
            .filter(|c| c.is_ascii_graphic() && *c != '"' && *c != '\\')
            .collect(),
    }
}

/// Load the host key seed, or create it (mode 0600) on first start.
fn host_key(path: &str) -> std::io::Result<[u8; 32]> {
    match std::fs::read_to_string(path) {
        Ok(s) => hex_decode(s.trim())
            .ok()
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .ok_or_else(|| std::io::Error::other("host key file must hold 64 hex characters")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let seed = random::<32>();
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?;
            f.write_all(hex_encode(&seed).as_bytes())?;
            eprintln!("created a new host key in {path}: keep it secret and back it up");
            Ok(seed)
        }
        Err(e) => Err(e),
    }
}

/// Security headers on every response (rootcard GETTING_STARTED §2.4).
async fn security_headers(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    let api = req.uri().path().starts_with("/api/") || req.uri().path().starts_with(rc::PREFIX);
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    let ws_origin = app.cfg.origin.replacen("http", "ws", 1);
    // The page may talk to this server and to the rootcard homes whose identities it accepts (login happens there).
    let homes = if app.cfg.any_home {
        "https:".to_string()
    } else {
        app.cfg.remote_homes.join(" ")
    };
    let csp = format!(
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; \
         connect-src 'self' {ws_origin} {homes}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; \
         frame-ancestors 'none'"
    );
    if let Ok(v) = HeaderValue::from_str(&csp) {
        h.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        "cross-origin-opener-policy",
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=(), interest-cohort=()"),
    );
    if app.cfg.origin.starts_with("https://") {
        h.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=63072000; includeSubDomains"),
        );
    }
    if api && !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    } else if !api {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    res
}

/// Build the router (also used by tests).
pub fn router(app: Arc<App>) -> Router {
    let mut r = Router::new()
        .route("/.well-known/rootcard", get(rc::pointer))
        .route(
            "/id/{*rest}",
            any(rc::handle).layer(DefaultBodyLimit::max(rootcard_host::http::MAX_BODY)),
        )
        .route(
            "/api/v1/accounts/{account}/devices",
            get(api::get_devices).post(api::post_devices),
        )
        .route("/api/v1/accounts/{account}/link", post(api::post_link))
        .route("/api/v1/accounts/{account}/connect", post(api::connect))
        .route("/api/v1/info", get(api::info))
        .route("/api/v1/challenge", post(api::challenge))
        .route("/api/v1/lookup", get(api::lookup))
        .route("/api/v1/ws", get(ws::upgrade))
        .layer(DefaultBodyLimit::max(api::MAX_BODY));
    if !app.cfg.client_dir.is_empty() {
        r = r.fallback_service(ServeDir::new(&app.cfg.client_dir));
    }
    r.layer(middleware::from_fn_with_state(
        app.clone(),
        security_headers,
    ))
    .with_state(app)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = config();
    rootcard::check_base_url(&cfg.origin).map_err(|e| format!("MESG_ORIGIN: {e}"))?;
    let seed = host_key(&cfg.key_file)?;
    let db = db::Db::open(&cfg.db)?;
    let host_config = HostConfig {
        key_seed: Zeroizing::new(seed),
        retired_keys: Vec::new(),
        urls: vec![format!("{}{}", cfg.origin, rc::PREFIX)],
        realms: vec![RealmConfig {
            realm: cfg.realm.clone(),
            policy: UsernamePolicy::DEFAULT,
        }],
        peers: Vec::new(),
    };
    host_config
        .check()
        .map_err(|e| format!("rootcard host configuration: {e}"))?;
    let host = Host::new(
        host_config,
        db::Identities(db.clone()),
        MemoryChallengeStore::new(),
        MemorySessionStore::new(),
    );
    let contact = if cfg.push_contact.is_empty() {
        cfg.origin.clone()
    } else {
        cfg.push_contact.clone()
    };
    let push = push::Pusher::open(&db, cfg.push_hosts.clone(), contact)?;
    let app = Arc::new(App {
        cfg: cfg.clone(),
        push,
        db,
        host,
        hub: Hub::default(),
        links: Links::default(),
        limits: Limiter::scaled(cfg.limit_scale),
        challenges: Challenges::default(),
    });

    let sweeper = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(300));
        loop {
            tick.tick().await;
            if let Err(e) = sweeper.db.purge(now()) {
                eprintln!("purge: {e}");
            }
            sweeper.links.sweep();
            sweeper.limits.sweep();
        }
    });

    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    eprintln!("mesg-server for {} on {}", cfg.origin, cfg.bind);
    axum::serve(
        listener,
        router(app).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
