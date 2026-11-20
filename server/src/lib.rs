//! murmo-server: a rootcard home and a blind mailbox for end-to-end encrypted messages. The binary (`main.rs`) only
//! calls [`run`]; the library exists so that the fuzz targets in `fuzz/` can reach the parsers (see [`fuzz`]).
//!
//! Configuration (environment):
//!
//! | Variable | Default | Meaning |
//! |---|---|---|
//! | `MURMO_ORIGIN` | `http://127.0.0.1:8080` | public origin (https in production) |
//! | `MURMO_OLD_ORIGINS` | empty | earlier public origins that still reach this server after a move of domain (comma-separated) |
//! | `MURMO_BIND` | `127.0.0.1:8080` | address to listen on |
//! | `MURMO_DB` | `murmo.sqlite` | SQLite database |
//! | `MURMO_HOST_KEY_FILE` | `murmo-host.key` | rootcard host key seed (created on first start, mode 0600) |
//! | `MURMO_CLIENT_DIR` | `client` | static client directory (empty: do not serve a client); unset, `client` in the working directory, else next to the executable |
//! | `MURMO_REALM` | `global` | rootcard realm for new identities |
//! | `MURMO_REMOTE_HOMES` | `https://rootcard.org` | other rootcard homes whose identities may log in (comma-separated origins; `*` for any public https host; empty for none) |
//! | `MURMO_REALMS` | `global` | realms accepted for identities from other homes (comma-separated) |
//! | `MURMO_TRUST_PROXY` | `0` | reverse proxies whose `X-Forwarded-For` is believed: `0` none, `1` loopback and private networks, or a comma-separated list of addresses and CIDR ranges |
//! | `MURMO_LIMIT_SCALE` | `1` | multiply every rate limit (tests only) |
//! | `MURMO_GIPHY_KEY` | empty | GIPHY API key: lets browsers search GIPHY directly for their GIF collection (empty: no search) |
//! | `MURMO_GIPHY_RATING` | `pg-13` | GIPHY content rating for searches (`g`, `pg`, `pg-13`, `r`) |
//! | `MURMO_BETA` | `1` | mark the service as an open beta in the client (`0`: no mark) |
//! | `MURMO_FEDERATION` | `open` | other Murmo servers to exchange messages with: `open` (any public https server), `off`, or a comma-separated list of origins |
//! | `MURMO_FEDERATION_BLOCK` | empty | servers never to exchange messages with (comma-separated origins or host names; each also blocks its other ports and subdomains) |
//! | `MURMO_DEMO` | `0` | mark this server as a demo whose data may be wiped at any time (`1`), as murmo.org |
//!
//! Each variable is also read under its old name, `MESG_…`, when the `MURMO_…` name is not set. The default files
//! `murmo.sqlite` and `murmo-host.key` fall back to `mesg.sqlite` and `mesg-host.key` when only those exist.

#![forbid(unsafe_code)]

pub mod admin;
pub mod api;
pub mod app;
pub mod db;
pub mod devices;
pub mod egress;
pub mod error;
pub mod federation;
pub mod push;
pub mod rc;
pub mod remote;
pub mod ws;

#[doc(hidden)]
pub mod fuzz;

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
        if app.cfg.trust_proxy.is_empty() {
            if parts.headers.contains_key("x-forwarded-for") {
                admin::untrusted_forwarding();
            }
            return Ok(ClientAddr(peer));
        }
        let forwarded = parts
            .headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok());
        Ok(ClientAddr(app::client_addr(
            peer,
            forwarded,
            &app.cfg.trust_proxy,
        )))
    }
}

/// A setting from the environment. `MURMO_X` falls back to `MESG_X`, the name from before the project was renamed.
fn env(name: &str, default: &str) -> String {
    std::env::var(name)
        .or_else(|_| match name.strip_prefix("MURMO_") {
            Some(rest) => std::env::var(format!("MESG_{rest}")),
            None => Err(std::env::VarError::NotPresent),
        })
        .unwrap_or_else(|_| default.to_string())
}

/// A file setting whose default changed with the rename: when it is not set and the new default file does not
/// exist but the old one does (`mesg.sqlite`, `mesg-host.key`), keep using the old file.
fn file_env(name: &str, default: &str, old_default: &str) -> String {
    let v = env(name, "");
    if !v.is_empty() {
        return v;
    }
    let (new, old) = (
        std::path::Path::new(default),
        std::path::Path::new(old_default),
    );
    if !new.exists() && old.exists() {
        eprintln!("{name}: using {old_default} (the default before the rename to murmo)");
        return old_default.to_string();
    }
    default.to_string()
}

