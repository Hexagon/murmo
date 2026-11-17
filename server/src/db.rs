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
  expires INTEGER NOT NULL,
  origin  TEXT
);
CREATE INDEX IF NOT EXISTS mailbox_device ON mailbox (device, id);
CREATE TABLE IF NOT EXISTS writes (
  pair  BLOB PRIMARY KEY, -- keyed hash of: writer account > recipient account (or @server)
  until INTEGER NOT NULL
);
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
CREATE TABLE IF NOT EXISTS relay_queue (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  device  TEXT NOT NULL,
  sender  TEXT NOT NULL,
  account TEXT NOT NULL,
  size    INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  data    TEXT NOT NULL -- or a BLOB: a binary chunk (TEXT affinity keeps BLOBs as they are)
);
CREATE INDEX IF NOT EXISTS relay_queue_device ON relay_queue (device, id);
CREATE INDEX IF NOT EXISTS relay_queue_account ON relay_queue (account, device);
CREATE TABLE IF NOT EXISTS push_subs (
  device   TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_seen (
  device TEXT PRIMARY KEY,
  seen   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (
  key    BLOB PRIMARY KEY,
  count  INTEGER NOT NULL,
  start  INTEGER NOT NULL,
  window INTEGER NOT NULL
);
";

/// A file chunk to queue: base64url text from a client that sends text frames, or the payload of a binary frame.
#[derive(Debug, Clone, Copy)]
pub enum ChunkData<'a> {
    /// Text (`relay` JSON frame).
    Text(&'a str),
    /// Bytes (binary relay frame).
    Binary(&'a [u8]),
}

impl ChunkData<'_> {
    /// Its size as counted against the queue's budgets.
    pub fn len(&self) -> usize {
        match self {
            ChunkData::Text(t) => t.len(),
            ChunkData::Binary(b) => b.len(),
        }
    }

    /// Whether it is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A queued chunk as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueuedData {
    /// Delivered as a text `relay` frame.
    Text(String),
    /// Delivered as a binary frame, only to connections that take them.
    Binary(Vec<u8>),
}

/// A queued chunk with where it came from.
#[derive(Debug, Clone)]
pub struct QueuedChunk {
    /// Its id, for `relay-ack`.
    pub id: i64,
    /// The sending device.
    pub sender: String,
    /// The sending account.
    pub account: String,
    /// The chunk.
    pub data: QueuedData,
}

/// A saved rate limit counter: `(keyed hash, count, window start, window seconds)`.
pub type RateRow = (Vec<u8>, u32, i64, i64);

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
        // Envelopes from other servers (federation) remember the server; databases from before have no column.
        let has_origin: bool = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('mailbox') WHERE name = 'origin'",
            [],
            |r| r.get::<_, i64>(0).map(|n| n > 0),
        )?;
        if !has_origin {
            conn.execute_batch("ALTER TABLE mailbox ADD COLUMN origin TEXT")?;
        }
        // Who sent each envelope, as a keyed hash, for the senders' shares of a mailbox; databases from before have
        // no column (their envelopes count for nobody's share).
        let has_sender: bool = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('mailbox') WHERE name = 'sender'",
            [],
            |r| r.get::<_, i64>(0).map(|n| n > 0),
        )?;
        if !has_sender {
            conn.execute_batch("ALTER TABLE mailbox ADD COLUMN sender BLOB")?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS mailbox_sender ON mailbox (device, sender)",
        )?;
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
            tx.execute("DELETE FROM device_seen WHERE device = ?1", params![d])
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
            c.execute("DELETE FROM relay_queue WHERE device = ?1", params![d])
                .map_err(store_err)?;
            c.execute("DELETE FROM push_subs WHERE device = ?1", params![d])
                .map_err(store_err)?;
            c.execute("DELETE FROM device_seen WHERE device = ?1", params![d])
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
    /// The account a device on this server belongs to; `None` for a device it does not know.
    pub fn device_owner(&self, device: &str) -> Result<Option<String>, StoreError> {
        self.conn()?
            .query_row(
                "SELECT account FROM prekeys WHERE device = ?1",
                params![device],
                |r| r.get(0),
            )
            .optional()
            .map_err(store_err)
    }

    /// Remember until `until` that an account wrote to another (the pair as a keyed hash, see [`Share`]).
    pub fn note_write(&self, pair: &[u8], until: i64) -> Result<(), StoreError> {
        self.conn()?
            .execute(
                "INSERT INTO writes (pair, until) VALUES (?1, ?2) ON CONFLICT(pair) DO UPDATE SET until = MAX(until, excluded.until)",
                params![pair, until],
            )
            .map_err(store_err)?;
        Ok(())
    }

    /// Whether an account wrote to another (the pair as a keyed hash) and that has not expired at `now`.
    pub fn wrote(&self, pair: &[u8], now: i64) -> Result<bool, StoreError> {
        let n: i64 = self
            .conn()?
            .query_row(
                "SELECT COUNT(*) FROM writes WHERE pair = ?1 AND until >= ?2",
                params![pair, now],
                |r| r.get(0),
            )
            .map_err(store_err)?;
        Ok(n > 0)
    }

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

    /// Queue an envelope; `None` if the device's queue is full. `origin` is the server it came from when that is not
    /// this one (federation).
    ///
    /// With `share`, the envelope also counts against its sender's share of the device's mailbox: `None` too when the
    /// sender already has `share.max` envelopes queued there.
    pub fn enqueue(
        &self,
        device: &str,
        env: &str,
        expires: i64,
        max_queue: i64,
        origin: Option<&str>,
        share: Option<&Share>,
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
        if let Some(sh) = share {
            let mine: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM mailbox WHERE device = ?1 AND sender = ?2",
                    params![device, &sh.sender[..]],
                    |r| r.get(0),
                )
                .map_err(store_err)?;
            if mine >= sh.max {
                return Ok(None);
            }
        }
        tx.execute(
            "INSERT INTO mailbox (device, env, expires, origin, sender) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![device, env, expires, origin, share.map(|sh| &sh.sender[..])],
        )
        .map_err(store_err)?;
        let id = tx.last_insert_rowid();
        tx.commit().map_err(store_err)?;
        Ok(Some(id))
    }

    /// Queued envelopes of a device after `after`, oldest first, that have not expired at `now`: id, envelope and
    /// the server it came from when that is not this one.
    pub fn queued(
        &self,
        device: &str,
        after: i64,
        limit: i64,
        now: i64,
    ) -> Result<Vec<(i64, String, Option<String>)>, StoreError> {
        let c = self.conn()?;
        let mut st = c
            .prepare(
                "SELECT id, env, origin FROM mailbox WHERE device = ?1 AND id > ?2 AND expires >= ?3 ORDER BY id LIMIT ?4",
            )
            .map_err(store_err)?;
        let rows = st
            .query_map(params![device, after, now, limit], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
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

    /// Whether the device still has an unacknowledged envelope with this id or a later one.
    pub fn queued_since(&self, device: &str, id: i64) -> Result<bool, StoreError> {
        let n: i64 = self
            .conn()?
            .query_row(
                "SELECT COUNT(*) FROM (SELECT 1 FROM mailbox WHERE device = ?1 AND id >= ?2 LIMIT 1)",
                params![device, id],
                |r| r.get(0),
            )
            .map_err(store_err)?;
        Ok(n > 0)
    }

    /// Delete expired envelopes and expired queued file chunks.
    pub fn purge(&self, now: i64) -> Result<usize, StoreError> {
        let c = self.conn()?;
        let n = c
            .execute("DELETE FROM mailbox WHERE expires < ?1", params![now])
            .map_err(store_err)?;
        let m = c
            .execute("DELETE FROM relay_queue WHERE expires < ?1", params![now])
            .map_err(store_err)?;
        c.execute("DELETE FROM writes WHERE until < ?1", params![now])
            .map_err(store_err)?;
        Ok(n + m)
    }

    // ── queued file chunks (ciphertext for devices that were not connected) ─────────────────────────────────────

    /// What a sender account has queued for a device, and the totals its limits are checked against; `None` if
    /// the device is unknown.
    pub fn relay_usage(
        &self,
        device: &str,
        account: &str,
    ) -> Result<Option<QueueUsage>, StoreError> {
        usage(&*self.conn()?, device, account)
    }

    /// Queue a chunk for a device unless that would exceed one of `limits`. A binary chunk is stored as a `BLOB`,
    /// a text chunk (from a client that sends text frames) as `TEXT`; [`Db::relay_queued`] tells them apart.
    pub fn relay_enqueue(
        &self,
        device: &str,
        sender: &str,
        account: &str,
        data: ChunkData<'_>,
        expires: i64,
        limits: &QueueLimits,
    ) -> Result<bool, StoreError> {
        let size = i64::try_from(data.len()).unwrap_or(i64::MAX);
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(store_err)?;
        match usage(&tx, device, account)? {
            Some(u) if u.room(limits) >= size => {}
            _ => return Ok(false),
        }
        let sql = "INSERT INTO relay_queue (device, sender, account, size, expires, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)";
        match data {
            ChunkData::Text(t) => {
                tx.execute(sql, params![device, sender, account, size, expires, t])
            }
            ChunkData::Binary(b) => {
                tx.execute(sql, params![device, sender, account, size, expires, b])
            }
        }
        .map_err(store_err)?;
        tx.commit().map_err(store_err)?;
        Ok(true)
    }

    /// Queued chunks of a device after `after`, oldest first.
    pub fn relay_queued(
        &self,
        device: &str,
        after: i64,
        limit: i64,
    ) -> Result<Vec<QueuedChunk>, StoreError> {
        let c = self.conn()?;
        let mut st = c
            .prepare(
                "SELECT id, sender, account, data FROM relay_queue WHERE device = ?1 AND id > ?2 ORDER BY id LIMIT ?3",
            )
            .map_err(store_err)?;
        let rows = st
            .query_map(params![device, after, limit], |r| {
                let data = match r.get::<_, rusqlite::types::Value>(3)? {
                    rusqlite::types::Value::Blob(b) => QueuedData::Binary(b),
                    rusqlite::types::Value::Text(t) => QueuedData::Text(t),
                    _ => QueuedData::Text(String::new()),
                };
                Ok(QueuedChunk {
                    id: r.get(0)?,
                    sender: r.get(1)?,
                    account: r.get(2)?,
                    data,
                })
            })
            .map_err(store_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(store_err)
    }

    /// Delete acknowledged chunks of a device.
    pub fn relay_ack(&self, device: &str, ids: &[i64]) -> Result<(), StoreError> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(store_err)?;
        for id in ids {
            tx.execute(
                "DELETE FROM relay_queue WHERE id = ?1 AND device = ?2",
                params![id, device],
            )
            .map_err(store_err)?;
        }
        tx.commit().map_err(store_err)
    }

    // ── push subscriptions and settings ─────────────────────────────────────────────────────────────────────────

    /// The push endpoint of a device, if it asked for notifications.
    pub fn push_sub(&self, device: &str) -> Result<Option<String>, StoreError> {
        self.conn()?
            .query_row(
                "SELECT endpoint FROM push_subs WHERE device = ?1",
                params![device],
                |r| r.get(0),
            )
            .optional()
            .map_err(store_err)
    }

    /// Set (`Some`) or remove (`None`) the push endpoint of a device.
    pub fn set_push_sub(&self, device: &str, endpoint: Option<&str>) -> Result<(), StoreError> {
        let c = self.conn()?;
        match endpoint {
            Some(e) => c.execute(
                "INSERT INTO push_subs (device, endpoint) VALUES (?1, ?2)
                 ON CONFLICT (device) DO UPDATE SET endpoint = excluded.endpoint",
                params![device, e],
            ),
            None => c.execute("DELETE FROM push_subs WHERE device = ?1", params![device]),
        }
        .map(|_| ())
        .map_err(store_err)
    }

    /// Record that a device was connected at `t` (seconds).
    pub fn set_seen(&self, device: &str, t: i64) -> Result<(), StoreError> {
        self.conn()?
            .execute(
                "INSERT INTO device_seen (device, seen) VALUES (?1, ?2)
                 ON CONFLICT (device) DO UPDATE SET seen = MAX(seen, excluded.seen)",
                params![device, t],
            )
            .map(|_| ())
            .map_err(store_err)
    }

    /// When a device was last connected, if it ever was since this was recorded.
    pub fn seen(&self, device: &str) -> Result<Option<i64>, StoreError> {
        self.conn()?
            .query_row(
                "SELECT seen FROM device_seen WHERE device = ?1",
                params![device],
                |r| r.get(0),
            )
            .optional()
            .map_err(store_err)
    }

    /// A server setting.
    pub fn setting(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.conn()?
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
            .map_err(store_err)
    }

    /// Saved rate limit counters: `(keyed hash, count, window start, window seconds)`.
    pub fn rate_limits(&self) -> Result<Vec<RateRow>, StoreError> {
        let c = self.conn()?;
        let mut st = c
            .prepare("SELECT key, count, start, window FROM rate_limits")
            .map_err(store_err)?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(store_err)?
            .collect::<Result<_, _>>()
            .map_err(store_err)
    }

    /// Replace the saved rate limit counters.
    pub fn set_rate_limits(&self, rows: &[RateRow]) -> Result<(), StoreError> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(store_err)?;
        tx.execute("DELETE FROM rate_limits", [])
            .map_err(store_err)?;
        for (k, n, start, window) in rows {
            tx.execute(
                "INSERT INTO rate_limits (key, count, start, window) VALUES (?1, ?2, ?3, ?4)",
                params![k, n, start, window],
            )
            .map_err(store_err)?;
        }
        tx.commit().map_err(store_err)
    }

    /// Store a server setting.
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.conn()?
            .execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
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

// ── file queue budgets ──────────────────────────────────────────────────────────────────────────────────────────

/// A sender's share of one device's mailbox: who it is, as a keyed hash (of its account, or of its server for
/// envelopes from another server), and how many of its envelopes may wait there at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Share {
    pub sender: [u8; 16],
    pub max: i64,
}

