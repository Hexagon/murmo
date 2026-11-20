//! What an operator sees and runs besides the server itself: the version, `backup`, the copy of the database before a
//! start that changes its schema, and the summary printed at start (docs/HOSTING.md, "Backups and updates").

use crate::app::Config;
use crate::db::{self, SCHEMA_VERSION, Schema};
use crate::federation::Policy;
use std::path::{Path, PathBuf};

/// How long a copy made before a schema change is kept: long enough to go back after an update that went wrong, short
/// enough that envelopes in it do not outlive the mailbox by much (DESIGN.md §11).
pub const UPGRADE_COPY_KEEP: i64 = 7 * 24 * 3600;

/// At most this many copies made before schema changes are kept (the newest).
pub const UPGRADE_COPIES: usize = 2;

/// `murmo-server 0.2.0 (commit …)`.
pub fn version() -> String {
    let commit = env!("MURMO_COMMIT");
    if commit.is_empty() {
        format!("murmo-server {}", env!("CARGO_PKG_VERSION"))
    } else {
        format!(
            "murmo-server {} (commit {commit})",
            env!("CARGO_PKG_VERSION")
        )
    }
}

fn io(e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

/// A file created only if it does not exist, readable by its owner only (Unix).
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}

/// `murmo-server backup <dir>`: a consistent copy of the live database and the host key into `dir` (created if it
/// does not exist), as `murmo.sqlite` and `murmo-host.key`. Refuses to overwrite. Returns the files written.
pub fn backup(cfg: &Config, dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    if !Path::new(&cfg.db).exists() {
        return Err(io(format!("no database at {}", cfg.db)));
    }
    let key = std::fs::read(&cfg.key_file)
        .map_err(|e| io(format!("the host key {}: {e}", cfg.key_file)))?;
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir)?;
    let (db_to, key_to) = (dir.join("murmo.sqlite"), dir.join("murmo-host.key"));
    for p in [&db_to, &key_to] {
        if p.exists() {
            return Err(io(format!("{} exists already", p.display())));
        }
    }
    // The key first: a copy of the database without its key is worth little.
    std::io::Write::write_all(&mut create_private(&key_to)?, &key)?;
    if let Err(e) = db::copy_into(&cfg.db, &db_to.to_string_lossy()) {
        let _ = std::fs::remove_file(&key_to);
        let _ = std::fs::remove_file(&db_to);
        return Err(io(format!("copying {}: {e}", cfg.db)));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&db_to, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(vec![db_to, key_to])
}

/// The copies made before schema changes, next to the database `db`, newest first.
fn upgrade_copies(db: &str) -> Vec<(PathBuf, std::time::SystemTime)> {
    let path = Path::new(db);
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let prefix = format!(
        "{}.before-",
        path.file_name().unwrap_or_default().to_string_lossy()
    );
    let mut out: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
        .collect();
    out.sort_by_key(|e| std::cmp::Reverse(e.1));
    out
}

/// Delete copies made before schema changes beyond the newest [`UPGRADE_COPIES`], and those older than
/// [`UPGRADE_COPY_KEEP`]. Returns the files deleted.
pub fn prune_upgrade_copies(db: &str) -> Vec<PathBuf> {
    let now = std::time::SystemTime::now();
    let keep = std::time::Duration::from_secs(UPGRADE_COPY_KEEP.unsigned_abs());
    upgrade_copies(db)
        .into_iter()
        .enumerate()
        .filter(|(i, (_, at))| {
            *i >= UPGRADE_COPIES || now.duration_since(*at).is_ok_and(|age| age > keep)
        })
        .filter_map(|(_, (p, _))| std::fs::remove_file(&p).ok().map(|()| p))
        .collect()
}

