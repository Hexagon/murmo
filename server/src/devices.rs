//! Device lists and signed prekeys (DESIGN.md §4, §5.2). Pure functions: no I/O, no clock.
//!
//! A device list is an append-only hash chain bound to the account key of the current rootcard instance. Entry 0 is
//! signed by that account key, every later entry by a device present after the previous entry. The server checks every
//! list it stores with [`verify_list`]; clients check the same rules themselves.

use crate::error::ApiError;
use rootcard::crypto::{ed25519_verify, frame, sha256};
use rootcard::encoding::{base64url_decode_fixed, base64url_encode};
use rootcard::json::{Map, Value, canonical};
use rootcard::keys::{KeyType, format_key, parse_key};

/// Label of device-list entries.
pub const DEVICES_LABEL: &str = "mesg/devices/v1";
/// Label of signed prekeys.
pub const PREKEY_LABEL: &str = "mesg/prekey/v1";
/// Label of the WebSocket authentication.
pub const WS_AUTH_LABEL: &str = "mesg/ws-auth/v1";
/// At most this many entries per list.
pub const MAX_ENTRIES: usize = 32;
/// At most this many devices present at once.
pub const MAX_DEVICES: usize = 8;
/// At most this many characters in a device label.
pub const MAX_LABEL: usize = 64;

/// A device present in a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    /// `base64url(SHA-256(key)[0..16])`.
    pub id: String,
    /// The Ed25519 device key.
    pub key: [u8; 32],
    /// A label chosen by the user.
    pub label: String,
}

/// A verified device list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceList {
    /// The entries as received.
    pub entries: Vec<Value>,
    /// The devices present after the last entry.
    pub present: Vec<Device>,
    /// The hash of the last entry, base64url.
    pub head: String,
}

impl DeviceList {
    /// The present device with this id.
    pub fn device(&self, id: &str) -> Option<&Device> {
        self.present.iter().find(|d| d.id == id)
    }
}

/// The device id of a device key.
pub fn device_id(key: &[u8; 32]) -> String {
    base64url_encode(&sha256(key)[..16])
}

/// The hash of an entry (signature included).
pub fn entry_hash(entry: &Value) -> String {
    base64url_encode(&sha256(&frame(DEVICES_LABEL, &canonical(entry))))
}

fn bad(code: &'static str) -> ApiError {
    ApiError::new(400, code)
}

fn obj(v: &Value) -> Result<&Map, ApiError> {
    v.as_object().ok_or_else(|| bad("bad_json"))
}

fn members(m: &Map, required: &[&str], optional: &[&str]) -> Result<(), ApiError> {
    for k in required {
        if m.get(k).is_none() {
            return Err(bad("bad_field"));
        }
    }
    for k in m.keys() {
        if !required.contains(&k) && !optional.contains(&k) {
            return Err(bad("bad_field"));
        }
    }
    Ok(())
}

fn string<'a>(m: &'a Map, k: &str) -> Result<&'a str, ApiError> {
    m.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| bad("bad_field"))
}

fn int(m: &Map, k: &str) -> Result<i64, ApiError> {
    m.get(k)
        .and_then(Value::as_int)
        .ok_or_else(|| bad("bad_field"))
}

fn ed_key(m: &Map, k: &str) -> Result<[u8; 32], ApiError> {
    parse_key(string(m, k)?, KeyType::Ed25519).map_err(|_| bad("bad_key"))
}

fn signature(m: &Map) -> Result<[u8; 64], ApiError> {
    base64url_decode_fixed::<64>(string(m, "sig")?).map_err(|_| bad("bad_signature"))
}

/// Verify `sig` over `frame(label, canonical(object without sig))`.
fn check_sig(label: &str, m: &Map, key: &[u8; 32]) -> Result<(), ApiError> {
    let sig = signature(m)?;
    let unsigned = Value::Object(m.without("sig"));
    ed25519_verify(key, &frame(label, &canonical(&unsigned)), &sig)
        .map_err(|_| bad("bad_signature"))
}