/// Byte limits of the file queue.
#[derive(Debug, Clone, Copy)]
pub struct QueueLimits {
    /// Per receiving device.
    pub device: i64,
    /// Per sender account and receiving device of another account.
    pub pair: i64,
    /// Per sender account, over all receiving devices.
    pub account: i64,
    /// For the whole server.
    pub total: i64,
}

impl QueueLimits {
    /// The most bytes of one file the queue can ever keep for one device: for a device of another account (the
    /// stricter case), with nothing else queued. What fits right now is less when other files are queued.
    pub fn largest_file(&self) -> i64 {
        self.device
            .min(self.pair)
            .min(self.account)
            .min(self.total)
            .max(0)
    }
}

/// Bytes queued, as seen from one sender account and one receiving device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueUsage {
    /// For the device, from anyone.
    pub device: i64,
    /// For the device, from the sender account.
    pub pair: i64,
    /// From the sender account, for any device.
    pub account: i64,
    /// On the whole server.
    pub total: i64,
    /// The device belongs to the sender account (the pair limit does not apply).
    pub own: bool,
}

impl QueueUsage {
    /// Bytes more that fit under every limit (negative if one is already exceeded).
    pub fn room(&self, l: &QueueLimits) -> i64 {
        let pair = if self.own {
            i64::MAX
        } else {
            l.pair.saturating_sub(self.pair)
        };
        (l.device.saturating_sub(self.device))
            .min(pair)
            .min(l.account.saturating_sub(self.account))
            .min(l.total.saturating_sub(self.total))
    }
}