/// Before a start that changes the schema of the database `db`: copy it to `<db>.before-<version>` and say so. A start
/// that would not change it does nothing; a database from a newer server is only warned about. Called before the
/// database is opened for use.
pub fn upgrade_copy(db: &str) -> std::io::Result<()> {
    match db::schema_of(db).map_err(|e| io(format!("reading {db}: {e}")))? {
        Schema::New | Schema::Current => {}
        Schema::Older(v) => {
            let base = format!("{db}.before-{}", env!("CARGO_PKG_VERSION"));
            let to = if Path::new(&base).exists() {
                format!("{base}-{}", crate::app::now())
            } else {
                base
            };
            db::copy_into(db, &to).map_err(|e| {
                io(format!(
                    "the database schema changes ({v} → {SCHEMA_VERSION}), and copying it to {to} first failed: {e}. \
                     Nothing was changed; make room and start again"
                ))
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&to, std::fs::Permissions::from_mode(0o600))?;
            }
            eprintln!(
                "the database schema changes ({v} → {SCHEMA_VERSION}): copied it to {to} first, kept for a week \
                 (to go back, stop the server and put that file in place of {db})"
            );
        }
        Schema::Newer(v) => eprintln!(
            "warning: {db} is from a newer murmo-server (schema {v}; this one writes {SCHEMA_VERSION}). It may work, \
             but the safe way back is the copy that version made before it changed the database ({db}.before-…)"
        ),
    }
    for p in prune_upgrade_copies(db) {
        eprintln!("deleted {}", p.display());
    }
    Ok(())
}

fn is_loopback_bind(bind: &str) -> bool {
    bind.parse::<std::net::SocketAddr>()
        .map(|a| a.ip().is_loopback())
        .unwrap_or_else(|_| bind.starts_with("localhost:"))
}

/// The lines printed at start: what the server serves and where its data is, then warnings about settings that look
/// wrong. `client_build` is the identifier of the client served (`None`: no client).
pub fn summary(cfg: &Config, client_build: Option<&str>) -> Vec<String> {
    let mut out = vec![version(), format!("  origin      {}", cfg.origin)];
    if !cfg.old_origins.is_empty() {
        out.push(format!("  also for    {}", cfg.old_origins.join(", ")));
    }
    out.push(format!("  listening   {}", cfg.bind));
    out.push(format!("  database    {}", cfg.db));
    out.push(format!(
        "  host key    {}   (back up these two: murmo-server backup <dir>)",
        cfg.key_file
    ));
    let fed = match &cfg.federation {
        Policy::Off => "off".to_string(),
        Policy::Open => "open".to_string(),
        Policy::Allow(o) => format!("only {}", o.join(", ")),
    };
    let blocked = if cfg.federation_block.is_empty() {
        String::new()
    } else {
        format!(", {} blocked", cfg.federation_block.len())
    };
    out.push(format!("  federation  {fed}{blocked}"));
    let found = Path::new(&cfg.client_dir).join("index.html").is_file();
    out.push(match (cfg.client_dir.as_str(), client_build) {
        ("", _) => "  client      none (MURMO_CLIENT_DIR is empty)".to_string(),
        (dir, Some(b)) if found => format!("  client      {dir} (build {b})"),
        (dir, _) => format!("  client      {dir} (missing)"),
    });
    for w in warnings(cfg) {
        out.push(format!("warning: {w}"));
    }
    out
}

/// Settings that look wrong, each as one sentence.
pub fn warnings(cfg: &Config) -> Vec<String> {
    let mut out = Vec::new();
    if cfg.origin.starts_with("http://") && !is_loopback_bind(&cfg.bind) {
        out.push(format!(
            "MURMO_ORIGIN is {}, but the server listens on {}: browsers elsewhere get no secure context and cannot \
             use Murmo. Put a TLS proxy in front and set an https:// origin",
            cfg.origin, cfg.bind
        ));
    }
    if !cfg.client_dir.is_empty() && !Path::new(&cfg.client_dir).join("index.html").is_file() {
        out.push(format!(
            "no client in {} (no index.html): the server answers the API only. Set MURMO_CLIENT_DIR to the client \
             directory",
            cfg.client_dir
        ));
    }
    out
}

