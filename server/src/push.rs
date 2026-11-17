//! Web Push without a payload (RFC 8030, VAPID RFC 8292): a wake-up that says only "something arrived".
//!
//! A device that asked for notifications gives the server the endpoint its browser got from the browser's push
//! service. When an envelope marked `notify` stays unacknowledged for a few seconds (the device is not connected, or
//! its page is frozen in the background), the server posts an empty message to that endpoint. The push service and
//! the server learn nothing about the content or the sender; the push service learns that this browser got a wake-up
//! from this server at that time. Endpoints are only accepted on allowlisted push hosts (no requests to arbitrary
//! addresses).

use crate::app::{App, Locked, now, random};
use crate::error::ApiError;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use rootcard::encoding::{base64url_encode, hex_decode, hex_encode};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Longest endpoint URL accepted.
const MAX_ENDPOINT: usize = 1024;
/// Wait this long for a connected device to acknowledge before waking it by push.
const ACK_WAIT: u64 = 4;
/// At most one push per device in this many seconds.
const MIN_GAP: i64 = 10;

/// The push sender: the server's VAPID key and what is scheduled.
pub struct Pusher {
    key: Option<SigningKey>,
    /// The public key browsers subscribe with (base64url of the uncompressed point).
    pub public: String,
    hosts: Vec<String>,
    contact: String,
    scheduled: Mutex<HashSet<String>>,
    last: Mutex<HashMap<String, i64>>,
}

impl Pusher {
    /// No push at all.
    pub fn disabled() -> Self {
        Pusher {
            key: None,
            public: String::new(),
            hosts: Vec::new(),
            contact: String::new(),
            scheduled: Mutex::default(),
            last: Mutex::default(),
        }
    }

    /// Load the VAPID key from the database, or create it. `hosts` are the push services endpoints may be on: host
    /// names (`fcm.googleapis.com`, `*.push.apple.com`), or whole origins for tests (`http://127.0.0.1:9`).
    pub fn open(db: &crate::db::Db, hosts: Vec<String>, contact: String) -> Result<Self, String> {
        if hosts.is_empty() {
            return Ok(Self::disabled());
        }
        let stored = db.setting("vapid_key").map_err(|e| e.to_string())?;
        let key = match stored {
            Some(h) => {
                let b = hex_decode(h.trim()).map_err(|_| "bad vapid key".to_string())?;
                SigningKey::from_slice(&b).map_err(|_| "bad vapid key".to_string())?
            }
            None => {
                let key = loop {
                    if let Ok(k) = SigningKey::from_slice(&random::<32>()) {
                        break k;
                    }
                };
                db.set_setting("vapid_key", &hex_encode(&key.to_bytes()))
                    .map_err(|e| e.to_string())?;
                key
            }
        };
        let public = base64url_encode(key.verifying_key().to_sec1_point(false).as_bytes());
        Ok(Pusher {
            key: Some(key),
            public,
            hosts,
            contact,
            scheduled: Mutex::default(),
            last: Mutex::default(),
        })
    }

    /// Whether push is available.
    pub fn enabled(&self) -> bool {
        self.key.is_some()
    }

    /// The origin of an acceptable endpoint (`scheme://host[:port]`), or an error.
    pub fn check_endpoint(&self, endpoint: &str) -> Result<String, ApiError> {
        let bad = ApiError::new(400, "bad_endpoint");
        if !self.enabled() {
            return Err(ApiError::new(404, "push_disabled"));
        }
        if endpoint.len() > MAX_ENDPOINT
            || !endpoint
                .bytes()
                .all(|b| b.is_ascii_graphic() && b != b'\\' && b != b'"')
        {
            return Err(bad);
        }
        let origin =
            crate::remote::origin_of(endpoint).ok_or(ApiError::new(400, "bad_endpoint"))?;
        if endpoint.len() <= origin.len() || origin.contains('@') {
            return Err(bad);
        }
        for h in &self.hosts {
            if h.contains("://") {
                if origin == *h {
                    return Ok(origin);
                }
                continue;
            }
            let Some(host) = origin.strip_prefix("https://") else {
                continue;
            };
            let ok = match h.strip_prefix("*.") {
                Some(suffix) => host
                    .strip_suffix(suffix)
                    .is_some_and(|rest| rest.ends_with('.') && rest.len() > 1),
                None => host == h,
            };
            if ok {
                return Ok(origin);
            }
        }
        Err(ApiError::new(403, "push_host_not_allowed"))
    }