/// `MURMO_CLIENT_DIR` as set (empty: no client); unset, `client` in the working directory, else `client` next to the
/// executable (an unpacked release archive started from anywhere), else `client` (and a warning at start).
fn client_dir() -> String {
    if std::env::var_os("MURMO_CLIENT_DIR").is_some()
        || std::env::var_os("MESG_CLIENT_DIR").is_some()
    {
        return env("MURMO_CLIENT_DIR", "client");
    }
    if std::path::Path::new("client").is_dir() {
        return "client".into();
    }
    std::env::current_exe()
        .ok()
        .and_then(|e| Some(e.parent()?.join("client")))
        .filter(|d| d.is_dir())
        .map_or_else(|| "client".into(), |d| d.to_string_lossy().into_owned())
}

/// `murmo-server backup <dir>`: a consistent copy of the database and the host key, from the same environment as the
/// server (also while it runs). See [`admin::backup`].
pub fn backup(dir: &str) -> Result<(), Box<dyn std::error::Error>> {
    let cfg = config()?;
    for f in admin::backup(&cfg, std::path::Path::new(dir))? {
        println!("{}", f.display());
    }
    Ok(())
}

fn list(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect()
}

/// A budget in MiB per minute from the environment, as bytes (at most 4095 MiB, so it fits a rate limit counter).
fn rate_mb(name: &str, default: u32) -> u32 {
    env(name, &default.to_string())
        .parse::<u32>()
        .unwrap_or(default)
        .min(4095)
        * 1024
        * 1024
}

fn megabytes(name: &str, default: i64) -> i64 {
    env(name, &default.to_string())
        .parse::<i64>()
        .unwrap_or(default)
        .clamp(0, 1 << 30)
        * 1024
        * 1024
}

