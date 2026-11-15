//! Entry points for the fuzz targets in `fuzz/` (`cargo +nightly fuzz run <target>`). Each takes arbitrary bytes and
//! must never panic, hang or grow without bound. They are also run on a few inputs by the unit tests below, so they
//! keep compiling on stable.

use crate::app::{App, Config, client_addr, trusted_proxies};
use crate::devices::{Device, device_id, parse_device, verify_list, verify_prekey};
use rootcard::json::{Value, parse_limited};
use std::net::IpAddr;
use std::sync::{Arc, OnceLock};

/// A fixed account id (52 characters of Crockford base32).
const ACCOUNT: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJK";
/// A fixed account key.
const ACCOUNT_KEY: [u8; 32] = [7; 32];

fn device() -> Device {
    let key = [9u8; 32];
    Device {
        id: device_id(&key),
        key,
        label: "fuzz".into(),
    }
}

/// A JSON request body as the HTTP API and the device-list and prekey checks see it.
pub fn json_body(data: &[u8]) {
    let _ = crate::api::body_object(&axum::body::Bytes::copy_from_slice(data));
    let Ok(v) = parse_limited(data, crate::api::MAX_BODY) else {
        return;
    };
    let _ = parse_device(&v);
    let _ = verify_prekey(ACCOUNT, &device(), &v);
    let entries: &[Value] = match &v {
        Value::Array(a) => a,
        Value::Object(m) => match m.get("entries") {
            Some(Value::Array(a)) => a,
            _ => return,
        },
        _ => return,
    };
    let _ = verify_list(ACCOUNT, &ACCOUNT_KEY, entries);
}

/// Small text parsers on the request path: query decoding, account ids, home origins, `MURMO_TRUST_PROXY` and
/// `X-Forwarded-For`.
pub fn http_text(data: &[u8]) {
    let Ok(s) = std::str::from_utf8(data) else {
        return;
    };
    let _ = crate::api::decode(s);
    let _ = crate::api::check_account(s);
    let _ = crate::remote::origin_of(s);
    let _ = rootcard::check_base_url(s);
    // First line: trusted proxies; the rest: forwarded headers.
    let mut lines = s.lines();
    let trusted = trusted_proxies(lines.next().unwrap_or("")).unwrap_or_default();
    let local = trusted_proxies("1").unwrap_or_default();
    let hops: Vec<&str> = lines.collect();
    for peer in [IpAddr::from([127, 0, 0, 1]), IpAddr::from([203, 0, 113, 1])] {
        let a = client_addr(peer, hops.iter().copied(), &trusted);
        let b = client_addr(peer, hops.iter().copied(), &local);
        // A peer that is not trusted is always the answer.
        if !local.iter().any(|n| n.contains(peer)) {
            assert_eq!(b, peer);
        }
        let _ = (crate::app::limit_net(a), crate::app::limit_net(b));
    }
}

struct Harness {
    rt: tokio::runtime::Runtime,
    app: Arc<App>,
}

fn harness() -> &'static Harness {
    static H: OnceLock<Harness> = OnceLock::new();
    H.get_or_init(|| {
        let cfg = Config {
            origin: "http://127.0.0.1:8080".into(),
            old_origins: Vec::new(),
            bind: String::new(),
            db: ":memory:".into(),
            key_file: String::new(),
            client_dir: String::new(),
            realm: "global".into(),
            realms: vec!["global".into()],
            remote_homes: Vec::new(),
            any_home: false,
            trust_proxy: Vec::new(),
            limit_scale: 1_000_000,
            file_queue: 1 << 20,
            file_queue_total: 1 << 22,
            file_queue_sender: 1 << 19,
            file_queue_account: 1 << 21,
            push_hosts: Vec::new(),
            push_contact: String::new(),
        };
        let db = crate::db::Db::open(":memory:").expect("database");
        let app = crate::build(&cfg, db, [3; 32]).expect("app");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        Harness { rt, app }
    })
}

/// A WebSocket text frame from an authenticated device (`send`, `ack`, `relay`, `presence`, ...).
pub fn ws_frame(data: &[u8]) {
    let h = harness();
    let _guard = h.rt.enter();
    let _ = crate::ws::fuzz_frame(&h.app, ACCOUNT, &device().id, data);
    // Keep the database from growing across runs.
    let _ = h.app.db.purge(i64::MAX);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEEDS: &[&str] = &[
        "",
        "{}",
        "[]",
        "null",
        "{\"t\":\"ping\"}",
        "{\"t\":\"send\",\"to\":[{\"device\":\"x\",\"env\":\"y\",\"notify\":true}],\"id\":\"1\"}",
        "{\"t\":\"ack\",\"ids\":[1,2,3]}",
        "{\"t\":\"relay\",\"to\":\"x\",\"data\":\"y\",\"store\":true,\"ref\":\"r\"}",
        "{\"t\":\"relay-space\",\"devices\":[\"x\"],\"bytes\":99999999999999999,\"ref\":\"r\"}",
        "{\"t\":\"relay-ack\",\"ids\":[-1]}",
        "{\"t\":\"presence\",\"devices\":[\"a\",\"b\"]}",
        "{\"t\":\"push-sub\",\"endpoint\":\"https://fcm.googleapis.com/x\",\"ref\":\"r\"}",
        "{\"t\":\"prekey\",\"prekey\":{}}",
        "{\"entries\":[{\"v\":1}]}",
        "{\"id\":\"x\",\"key\":\"ed25519:AAAA\",\"label\":\"l\"}",
        "Alice%233F9C",
        "%zz%2",
        "1\n1.2.3.4, 10.0.0.1",
        "10.0.0.0/8,::1\njunk, 10.0.0.2\n::ffff:1.2.3.4",
        "https://rootcard.org/id",
        "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[",
    ];

    #[test]
    fn seeds_do_not_panic() {
        for s in SEEDS {
            json_body(s.as_bytes());
            http_text(s.as_bytes());
            ws_frame(s.as_bytes());
        }
        let deep = "[".repeat(100_000);
        json_body(deep.as_bytes());
        ws_frame(deep.as_bytes());
    }
}
