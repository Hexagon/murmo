//! The bridge's tables, in the server's database but apart from everything else (DESIGN.md §16.6). They are created
//! only when the bridge is on (`MURMO_BRIDGE=1`); a server without the bridge never has them.

use crate::db::Db;
use rusqlite::{OptionalExtension, params};

/// The tables. `state` is the bot's encrypted state (device key, prekeys, contacts, inbox: [`super::bot::State`]).
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS bridge_bots (
    account     TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    handle      TEXT NOT NULL,
    device      TEXT NOT NULL,
    created     INTEGER NOT NULL,
    auto_accept INTEGER NOT NULL DEFAULT 0,
    retention   INTEGER NOT NULL DEFAULT 0,
    owner_only  INTEGER NOT NULL DEFAULT 0,
    key_hash    BLOB NOT NULL UNIQUE,
    key_hint    TEXT NOT NULL,
    key_created INTEGER NOT NULL,
    state       BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS bridge_bots_owner ON bridge_bots (owner);
";

/// A bot as its owner sees it (no secrets).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotRow {
    /// The bot's account id.
    pub account: String,
    /// The account id of the owner who made it.
    pub owner: String,
    /// `Name#TAG`.
    pub handle: String,
    /// The bot's single device.
    pub device: String,
    /// When it was made (seconds).
    pub created: i64,
    /// Whether message requests are accepted at once.
    pub auto_accept: bool,
    /// Days events are kept until the program confirms them; 0: deleted as soon as they are handed out.
    pub retention: i64,
    /// Whether the bot talks with its owner's account only.
    pub owner_only: bool,
    /// The last four characters of the current API key, for the owner to tell keys apart.
    pub key_hint: String,
    /// When the current API key was made.
    pub key_created: i64,
}

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

const COLUMNS: &str = "account, owner, handle, device, created, auto_accept, key_hint, key_created, retention, owner_only";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<BotRow> {
    Ok(BotRow {
        account: r.get(0)?,
        owner: r.get(1)?,
        handle: r.get(2)?,
        device: r.get(3)?,
        created: r.get(4)?,
        auto_accept: r.get::<_, i64>(5)? != 0,
        key_hint: r.get(6)?,
        key_created: r.get(7)?,
        retention: r.get(8)?,
        owner_only: r.get::<_, i64>(9)? != 0,
    })
}

/// The bridge's view of the database.
#[derive(Clone)]
pub struct Store(pub Db);

impl Store {
    /// Create the tables if they are not there.
    pub fn open(db: Db) -> R<Store> {
        db.conn().map_err(err)?.execute_batch(SCHEMA).map_err(err)?;
        Ok(Store(db))
    }