fn config() -> Result<Config, String> {
    Ok(Config {
        origin: env("MURMO_ORIGIN", "http://127.0.0.1:8080")
            .trim_end_matches('/')
            .to_string(),
        old_origins: list(&env("MURMO_OLD_ORIGINS", ""))
            .into_iter()
            .map(|o| o.trim_end_matches('/').to_ascii_lowercase())
            .collect(),
        bind: env("MURMO_BIND", "127.0.0.1:8080"),
        db: file_env("MURMO_DB", "murmo.sqlite", "mesg.sqlite"),
        key_file: file_env("MURMO_HOST_KEY_FILE", "murmo-host.key", "mesg-host.key"),
        client_dir: client_dir(),
        realm: env("MURMO_REALM", "global"),
        realms: list(&env("MURMO_REALMS", "global")),
        remote_homes: list(&env("MURMO_REMOTE_HOMES", "https://rootcard.org"))
            .into_iter()
            .filter(|h| h != "*")
            .map(|h| h.trim_end_matches('/').to_ascii_lowercase())
            .collect(),
        any_home: list(&env("MURMO_REMOTE_HOMES", "https://rootcard.org"))
            .iter()
            .any(|h| h == "*"),
        trust_proxy: app::trusted_proxies(&env("MURMO_TRUST_PROXY", "0"))
            .map_err(|e| format!("MURMO_TRUST_PROXY: {e}"))?,
        limit_scale: env("MURMO_LIMIT_SCALE", "1").parse().unwrap_or(1),
        file_queue: megabytes("MURMO_FILE_QUEUE_MB", 150),
        file_queue_total: megabytes("MURMO_FILE_QUEUE_TOTAL_MB", 2048),
        file_queue_sender: megabytes("MURMO_FILE_QUEUE_SENDER_MB", 50),
        file_queue_account: megabytes("MURMO_FILE_QUEUE_ACCOUNT_MB", 300),
        relay_granted: rate_mb("MURMO_RELAY_GRANTED_MB", 1024),
        relay_store: rate_mb("MURMO_RELAY_STORE_MB", 128),
        push_hosts: list(&env(
            "MURMO_PUSH_HOSTS",
            "fcm.googleapis.com,updates.push.services.mozilla.com,*.push.apple.com,*.notify.windows.com",
        ))
        .into_iter()
        .map(|h| h.trim_end_matches('/').to_ascii_lowercase())
        .collect(),
        push_contact: env("MURMO_PUSH_CONTACT", "")
            .chars()
            .filter(|c| c.is_ascii_graphic() && *c != '"' && *c != '\\')
            .collect(),
        giphy_key: env("MURMO_GIPHY_KEY", "")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(128)
            .collect(),
        giphy_rating: match env("MURMO_GIPHY_RATING", "pg-13").to_ascii_lowercase().as_str() {
            r @ ("g" | "pg" | "pg-13" | "r") => r.to_string(),
            _ => "pg-13".to_string(),
        },
        beta: env("MURMO_BETA", "1") != "0",
        demo: env("MURMO_DEMO", "0") == "1",
        federation: federation::Policy::parse(&env("MURMO_FEDERATION", "open")),
        federation_block: list(&env("MURMO_FEDERATION_BLOCK", ""))
            .iter()
            .filter_map(|o| federation::block_entry(o))
            .collect(),
    })
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
    let ws_origin = app
        .origins()
        .map(|o| o.replacen("http", "ws", 1))
        .collect::<Vec<_>>()
        .join(" ");
    // The page may talk to this server and to the rootcard homes whose identities it accepts (login happens there).
    // The old origins too: an identity made before a move of domain has its home there.
    let homes = if app.cfg.any_home {
        "https:".to_string()
    } else {
        app.cfg
            .remote_homes
            .iter()
            .chain(&app.cfg.old_origins)
            .cloned()
            .collect::<Vec<_>>()
            .join(" ")
    };
    // GIPHY only when the operator configured a key: the browser fetches search results and GIFs itself.
    let giphy = if app.cfg.giphy_key.is_empty() {
        String::new()
    } else {
        app::GIPHY_HOSTS.join(" ")
    };
    let csp = format!(
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; \
         connect-src 'self' {ws_origin} {homes} {giphy}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; \
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
        .route("/api/v1/accounts/{account}/log", get(api::get_log))
        .route("/api/v1/ws", get(ws::upgrade))
        .layer(DefaultBodyLimit::max(api::MAX_BODY))
        // After the general limit, so that this route alone takes a full send.
        .route(
            "/api/v1/federation/deliver",
            post(federation::post_deliver)
                .layer(DefaultBodyLimit::max(federation::MAX_DELIVER_BODY)),
        )
        .route(
            "/api/v1/federation/relay",
            post(federation::post_relay).layer(DefaultBodyLimit::max(federation::MAX_RELAY_BODY)),
        )
        .route(
            "/api/v1/federation/presence",
            post(federation::post_presence),
        )
        .route("/api/v1/federation/space", post(federation::post_space));
    if !app.cfg.client_dir.is_empty() {
        r = r.fallback_service(ServeDir::new(&app.cfg.client_dir));
    }
    r.layer(middleware::from_fn_with_state(
        app.clone(),
        security_headers,
    ))
    .with_state(app)
}

/// The application state for `cfg` over an open database, with the host key `seed`.
pub fn build(
    cfg: &Config,
    db: db::Db,
    seed: [u8; 32],
) -> Result<Arc<App>, Box<dyn std::error::Error>> {
    let host_config = HostConfig {
        key_seed: Zeroizing::new(seed),
        retired_keys: Vec::new(),
        urls: std::iter::once(&cfg.origin)
            .chain(&cfg.old_origins)
            .map(|o| format!("{o}{}", rc::PREFIX))
            .collect(),
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
    let limits = Limiter::persistent(cfg.limit_scale, db.clone())?;
    Ok(Arc::new(App {
        cfg: cfg.clone(),
        push,
        db,
        host,
        hub: Hub::default(),
        links: Links::default(),
        limits,
        challenges: Challenges::default(),
        fed: federation::Federation::new(&seed),
    }))
}

/// Run the server with the configuration from the environment until Ctrl-C or SIGTERM.
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = config()?;
    rootcard::check_base_url(&cfg.origin).map_err(|e| format!("MURMO_ORIGIN: {e}"))?;
    for o in &cfg.old_origins {
        rootcard::check_base_url(o).map_err(|e| format!("MURMO_OLD_ORIGINS: {o}: {e}"))?;
        if o == &cfg.origin {
            return Err("MURMO_OLD_ORIGINS must not contain MURMO_ORIGIN".into());
        }
    }
    let seed = host_key(&cfg.key_file)?;
    admin::upgrade_copy(&cfg.db)?;
    let app = build(&cfg, db::Db::open(&cfg.db)?, seed)?;
    // Pushes that were due when the server stopped.
    push::resume(&app);
    let sweeper = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            if let Err(e) = sweeper.db.purge(now()) {
                eprintln!("purge: {e}");
            }
            for p in admin::prune_upgrade_copies(&sweeper.cfg.db) {
                eprintln!("deleted {}", p.display());
            }
            sweeper.links.sweep();
            sweeper.limits.sweep();
            sweeper.hub.sweep_grants();
            sweeper.fed.sweep();
            if let Err(e) = sweeper.limits.save() {
                eprintln!("rate limits: {e}");
            }
        }
    });

    // Envelopes for servers that could not be reached are tried again (federation).
    let retrier = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(15));
        loop {
            tick.tick().await;
            federation::flush_outbox(&retrier).await;
        }
    });

    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    for line in admin::summary(&cfg, api::client_build(&cfg.client_dir).as_deref()) {
        eprintln!("{line}");
    }
    let last = app.clone();
    axum::serve(
        listener,
        router(app).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    last.limits.save()?;
    Ok(())
}

/// Ctrl-C, or SIGTERM on Unix (systemd, containers).
async fn shutdown() {
    #[cfg(unix)]
    {
        let term = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut s) => {
                    s.recv().await;
                }
                Err(_) => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            () = term => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