/// Said at most once an hour when requests carry `X-Forwarded-For` but no proxy is trusted: everyone behind the proxy
/// then shares its address for rate limits.
pub fn untrusted_forwarding() {
    crate::app::log_every(
        "x-forwarded-for",
        3600,
        "warning: requests carry X-Forwarded-For, but MURMO_TRUST_PROXY=0: everyone behind the proxy shares its \
         address for rate limits. Set MURMO_TRUST_PROXY=1 (proxies on this machine or a private network) or the \
         proxy's address",
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "murmo-admin-{name}-{}-{}",
            std::process::id(),
            crate::app::now()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("temp dir");
        d
    }

    #[test]
    fn a_start_that_changes_the_schema_copies_the_database_first() {
        let d = tmp("upgrade");
        let path = d.join("murmo.sqlite");
        let p = path.to_string_lossy().to_string();
        assert_eq!(db::schema_of(&p).expect("schema"), Schema::New);
        upgrade_copy(&p).expect("nothing to copy");
        drop(db::Db::open(&p).expect("open"));
        assert_eq!(db::schema_of(&p).expect("schema"), Schema::Current);
        // A database from before versions were kept.
        let c = rusqlite::Connection::open(&p).expect("conn");
        c.execute_batch(
            "PRAGMA user_version = 0; CREATE TABLE marker (x); INSERT INTO marker VALUES (42);",
        )
        .expect("old");
        drop(c);
        assert_eq!(db::schema_of(&p).expect("schema"), Schema::Older(0));
        upgrade_copy(&p).expect("copy");
        let copy = format!("{p}.before-{}", env!("CARGO_PKG_VERSION"));
        let c = rusqlite::Connection::open(&copy).expect("copy opens");
        let x: i64 = c
            .query_row("SELECT x FROM marker", [], |r| r.get(0))
            .expect("row");
        assert_eq!(x, 42);
        drop(c);
        // Opening it upgrades it; the next start copies nothing.
        drop(db::Db::open(&p).expect("open"));
        upgrade_copy(&p).expect("no copy");
        assert_eq!(upgrade_copies(&p).len(), 1);
        // A newer server's version is kept, not lowered.
        let c = rusqlite::Connection::open(&p).expect("conn");
        c.execute_batch(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 1))
            .expect("newer");
        drop(c);
        drop(db::Db::open(&p).expect("open"));
        assert_eq!(
            db::schema_of(&p).expect("schema"),
            Schema::Newer(SCHEMA_VERSION + 1)
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn only_the_newest_copies_are_kept() {
        let d = tmp("prune");
        let p = d.join("murmo.sqlite").to_string_lossy().to_string();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        for (i, name) in ["a", "b", "c"].iter().enumerate() {
            let f = std::fs::File::create(format!("{p}.before-0.{name}")).expect("file");
            f.set_modified(old + std::time::Duration::from_secs(i as u64))
                .expect("time");
        }
        let gone = prune_upgrade_copies(&p);
        assert_eq!(gone.len(), 1);
        assert!(gone[0].to_string_lossy().ends_with(".before-0.a"));
        // Older than a week: gone whatever their number.
        let week = std::time::SystemTime::now()
            - std::time::Duration::from_secs(UPGRADE_COPY_KEEP.unsigned_abs() + 60);
        std::fs::File::options()
            .write(true)
            .open(format!("{p}.before-0.b"))
            .expect("open")
            .set_modified(week)
            .expect("time");
        assert_eq!(prune_upgrade_copies(&p).len(), 1);
        assert_eq!(upgrade_copies(&p).len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn backup_copies_the_database_and_key_and_never_overwrites() {
        let d = tmp("backup");
        let db_path = d.join("murmo.sqlite").to_string_lossy().to_string();
        let key = d.join("murmo-host.key").to_string_lossy().to_string();
        let db = db::Db::open(&db_path).expect("open");
        db.conn()
            .expect("conn")
            .execute_batch("CREATE TABLE marker (x); INSERT INTO marker VALUES (7);")
            .expect("marker");
        std::fs::write(&key, "00".repeat(32)).expect("key");
        let cfg = Config {
            db: db_path,
            key_file: key,
            ..crate::app::Config::test()
        };
        // While the database is open, as on a running server.
        let to = d.join("copy");
        let files = backup(&cfg, &to).expect("backup");
        assert_eq!(files.len(), 2);
        let c = rusqlite::Connection::open(to.join("murmo.sqlite")).expect("copy");
        let x: i64 = c
            .query_row("SELECT x FROM marker", [], |r| r.get(0))
            .expect("row");
        assert_eq!(x, 7);
        assert_eq!(
            std::fs::read_to_string(to.join("murmo-host.key")).expect("key"),
            "00".repeat(32)
        );
        assert!(backup(&cfg, &to).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn warnings_name_settings_that_look_wrong() {
        let mut cfg = crate::app::Config::test();
        cfg.origin = "http://127.0.0.1:8080".into();
        cfg.bind = "127.0.0.1:8080".into();
        cfg.client_dir = String::new();
        assert!(warnings(&cfg).is_empty());
        cfg.bind = "0.0.0.0:8080".into();
        assert!(warnings(&cfg)[0].contains("secure context"));
        cfg.origin = "https://chat.example".into();
        cfg.client_dir = "/nonexistent/client".into();
        let w = warnings(&cfg);
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("no client"));
        assert!(summary(&cfg, None).iter().any(|l| l.contains("federation")));
    }
}