    /// Insert a new bot.
    pub fn insert(&self, b: &BotRow, key_hash: &[u8], state: &[u8]) -> R<()> {
        self.0
            .conn()
            .map_err(err)?
            .execute(
                "INSERT INTO bridge_bots (account, owner, handle, device, created, auto_accept, key_hash, key_hint,
                 key_created, state, retention, owner_only) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    b.account,
                    b.owner,
                    b.handle,
                    b.device,
                    b.created,
                    i64::from(b.auto_accept),
                    key_hash,
                    b.key_hint,
                    b.key_created,
                    state,
                    b.retention,
                    i64::from(b.owner_only)
                ],
            )
            .map_err(err)?;
        Ok(())
    }

    /// The bots of an owner, oldest first.
    pub fn by_owner(&self, owner: &str) -> R<Vec<BotRow>> {
        let c = self.0.conn().map_err(err)?;
        let mut st = c
            .prepare(&format!(
                "SELECT {COLUMNS} FROM bridge_bots WHERE owner = ?1 ORDER BY created, account"
            ))
            .map_err(err)?;
        let rows = st.query_map(params![owner], row).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// Every bot's account id (for background work).
    pub fn all(&self) -> R<Vec<String>> {
        let c = self.0.conn().map_err(err)?;
        let mut st = c
            .prepare("SELECT account FROM bridge_bots ORDER BY account")
            .map_err(err)?;
        let rows = st.query_map([], |r| r.get(0)).map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// A bot by account id.
    pub fn get(&self, account: &str) -> R<Option<BotRow>> {
        self.0
            .conn()
            .map_err(err)?
            .query_row(
                &format!("SELECT {COLUMNS} FROM bridge_bots WHERE account = ?1"),
                params![account],
                row,
            )
            .optional()
            .map_err(err)
    }

    /// The bot whose API key has this hash.
    pub fn by_key(&self, key_hash: &[u8]) -> R<Option<BotRow>> {
        self.0
            .conn()
            .map_err(err)?
            .query_row(
                &format!("SELECT {COLUMNS} FROM bridge_bots WHERE key_hash = ?1"),
                params![key_hash],
                row,
            )
            .optional()
            .map_err(err)
    }

    /// Whether an account is a bot of this bridge.
    pub fn is_bot(&self, account: &str) -> R<bool> {
        Ok(self.get(account)?.is_some())
    }

    /// The bot's encrypted state.
    pub fn state(&self, account: &str) -> R<Option<Vec<u8>>> {
        self.0
            .conn()
            .map_err(err)?
            .query_row(
                "SELECT state FROM bridge_bots WHERE account = ?1",
                params![account],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)
    }

    /// Replace the bot's encrypted state.
    pub fn put_state(&self, account: &str, state: &[u8]) -> R<()> {
        self.0
            .conn()
            .map_err(err)?
            .execute(
                "UPDATE bridge_bots SET state = ?2 WHERE account = ?1",
                params![account, state],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Replace the API key (the old one stops working at once).
    pub fn set_key(&self, account: &str, key_hash: &[u8], hint: &str, created: i64) -> R<()> {
        self.0
            .conn()
            .map_err(err)?
            .execute(
                "UPDATE bridge_bots SET key_hash = ?2, key_hint = ?3, key_created = ?4 WHERE account = ?1",
                params![account, key_hash, hint, created],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Whether message requests are accepted at once.
    pub fn set_auto_accept(&self, account: &str, on: bool) -> R<()> {
        self.0
            .conn()
            .map_err(err)?
            .execute(
                "UPDATE bridge_bots SET auto_accept = ?2 WHERE account = ?1",
                params![account, i64::from(on)],
            )
            .map_err(err)?;
        Ok(())
    }

    /// How many days events are kept (0: deleted as soon as they are handed out).
    pub fn set_retention(&self, account: &str, days: i64) -> R<()> {
        self.0
            .conn()
            .map_err(err)?
            .execute(
                "UPDATE bridge_bots SET retention = ?2 WHERE account = ?1",
                params![account, days],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Whether the bot talks with its owner's account only.
    pub fn set_owner_only(&self, account: &str, on: bool) -> R<()> {
        self.0
            .conn()
            .map_err(err)?
            .execute(
                "UPDATE bridge_bots SET owner_only = ?2 WHERE account = ?1",
                params![account, i64::from(on)],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Delete a bot (its state with it).
    pub fn delete(&self, account: &str) -> R<()> {
        self.0
            .conn()
            .map_err(err)?
            .execute(
                "DELETE FROM bridge_bots WHERE account = ?1",
                params![account],
            )
            .map_err(err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(account: &str, owner: &str) -> BotRow {
        BotRow {
            account: account.into(),
            owner: owner.into(),
            handle: "Bot#ABCD".into(),
            device: "dev".into(),
            created: 1,
            auto_accept: false,
            retention: 0,
            owner_only: false,
            key_hint: "wxyz".into(),
            key_created: 1,
        }
    }

    #[test]
    fn bots_by_owner_and_key() {
        let s = Store::open(Db::open(":memory:").expect("db")).expect("store");
        s.insert(&bot("A", "o1"), b"k1", b"s1").expect("insert");
        s.insert(&bot("B", "o2"), b"k2", b"s2").expect("insert");
        assert_eq!(s.by_owner("o1").expect("list").len(), 1);
        assert_eq!(
            s.by_key(b"k2").expect("key").map(|b| b.account),
            Some("B".into())
        );
        // A key is unique: two bots can never share one.
        assert!(s.insert(&bot("C", "o1"), b"k1", b"s3").is_err());
        s.set_key("A", b"k3", "abcd", 2).expect("rotate");
        assert!(s.by_key(b"k1").expect("old").is_none());
        assert_eq!(
            s.by_key(b"k3").expect("new").map(|b| b.key_hint),
            Some("abcd".into())
        );
        s.put_state("A", b"s9").expect("state");
        assert_eq!(s.state("A").expect("state"), Some(b"s9".to_vec()));
        s.set_auto_accept("A", true).expect("auto");
        assert!(s.get("A").expect("get").expect("bot").auto_accept);
        assert_eq!(s.get("A").expect("get").expect("bot").retention, 0);
        s.set_retention("A", 7).expect("retention");
        s.set_owner_only("A", true).expect("owner only");
        assert!(s.get("A").expect("get").expect("bot").owner_only);
        assert_eq!(s.get("A").expect("get").expect("bot").retention, 7);
        s.delete("A").expect("delete");
        assert!(!s.is_bot("A").expect("gone"));
        assert_eq!(s.all().expect("all"), vec!["B".to_string()]);
    }
}