/// Parse and check a device object `{ id, key, label }`.
pub fn parse_device(v: &Value) -> Result<Device, ApiError> {
    let m = obj(v)?;
    members(m, &["id", "key", "label"], &[])?;
    let key = ed_key(m, "key")?;
    let id = string(m, "id")?;
    if id != device_id(&key) {
        return Err(bad("bad_device"));
    }
    let label = string(m, "label")?;
    if label.chars().count() > MAX_LABEL || label.chars().any(char::is_control) {
        return Err(bad("bad_field"));
    }
    Ok(Device {
        id: id.to_string(),
        key,
        label: label.to_string(),
    })
}

/// Verify a whole device list for `account` against the account key of its current rootcard instance.
pub fn verify_list(
    account: &str,
    account_key: &[u8; 32],
    entries: &[Value],
) -> Result<DeviceList, ApiError> {
    if entries.is_empty() || entries.len() > MAX_ENTRIES {
        return Err(bad("bad_devices"));
    }
    let instance = format_key(KeyType::Ed25519, account_key);
    let mut present: Vec<Device> = Vec::new();
    let mut prev: Option<String> = None;
    for (seq, entry) in entries.iter().enumerate() {
        let m = obj(entry)?;
        if seq == 0 {
            members(
                m,
                &[
                    "v", "account", "instance", "seq", "op", "device", "time", "signer", "sig",
                ],
                &[],
            )?;
        } else {
            members(
                m,
                &[
                    "v", "account", "instance", "seq", "prev", "op", "device", "time", "signer",
                    "sig",
                ],
                &[],
            )?;
        }
        if int(m, "v")? != 1
            || string(m, "account")? != account
            || string(m, "instance")? != instance
            || usize::try_from(int(m, "seq")?).ok() != Some(seq)
        {
            return Err(bad("bad_devices"));
        }
        if let Some(p) = &prev
            && string(m, "prev")? != p
        {
            return Err(bad("bad_devices"));
        }
        int(m, "time")?;
        let device = parse_device(m.get("device").ok_or_else(|| bad("bad_field"))?)?;
        let signer = string(m, "signer")?;
        let signer_key = if seq == 0 {
            if signer != "account" {
                return Err(bad("bad_devices"));
            }
            *account_key
        } else {
            present
                .iter()
                .find(|d| d.id == signer)
                .map(|d| d.key)
                .ok_or_else(|| bad("bad_signer"))?
        };
        check_sig(DEVICES_LABEL, m, &signer_key)?;
        match string(m, "op")? {
            "add" => {
                if present.iter().any(|d| d.id == device.id) {
                    return Err(bad("bad_devices"));
                }
                present.push(device);
                if present.len() > MAX_DEVICES {
                    return Err(bad("too_many_devices"));
                }
            }
            "remove" if seq > 0 => {
                let before = present.len();
                present.retain(|d| d.id != device.id);
                if present.len() == before {
                    return Err(bad("bad_devices"));
                }
            }
            _ => return Err(bad("bad_devices")),
        }
        prev = Some(entry_hash(entry));
    }
    Ok(DeviceList {
        entries: entries.to_vec(),
        present,
        head: prev.unwrap_or_default(),
    })
}

/// A verified signed prekey: its id and the whole object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prekey {
    /// The prekey id.
    pub id: String,
    /// The device it belongs to.
    pub device: String,
    /// The signed object.
    pub value: Value,
}

/// Verify a signed prekey of `device` (DESIGN.md §5.2).
pub fn verify_prekey(account: &str, device: &Device, v: &Value) -> Result<Prekey, ApiError> {
    let m = obj(v)?;
    members(
        m,
        &["v", "account", "device", "id", "key", "time", "sig"],
        &[],
    )?;
    if int(m, "v")? != 1 || string(m, "account")? != account || string(m, "device")? != device.id {
        return Err(bad("bad_prekey"));
    }
    let id = string(m, "id")?;
    base64url_decode_fixed::<8>(id).map_err(|_| bad("bad_prekey"))?;
    parse_key(string(m, "key")?, KeyType::X25519).map_err(|_| bad("bad_key"))?;
    int(m, "time")?;
    check_sig(PREKEY_LABEL, m, &device.key)?;
    Ok(Prekey {
        id: id.to_string(),
        device: device.id.clone(),
        value: v.clone(),
    })
}