fn usage(c: &Connection, device: &str, account: &str) -> Result<Option<QueueUsage>, StoreError> {
    let owner: Option<String> = c
        .query_row(
            "SELECT account FROM prekeys WHERE device = ?1",
            params![device],
            |r| r.get(0),
        )
        .optional()
        .map_err(store_err)?;
    let Some(owner) = owner else {
        return Ok(None);
    };
    let sum = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> Result<i64, StoreError> {
        c.query_row(sql, p, |r| r.get(0)).map_err(store_err)
    };
    Ok(Some(QueueUsage {
        device: sum(
            "SELECT COALESCE(SUM(size), 0) FROM relay_queue WHERE device = ?1",
            &[&device],
        )?,
        pair: sum(
            "SELECT COALESCE(SUM(size), 0) FROM relay_queue WHERE account = ?1 AND device = ?2",
            &[&account, &device],
        )?,
        account: sum(
            "SELECT COALESCE(SUM(size), 0) FROM relay_queue WHERE account = ?1",
            &[&account],
        )?,
        total: sum("SELECT COALESCE(SUM(size), 0) FROM relay_queue", &[])?,
        own: owner == account,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: QueueLimits = QueueLimits {
        device: 100,
        pair: 40,
        account: 70,
        total: 150,
    };

    #[test]
    fn largest_file_is_the_smallest_limit() {
        assert_eq!(LIMITS.largest_file(), 40);
        let l = QueueLimits {
            device: 10,
            ..LIMITS
        };
        assert_eq!(l.largest_file(), 10);
        let off = QueueLimits {
            device: 0,
            ..LIMITS
        };
        assert_eq!(off.largest_file(), 0);
    }

    fn db() -> Db {
        let db = Db::open(":memory:").expect("database");
        for (account, device) in [
            ("A", "a1"),
            ("B", "b1"),
            ("B", "b2"),
            ("C", "c1"),
            ("D", "d1"),
        ] {
            db.put_prekey(account, device, &Value::from("p"))
                .expect("prekey");
        }
        db
    }

    fn put(db: &Db, to: &str, from_account: &str, n: usize) -> bool {
        db.relay_enqueue(
            to,
            "dev",
            from_account,
            ChunkData::Text(&"x".repeat(n)),
            10,
            &LIMITS,
        )
        .expect("enqueue")
    }

    #[test]
    fn seen_only_moves_forward_and_goes_with_the_device() {
        let db = db();
        assert_eq!(db.seen("b1").expect("seen"), None);
        db.set_seen("b1", 100).expect("set");
        db.set_seen("b1", 50).expect("set");
        assert_eq!(db.seen("b1").expect("seen"), Some(100));
        db.drop_devices(&["b1".to_string()]).expect("drop");
        assert_eq!(db.seen("b1").expect("seen"), None);
    }

    #[test]
    fn one_sender_cannot_fill_a_device() {
        let db = db();
        assert!(put(&db, "b1", "A", 40));
        assert!(!put(&db, "b1", "A", 1), "pair limit");
        // Other senders still have room on the same device, up to the device limit.
        assert!(put(&db, "b1", "C", 40));
        assert!(put(&db, "b1", "D", 20));
        assert!(!put(&db, "b1", "D", 1), "device limit");
        // Acknowledged or expired chunks free the budget again.
        db.purge(11).expect("purge");
        assert!(put(&db, "b1", "A", 40));
    }

    #[test]
    fn one_sender_cannot_fill_the_server() {
        let db = db();
        assert!(put(&db, "b1", "A", 40));
        assert!(put(&db, "c1", "A", 30));
        assert!(!put(&db, "d1", "A", 1), "account limit");
        assert!(put(&db, "d1", "B", 40));
        assert!(put(&db, "a1", "B", 30));
        assert!(!put(&db, "c1", "C", 11), "total limit");
        assert!(put(&db, "c1", "C", 10));
    }

    #[test]
    fn own_devices_have_no_pair_limit() {
        let db = db();
        assert!(put(&db, "b2", "B", 70));
        assert!(!put(&db, "b2", "B", 1), "the account limit still applies");
        let u = db.relay_usage("b2", "B").expect("usage").expect("known");
        assert!(u.own);
        assert_eq!(u.room(&LIMITS), 0);
        let u = db.relay_usage("b2", "A").expect("usage").expect("known");
        assert_eq!((u.own, u.device, u.pair), (false, 70, 0));
        assert_eq!(u.room(&LIMITS), 30);
    }

    #[test]
    fn binary_and_text_chunks_keep_their_kind() {
        let db = db();
        assert!(
            db.relay_enqueue("b1", "a1", "A", ChunkData::Text("abc"), 10, &LIMITS)
                .expect("enqueue")
        );
        assert!(
            db.relay_enqueue(
                "b1",
                "a1",
                "A",
                ChunkData::Binary(&[0, 1, 2, 255]),
                10,
                &LIMITS
            )
            .expect("enqueue")
        );
        let q = db.relay_queued("b1", 0, 10).expect("queued");
        assert_eq!(q.len(), 2);
        assert_eq!(q[0].data, QueuedData::Text("abc".into()));
        assert_eq!(q[1].data, QueuedData::Binary(vec![0, 1, 2, 255]));
        assert_eq!((q[1].sender.as_str(), q[1].account.as_str()), ("a1", "A"));
        // Both count by their length.
        let u = db.relay_usage("b1", "A").expect("usage").expect("known");
        assert_eq!(u.pair, 7);
    }

    #[test]
    fn unknown_devices_get_nothing() {
        let db = db();
        assert!(!put(&db, "nobody", "A", 1));
        assert!(db.relay_usage("nobody", "A").expect("usage").is_none());
    }

    #[test]
    fn queued_hides_expired_envelopes() {
        let db = db();
        db.enqueue("b1", "old", 100, 10, None, None)
            .expect("enqueue");
        db.enqueue("b1", "new", 200, 10, None, None)
            .expect("enqueue");
        // Before the purge sweep runs, the expired envelope is still stored but not handed out.
        let queued = db.queued("b1", 0, 10, 150).expect("queued");
        assert_eq!(
            queued
                .iter()
                .map(|(_, env, _)| env.as_str())
                .collect::<Vec<_>>(),
            vec!["new"]
        );
        let n: i64 = db
            .conn()
            .expect("conn")
            .query_row("SELECT COUNT(*) FROM mailbox", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 2, "not purged yet");
        // An envelope is kept while `expires >= now`, and hidden once `now` has moved past it.
        assert_eq!(db.queued("b1", 0, 10, 100).expect("queued").len(), 2);
        assert_eq!(db.queued("b1", 0, 10, 101).expect("queued").len(), 1);
        assert_eq!(db.queued("b1", 0, 10, 201).expect("queued").len(), 0);
    }
}