    /// The `Authorization` header value for a push to `audience` (the endpoint's origin).
    fn authorization(&self, audience: &str) -> Option<String> {
        let key = self.key.as_ref()?;
        let header = base64url_encode(br#"{"alg":"ES256","typ":"JWT"}"#);
        // The audience and contact come from the configuration and the allowlist check: no quotes or backslashes.
        let claims = format!(
            r#"{{"aud":"{audience}","exp":{},"sub":"{}"}}"#,
            now() + 12 * 3600,
            self.contact
        );
        let unsigned = format!("{header}.{}", base64url_encode(claims.as_bytes()));
        let sig: Signature = key.sign(unsigned.as_bytes());
        Some(format!(
            "vapid t={unsigned}.{}, k={}",
            base64url_encode(&sig.to_bytes()),
            self.public
        ))
    }
}

/// What a push attempt led to.
enum Outcome {
    Sent,
    /// The subscription is gone (404/410): forget it.
    Gone,
    Failed,
}

fn post(endpoint: &str, authorization: &str) -> Outcome {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    let res = agent
        .post(endpoint)
        .header("Authorization", authorization)
        .header("TTL", "86400")
        .header("Urgency", "high")
        .header("Topic", "murmo")
        .send_empty();
    match res.map(|r| r.status().as_u16()) {
        Ok(200..=299) => Outcome::Sent,
        Ok(404 | 410) => Outcome::Gone,
        _ => Outcome::Failed,
    }
}

/// Wake `device` by push if envelope `id` (or a later one) is still unacknowledged after a short wait. Several
/// envelopes in a row lead to one push.
pub fn schedule(app: &Arc<App>, device: &str, id: i64) {
    if !app.push.enabled() {
        return;
    }
    {
        let mut g = app.push.scheduled.locked();
        if !g.insert(device.to_string()) {
            return;
        }
    }
    let app = app.clone();
    let device = device.to_string();
    tokio::spawn(async move {
        let last = app.push.last.locked().get(&device).copied().unwrap_or(0);
        let gap = u64::try_from(last + MIN_GAP - now()).unwrap_or(0);
        let wait = if app.hub.is_connected(&device) {
            ACK_WAIT
        } else {
            1
        };
        tokio::time::sleep(Duration::from_secs(wait.max(gap))).await;
        app.push.scheduled.locked().remove(&device);
        if !app.db.queued_since(&device, id).unwrap_or(false) {
            return;
        }
        let Ok(Some(endpoint)) = app.db.push_sub(&device) else {
            return;
        };
        let Ok(origin) = app.push.check_endpoint(&endpoint) else {
            return;
        };
        let Some(auth) = app.push.authorization(&origin) else {
            return;
        };
        {
            let mut g = app.push.last.locked();
            if g.len() > 100_000 {
                g.clear();
            }
            g.insert(device.clone(), now());
        }
        let outcome = tokio::task::spawn_blocking(move || post(&endpoint, &auth)).await;
        if matches!(outcome, Ok(Outcome::Gone)) {
            let _ = app.db.set_push_sub(&device, None);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pusher(hosts: &[&str]) -> Pusher {
        let db = crate::db::Db::open(":memory:").expect("db");
        Pusher::open(
            &db,
            hosts.iter().map(|s| s.to_string()).collect(),
            "https://murmo.example".into(),
        )
        .expect("pusher")
    }

    #[test]
    fn endpoints() {
        let p = pusher(&[
            "fcm.googleapis.com",
            "*.push.apple.com",
            "http://127.0.0.1:9",
        ]);
        assert!(
            p.check_endpoint("https://fcm.googleapis.com/fcm/send/abc")
                .is_ok()
        );
        assert!(p.check_endpoint("https://web.push.apple.com/abc").is_ok());
        assert!(p.check_endpoint("http://127.0.0.1:9/x").is_ok());
        for bad in [
            "http://fcm.googleapis.com/x",
            "https://fcm.googleapis.com",
            "https://evil.example/x",
            "https://fcm.googleapis.com.evil.example/x",
            "https://push.apple.com/x",
            "https://evilpush.apple.com/x",
            "https://user@fcm.googleapis.com/x",
            "https://fcm.googleapis.com:444/x",
            "http://127.0.0.1:99/x",
            "https://fcm.googleapis.com/a b",
        ] {
            assert!(p.check_endpoint(bad).is_err(), "{bad}");
        }
        assert!(
            Pusher::disabled()
                .check_endpoint("https://fcm.googleapis.com/x")
                .is_err()
        );
    }

    #[test]
    fn vapid_key_is_kept() {
        let db = crate::db::Db::open(":memory:").expect("db");
        let a = Pusher::open(&db, vec!["fcm.googleapis.com".into()], "x".into()).expect("a");
        let b = Pusher::open(&db, vec!["fcm.googleapis.com".into()], "x".into()).expect("b");
        assert_eq!(a.public, b.public);
        assert_eq!(a.public.len(), 87);
        let auth = a.authorization("https://fcm.googleapis.com").expect("auth");
        assert!(auth.starts_with("vapid t=") && auth.contains(", k="));
    }
}