/// The message a device signs to authenticate a WebSocket connection.
pub fn ws_auth_message(account: &str, device: &str, nonce: &str, origin: &str) -> Vec<u8> {
    let m = Map::new()
        .with("account", account)
        .with("device", device)
        .with("nonce", nonce)
        .with("origin", origin);
    frame(WS_AUTH_LABEL, &canonical(&Value::Object(m)))
}

/// Check a WebSocket authentication signature.
pub fn verify_ws_auth(
    device: &Device,
    account: &str,
    nonce: &str,
    origin: &str,
    sig: &str,
) -> Result<(), ApiError> {
    let sig = base64url_decode_fixed::<64>(sig).map_err(|_| ApiError::new(401, "bad_signature"))?;
    ed25519_verify(
        &device.key,
        &ws_auth_message(account, &device.id, nonce, origin),
        &sig,
    )
    .map_err(|_| ApiError::new(401, "bad_signature"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const ACCOUNT: &str = "acct";

    fn key(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }

    fn device_value(k: &SigningKey, label: &str) -> Value {
        let public = k.verifying_key().to_bytes();
        Map::new()
            .with("id", device_id(&public))
            .with("key", format_key(KeyType::Ed25519, &public))
            .with("label", label)
            .into()
    }

    fn sign(label: &str, m: Map, signer: &SigningKey) -> Value {
        let sig = signer.sign(&frame(label, &canonical(&Value::Object(m.clone()))));
        m.with("sig", base64url_encode(&sig.to_bytes())).into()
    }

    fn entry(
        account_key: &SigningKey,
        seq: i64,
        prev: Option<&Value>,
        op: &str,
        dev: &SigningKey,
        signer: (&str, &SigningKey),
    ) -> Value {
        let mut m = Map::new()
            .with("v", 1i64)
            .with("account", ACCOUNT)
            .with(
                "instance",
                format_key(KeyType::Ed25519, &account_key.verifying_key().to_bytes()),
            )
            .with("seq", seq)
            .with("op", op)
            .with("device", device_value(dev, "test"))
            .with("time", 1_763_150_000i64)
            .with("signer", signer.0);
        if let Some(p) = prev {
            m.insert("prev", entry_hash(p).into());
        }
        sign(DEVICES_LABEL, m, signer.1)
    }

    fn id_of(k: &SigningKey) -> String {
        device_id(&k.verifying_key().to_bytes())
    }

    #[test]
    fn genesis_add_and_remove() {
        let ak = key(1);
        let (d1, d2) = (key(2), key(3));
        let e0 = entry(&ak, 0, None, "add", &d1, ("account", &ak));
        let d1_id = id_of(&d1);
        let e1 = entry(&ak, 1, Some(&e0), "add", &d2, (&d1_id, &d1));
        let d2_id = id_of(&d2);
        let e2 = entry(&ak, 2, Some(&e1), "remove", &d1, (&d2_id, &d2));
        let list = verify_list(
            ACCOUNT,
            &ak.verifying_key().to_bytes(),
            &[e0, e1, e2.clone()],
        )
        .expect("valid");
        assert_eq!(list.present.len(), 1);
        assert_eq!(list.present[0].id, d2_id);
        assert_eq!(list.head, entry_hash(&e2));
    }

    #[test]
    fn password_alone_cannot_add_a_device() {
        // The account key (which a password thief can get) may sign only entry 0.
        let ak = key(1);
        let (d1, thief) = (key(2), key(9));
        let e0 = entry(&ak, 0, None, "add", &d1, ("account", &ak));
        let e1 = entry(&ak, 1, Some(&e0), "add", &thief, ("account", &ak));
        let err = verify_list(ACCOUNT, &ak.verifying_key().to_bytes(), &[e0, e1])
            .expect_err("an account-signed entry after genesis");
        assert_eq!(err.code, "bad_signer");
    }

    #[test]
    fn rejects_wrong_instance_broken_chain_and_bad_signature() {
        let ak = key(1);
        let other = key(7);
        let d1 = key(2);
        let e0 = entry(&ak, 0, None, "add", &d1, ("account", &ak));
        assert!(
            verify_list(
                ACCOUNT,
                &other.verifying_key().to_bytes(),
                std::slice::from_ref(&e0)
            )
            .is_err()
        );

        let d1_id = id_of(&d1);
        let unrelated = entry(&ak, 0, None, "add", &key(5), ("account", &ak));
        let e1 = entry(&ak, 1, Some(&unrelated), "add", &key(3), (&d1_id, &d1));
        assert!(verify_list(ACCOUNT, &ak.verifying_key().to_bytes(), &[e0.clone(), e1]).is_err());

        let mut tampered = e0.as_object().expect("object").clone();
        tampered.insert("time", 1i64.into());
        assert!(
            verify_list(
                ACCOUNT,
                &ak.verifying_key().to_bytes(),
                &[Value::Object(tampered)]
            )
            .is_err()
        );
    }

    #[test]
    fn genesis_cannot_remove_and_duplicates_are_refused() {
        let ak = key(1);
        let d1 = key(2);
        let e0 = entry(&ak, 0, None, "remove", &d1, ("account", &ak));
        assert!(verify_list(ACCOUNT, &ak.verifying_key().to_bytes(), &[e0]).is_err());
        let e0 = entry(&ak, 0, None, "add", &d1, ("account", &ak));
        let d1_id = id_of(&d1);
        let e1 = entry(&ak, 1, Some(&e0), "add", &d1, (&d1_id, &d1));
        assert!(verify_list(ACCOUNT, &ak.verifying_key().to_bytes(), &[e0, e1]).is_err());
    }

    #[test]
    fn prekeys_and_ws_auth() {
        let d = key(2);
        let public = d.verifying_key().to_bytes();
        let dev = Device {
            id: device_id(&public),
            key: public,
            label: "x".into(),
        };
        let pk = Map::new()
            .with("v", 1i64)
            .with("account", ACCOUNT)
            .with("device", dev.id.as_str())
            .with("id", base64url_encode(&[7u8; 8]))
            .with("key", format_key(KeyType::X25519, &[9u8; 32]))
            .with("time", 5i64);
        let signed = sign(PREKEY_LABEL, pk, &d);
        assert!(verify_prekey(ACCOUNT, &dev, &signed).is_ok());
        assert!(verify_prekey("other", &dev, &signed).is_err());

        let sig = d.sign(&ws_auth_message(
            ACCOUNT,
            &dev.id,
            "nonce",
            "https://m.example",
        ));
        let s = base64url_encode(&sig.to_bytes());
        assert!(verify_ws_auth(&dev, ACCOUNT, "nonce", "https://m.example", &s).is_ok());
        assert!(verify_ws_auth(&dev, ACCOUNT, "nonce", "https://evil.example", &s).is_err());
    }

    #[test]
    fn verifies_lists_and_prekeys_made_by_the_js_client() {
        // Written by tests/protocol.test.mjs: the client and the server must agree byte for byte.
        let f = rootcard::parse_json(include_bytes!("../tests/fixtures/js-device-list.json"))
            .expect("fixture");
        let m = f.as_object().expect("object");
        let s = |k: &str| {
            m.get(k)
                .and_then(Value::as_str)
                .expect("string")
                .to_string()
        };
        let account_key = parse_key(&s("account_key"), KeyType::Ed25519).expect("key");
        let entries = m.get("entries").and_then(Value::as_array).expect("entries");
        let list = verify_list(&s("account"), &account_key, entries).expect("valid list");
        assert_eq!(list.head, s("head"));
        assert_eq!(list.present.len(), 2);
        let dev = parse_device(m.get("prekey_device").expect("device")).expect("device");
        verify_prekey(&s("account"), &dev, m.get("prekey").expect("prekey")).expect("valid prekey");
    }
}
