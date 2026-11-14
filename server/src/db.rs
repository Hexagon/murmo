//! SQLite storage: rootcard identities (the home's only persistent rootcard state), device lists, prekeys and the
//! mailbox. One connection behind a mutex: every change is atomic, which is the compare-and-swap rootcard needs
//! ([HST-19]). `secure_delete` overwrites deleted rows, so delivered ciphertext does not linger in free pages.

use rootcard::json::{Value, canonical, parse_json};
use rootcard::log::LogState;
use rootcard_host::store::{Expected, HandleKey, IdentityStore, Insert, StoreError, Stored};
use rusqlite::{Connection, OptionalExtension, params};
use std::sync::{Arc, Mutex, MutexGuard};

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA secure_delete = ON;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS identities (
  account     TEXT PRIMARY KEY,
  realm       TEXT NOT NULL,
  username_lc TEXT NOT NULL,
  tag         TEXT NOT NULL,
  claimed     INTEGER NOT NULL,
  events      TEXT NOT NULL,
  state       TEXT NOT NULL,
  vault       TEXT,
  public      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS identities_claim ON identities (realm, username_lc, tag) WHERE claimed = 1;
CREATE INDEX IF NOT EXISTS identities_handle ON identities (realm, username_lc, tag);
CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS device_lists (
  account  TEXT PRIMARY KEY,
  instance TEXT NOT NULL,
  entries  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prekeys (
  device  TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  prekey  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mailbox (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  device  TEXT NOT NULL,
  env     TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mailbox_device ON mailbox (device, id);
CREATE TABLE IF NOT EXISTS remote_ids (
  account     TEXT PRIMARY KEY,
  home        TEXT NOT NULL,
  username_lc TEXT NOT NULL,
  tag         TEXT NOT NULL,
  events      TEXT NOT NULL,
  state       TEXT NOT NULL,
  fetched     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS remote_ids_handle ON remote_ids (username_lc, tag);
";

/// A cached remote identity (its home is another rootcard host).
pub struct Remote {
    /// The home's base URL.
    pub home: String,
    /// The newest verified log seen.
    pub events: Vec<Value>,
    /// Its state.
    pub state: LogState,
    /// When it was last fetched.
    pub fetched: i64,
}

/// The database. Cheap to clone.
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

fn store_err<E: std::fmt::Display>(e: E) -> StoreError {
    StoreError(e.to_string())
}

fn text(v: &Value) -> String {
    String::from_utf8(canonical(v)).unwrap_or_default()
}

fn value(s: &str) -> Result<Value, StoreError> {
    parse_json(s.as_bytes()).map_err(store_err)
}

impl Db {
    /// Open (and create) the database at `path` (`:memory:` for tests).
    pub fn open(path: &str) -> rusqlite::Result<Db> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    /// The connection.
    pub fn conn(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.0
            .lock()
            .map_err(|_| StoreError("lock poisoned".into()))
    }

    // ── device lists ────────────────────────────────────────────────────────────────────────────────────────────

    /// The stored device list: `(instance, entries)`.
    pub fn device_list(&self, account: &str) -> Result<Option<(String, Vec<Value>)>, StoreError> {
        let c = self.conn()?;
        let row: Option<(String, String)> = c
            .query_row(
                "SELECT instance, entries FROM device_lists WHERE account = ?1",
                params![account],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(store_err)?;
        match row {
            None => Ok(None),
            Some((instance, entries)) => match value(&entries)? {
                Value::Array(a) => Ok(Some((instance, a))),
                _ => Err(StoreError("corrupt device list".into())),
            },
        }
    }

    /// Replace the device list if it still has `expected_len` entries for `instance` (0: none or another instance).
    /// Removed devices lose their prekeys and their queued envelopes in the same step.
    pub fn swap_device_list(
        &self,
        account: &str,
        instance: &str,
        expected_len: usize,
        entries: &[Value],
        removed: &[String],
    ) -> Result<bool, StoreError> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(store_err)?;
        let current: Option<(String, String)> = tx
            .query_row(
                "SELECT instance, entries FROM device_lists WHERE account = ?1",
                params![account],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(store_err)?;
        let len = match &current {
            Some((i, e)) if i == instance => value(e)?.as_array().map_or(0, Vec::len),
            _ => 0,
        };
        if len != expected_len {
            return Ok(false);
        }
        let all = text(&Value::Array(entries.to_vec()));
        tx.execute(
            "INSERT INTO device_lists (account, instance, entries) VALUES (?1, ?2, ?3)
             ON CONFLICT(account) DO UPDATE SET instance = excluded.instance, entries = excluded.entries",
            params![account, instance, all],
        )
        .map_err(store_err)?;
        for d in removed {
            tx.execute("DELETE FROM prekeys WHERE device = ?1", params![d])
                .map_err(store_err)?;
            tx.execute("DELETE FROM mailbox WHERE device = ?1", params![d])
                .map_err(store_err)?;
        }
        tx.commit().map_err(store_err)?;
        Ok(true)
    }

    /// Forget the devices of an earlier instance (their prekeys and mailboxes).
    pub fn drop_devices(&self, devices: &[String]) -> Result<(), StoreError> {
        let c = self.conn()?;
        for d in devices {
            c.execute("DELETE FROM prekeys WHERE device = ?1", params![d])
                .map_err(store_err)?;
            c.execute("DELETE FROM mailbox WHERE device = ?1", params![d])
                .map_err(store_err)?;
        }
        Ok(())
    }

    // ── remote identities ───────────────────────────────────────────────────────────────────────────────────────

    /// A cached remote identity.
    pub fn remote(&self, account: &str) -> Result<Option<Remote>, StoreError> {
        let c = self.conn()?;
        let row: Option<(String, String, String, i64)> = c
            .query_row(
                "SELECT home, events, state, fetched FROM remote_ids WHERE account = ?1",
                params![account],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(store_err)?;
        let Some((home, events, state, fetched)) = row else {
            return Ok(None);
        };
        let events = match value(&events)? {
            Value::Array(a) => a,
            _ => return Err(StoreError("corrupt events".into())),
        };
        let state = LogState::from_value(&value(&state)?).map_err(store_err)?;
        Ok(Some(Remote {
            home,
            events,
            state,
            fetched,
        }))
    }

    /// Store a verified remote identity (the caller checked that it is not older than the stored one).
    pub fn put_remote(
        &self,
        account: &str,
        home: &str,
        events: &[Value],
        state: &LogState,
        fetched: i64,
    ) -> Result<(), StoreError> {
        self.conn()?
            .execute(
                "INSERT INTO remote_ids (account, home, username_lc, tag, events, state, fetched)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(account) DO UPDATE SET home = excluded.home, username_lc = excluded.username_lc,
                   tag = excluded.tag, events = excluded.events, state = excluded.state, fetched = excluded.fetched",
                params![
                    account,
                    home,
                    state.username.to_ascii_lowercase(),
                    rootcard::id::tag(account),
                    text(&Value::Array(events.to_vec())),
                    text(&state.to_value()),
                    fetched
                ],
            )
            .map_err(store_err)?;
        Ok(())
    }

    /// Mark a remote identity as checked now.
    pub fn touch_remote(&self, account: &str, fetched: i64) -> Result<(), StoreError> {
        self.conn()?
            .execute(
                "UPDATE remote_ids SET fetched = ?2 WHERE account = ?1",
                params![account, fetched],
            )
            .map_err(store_err)?;
        Ok(())
    }

    /// Remote identities with this lower-case username and 4-character tag: `(account, home, username)`.
    pub fn find_remote(
        &self,
        username_lc: &str,
        tag: &str,
    ) -> Result<Vec<(String, String, String)>, StoreError> {
        let c = self.conn()?;
        let mut st = c
            .prepare(
                "SELECT account, home, state FROM remote_ids WHERE username_lc = ?1 AND tag = ?2",
            )
            .map_err(store_err)?;
        let rows = st
            .query_map(params![username_lc, tag], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(store_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (account, home, state) = row.map_err(store_err)?;
            let state = LogState::from_value(&value(&state)?).map_err(store_err)?;
            out.push((account, home, state.username));
        }
        Ok(out)
    }

    // ── prekeys ─────────────────────────────────────────────────────────────────────────────────────────────────

    /// Store the current prekey of a device.
    pub fn put_prekey(
        &self,
        account: &str,
        device: &str,
        prekey: &Value,
    ) -> Result<(), StoreError> {
        self.conn()?
            .execute(
                "INSERT INTO prekeys (device, account, prekey) VALUES (?1, ?2, ?3)
                 ON CONFLICT(device) DO UPDATE SET account = excluded.account, prekey = excluded.prekey",
                params![device, account, text(prekey)],
            )
            .map_err(store_err)?;
        Ok(())
    }

    /// The current prekey of a device.
    pub fn prekey(&self, device: &str) -> Result<Option<Value>, StoreError> {
        let s: Option<String> = self
            .conn()?
            .query_row(
                "SELECT prekey FROM prekeys WHERE device = ?1",
                params![device],
                |r| r.get(0),
            )
            .optional()
            .map_err(store_err)?;
        s.map(|s| value(&s)).transpose()
    }

    /// Whether a device can receive envelopes (it has a prekey).
    pub fn device_known(&self, device: &str) -> Result<bool, StoreError> {
        let n: i64 = self
            .conn()?
            .query_row(
                "SELECT COUNT(*) FROM prekeys WHERE device = ?1",
                params![device],
                |r| r.get(0),
            )
            .map_err(store_err)?;
        Ok(n > 0)
    }

    // ── mailbox ─────────────────────────────────────────────────────────────────────────────────────────────────

    /// Queue an envelope; `None` if the device's queue is full.
    pub fn enqueue(
        &self,
        device: &str,
        env: &str,
        expires: i64,
        max_queue: i64,
    ) -> Result<Option<i64>, StoreError> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(store_err)?;
        let n: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM mailbox WHERE device = ?1",
                params![device],
                |r| r.get(0),
            )
            .map_err(store_err)?;
        if n >= max_queue {
            return Ok(None);
        }
        tx.execute(
            "INSERT INTO mailbox (device, env, expires) VALUES (?1, ?2, ?3)",
            params![device, env, expires],
        )
        .map_err(store_err)?;
        let id = tx.last_insert_rowid();
        tx.commit().map_err(store_err)?;
        Ok(Some(id))
    }

    /// Queued envelopes of a device after `after`, oldest first.
    pub fn queued(
        &self,
        device: &str,
        after: i64,
        limit: i64,
    ) -> Result<Vec<(i64, String)>, StoreError> {
        let c = self.conn()?;
        let mut st = c
            .prepare(
                "SELECT id, env FROM mailbox WHERE device = ?1 AND id > ?2 ORDER BY id LIMIT ?3",
            )
            .map_err(store_err)?;
        let rows = st
            .query_map(params![device, after, limit], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(store_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(store_err)
    }

    /// Delete acknowledged envelopes of a device.
    pub fn ack(&self, device: &str, ids: &[i64]) -> Result<(), StoreError> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(store_err)?;
        for id in ids {
            tx.execute(
                "DELETE FROM mailbox WHERE id = ?1 AND device = ?2",
                params![id, device],
            )
            .map_err(store_err)?;
        }
        tx.commit().map_err(store_err)
    }

    /// Delete expired envelopes.
    pub fn purge(&self, now: i64) -> Result<usize, StoreError> {
        self.conn()?
            .execute("DELETE FROM mailbox WHERE expires < ?1", params![now])
            .map_err(store_err)
    }
}

// ── rootcard identity store ─────────────────────────────────────────────────────────────────────────────────────

/// rootcard's `IdentityStore` over the database.
#[derive(Clone)]
pub struct Identities(pub Db);

fn load_row(c: &Connection, account: &str) -> Result<Option<Stored>, StoreError> {
    type Row = (String, String, Option<String>, Option<String>);
    let row: Option<Row> = c
        .query_row(
            "SELECT events, state, vault, public FROM identities WHERE account = ?1",
            params![account],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(store_err)?;
    let Some((events, state, vault, public)) = row else {
        return Ok(None);
    };
    let events = match value(&events)? {
        Value::Array(a) => a,
        _ => return Err(StoreError("corrupt events".into())),
    };
    let state = LogState::from_value(&value(&state)?).map_err(store_err)?;
    Ok(Some(Stored {
        events,
        state,
        vault: vault.as_deref().map(value).transpose()?,
        public: public.as_deref().map(value).transpose()?,
    }))
}

impl IdentityStore for Identities {
    fn load(&self, account: &str) -> Result<Option<Stored>, StoreError> {
        let c = self.0.conn()?;
        load_row(&c, account)
    }

    fn insert(&self, new: &Stored, claim: bool) -> Result<Insert, StoreError> {
        let mut c = self.0.conn()?;
        let tx = c.transaction().map_err(store_err)?;
        let account = new.state.account.as_str();
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM identities WHERE account = ?1",
                params![account],
                |r| r.get(0),
            )
            .map_err(store_err)?;
        if exists > 0 {
            return Ok(Insert::Exists);
        }
        let key = HandleKey::of(&new.state);
        if claim {
            let taken: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM identities WHERE realm = ?1 AND username_lc = ?2 AND tag = ?3 AND claimed = 1",
                    params![key.realm, key.username, key.tag],
                    |r| r.get(0),
                )
                .map_err(store_err)?;
            if taken > 0 {
                return Ok(Insert::HandleTaken);
            }
        }
        tx.execute(
            "INSERT INTO identities (account, realm, username_lc, tag, claimed, events, state, vault, public)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                account,
                key.realm,
                key.username,
                key.tag,
                i64::from(claim),
                text(&Value::Array(new.events.clone())),
                text(&new.state.to_value()),
                new.vault.as_ref().map(text),
                new.public.as_ref().map(text),
            ],
        )
        .map_err(store_err)?;
        tx.execute(
            "INSERT INTO changes (account) VALUES (?1)",
            params![account],
        )
        .map_err(store_err)?;
        tx.commit().map_err(store_err)?;
        Ok(Insert::Done)
    }

    fn swap(&self, account: &str, expected: &Expected, new: &Stored) -> Result<bool, StoreError> {
        let mut c = self.0.conn()?;
        let tx = c.transaction().map_err(store_err)?;
        match load_row(&tx, account)? {
            Some(cur) if cur.expected() == *expected => {}
            _ => return Ok(false),
        }
        tx.execute(
            "UPDATE identities SET events = ?2, state = ?3, vault = ?4, public = ?5 WHERE account = ?1",
            params![
                account,
                text(&Value::Array(new.events.clone())),
                text(&new.state.to_value()),
                new.vault.as_ref().map(text),
                new.public.as_ref().map(text),
            ],
        )
        .map_err(store_err)?;
        tx.execute(
            "INSERT INTO changes (account) VALUES (?1)",
            params![account],
        )
        .map_err(store_err)?;
        tx.commit().map_err(store_err)?;
        Ok(true)
    }

    fn by_handle(&self, key: &HandleKey) -> Result<Vec<String>, StoreError> {
        let c = self.0.conn()?;
        let mut st = c
            .prepare(
                "SELECT account FROM identities WHERE realm = ?1 AND username_lc = ?2 AND tag = ?3",
            )
            .map_err(store_err)?;
        let rows = st
            .query_map(params![key.realm, key.username, key.tag], |r| r.get(0))
            .map_err(store_err)?;
        rows.collect::<Result<Vec<String>, _>>().map_err(store_err)
    }

    fn handle_claimed(&self, key: &HandleKey) -> Result<bool, StoreError> {
        let n: i64 = self
            .0
            .conn()?
            .query_row(
                "SELECT COUNT(*) FROM identities WHERE realm = ?1 AND username_lc = ?2 AND tag = ?3 AND claimed = 1",
                params![key.realm, key.username, key.tag],
                |r| r.get(0),
            )
            .map_err(store_err)?;
        Ok(n > 0)
    }

    fn changes(&self, since: u64, limit: usize) -> Result<(u64, Vec<String>), StoreError> {
        let c = self.0.conn()?;
        let mut st = c
            .prepare("SELECT seq, account FROM changes WHERE seq > ?1 ORDER BY seq LIMIT ?2")
            .map_err(store_err)?;
        let since_i = i64::try_from(since).unwrap_or(i64::MAX);
        let limit_i = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = st
            .query_map(params![since_i, limit_i], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(store_err)?;
        let mut cursor = since;
        let mut out: Vec<String> = Vec::new();
        for row in rows {
            let (seq, account) = row.map_err(store_err)?;
            cursor = u64::try_from(seq).unwrap_or(cursor);
            if !out.contains(&account) {
                out.push(account);
            }
        }
        Ok((cursor, out))
    }
}
