// mesg protocol: device lists, prekeys, envelopes, signed messages, codes and file chunks (docs/DESIGN.md §4–§9).
// Pure functions over WebCrypto and the vendored rootcard core; no DOM, no storage, no network. Runs in browsers and
// in Node 22 (used by the end-to-end test).

import * as rc from "../vendor/rootcard/src/index.js";
import { frame } from "../vendor/rootcard/src/crypto.js";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export const LABELS = {
  devices: "mesg/devices/v1",
  prekey: "mesg/prekey/v1",
  wsAuth: "mesg/ws-auth/v1",
  message: "mesg/message/v1",
  box: "mesg/box/v1",
  safety: "mesg/safety/v1",
  link: "mesg/link-code/v1",
  local: "mesg/local/v1",
};
export const MAX_ENTRIES = 32;
export const MAX_DEVICES = 8;
export const PREKEY_ROTATE = 7 * 24 * 3600;
export const PREKEY_KEEP = 21 * 24 * 3600;
export const CHUNK = 48 * 1024;
export const MAX_FILE = 100 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export const b64 = rc.base64urlEncode;
export const unb64 = rc.base64urlDecode;
export const now = () => Math.floor(Date.now() / 1000);
export const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const utf8 = (s) => enc.encode(s);
export const sha256 = async (m) => new Uint8Array(await subtle.digest("SHA-256", m));

/** `{...o}` without `sig`. */
function unsigned(o) {
  const c = { ...o };
  delete c.sig;
  return c;
}

/** Strict canonical JSON of a value as base64url (the form the server relays and stores). */
export const pack = (v) => b64(rc.canonical(v));
/** The inverse of pack, with rootcard's strict parser. */
export const unpack = (s) => rc.parseJson(unb64(s));

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function rawPublic(key) {
  return new Uint8Array(await subtle.exportKey("raw", key));
}

/**
 * A new key pair whose private key can be stored wrapped (PKCS #8) and re-imported as non-extractable.
 * WebKit rejects some private keys on import (about 1 in 256, see rootcard [CRY-9]); such keys are drawn again.
 * Returns `{ privateKey (non-extractable), publicRaw, pkcs8 }`.
 */
export async function newKeyPair(alg) {
  const usages = alg === "Ed25519" ? ["sign", "verify"] : ["deriveBits"];
  const privUsages = alg === "Ed25519" ? ["sign"] : ["deriveBits"];
  for (let i = 0; i < 64; i++) {
    const kp = await subtle.generateKey({ name: alg }, true, usages);
    const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", kp.privateKey));
    try {
      const privateKey = await subtle.importKey("pkcs8", pkcs8, { name: alg }, false, privUsages);
      return { privateKey, publicRaw: await rawPublic(kp.publicKey), pkcs8 };
    } catch {
      pkcs8.fill(0);
    }
  }
  throw new Error("cannot create a usable key");
}

/** Import a stored PKCS #8 private key as non-extractable. */
export async function importPrivate(alg, pkcs8) {
  return subtle.importKey("pkcs8", pkcs8, { name: alg }, false, alg === "Ed25519" ? ["sign"] : ["deriveBits"]);
}

/** Sign `frame(label, canonical(object without sig))` with a device key (CryptoKey) or a 32-byte seed. */
export async function signObject(label, o, key) {
  const m = frame(label, rc.canonical(unsigned(o)));
  const sig = key instanceof Uint8Array ? await rc.ed25519Sign(key, m) : new Uint8Array(await subtle.sign("Ed25519", key, m));
  return { ...unsigned(o), sig: b64(sig) };
}

/** Strict verification of a signed object against a raw Ed25519 public key; throws `bad_signature`. */
export async function verifyObject(label, o, publicRaw) {
  if (typeof o.sig !== "string") throw new Error("bad_signature");
  await rc.ed25519Verify(publicRaw, frame(label, rc.canonical(unsigned(o))), unb64(o.sig));
}

export async function deviceId(publicRaw) {
  return b64((await sha256(publicRaw)).subarray(0, 16));
}

// ── device lists (DESIGN.md §4.1) ───────────────────────────────────────────────────────────────────────────────

export async function entryHash(entry) {
  return b64(await sha256(frame(LABELS.devices, rc.canonical(entry))));
}

/** A new entry after `entries` (empty for the genesis), signed by `signer` = { id: "account" | device id, key }. */
export async function newEntry({ account, accountKey, entries, op, device, signer }) {
  const e = {
    v: 1,
    account,
    instance: accountKey,
    seq: entries.length,
    op,
    device,
    time: now(),
    signer: signer.id,
  };
  if (entries.length > 0) e.prev = await entryHash(entries[entries.length - 1]);
  return signObject(LABELS.devices, e, signer.key);
}

/**
 * Verify a device list against the account key (`ed25519:…`) of the current instance of a verified rootcard log.
 * Returns `{ entries, present: [{ id, key, keyRaw, label }], head }`. Mirrors server/src/devices.rs.
 */
export async function verifyDevices(account, accountKey, entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) throw new Error("bad_devices");
  const accountRaw = rc.parseKey(accountKey, "ed25519");
  const present = [];
  let prev;
  for (let seq = 0; seq < entries.length; seq++) {
    const e = entries[seq];
    const want = ["v", "account", "instance", "seq", "op", "device", "time", "signer", "sig", ...(seq ? ["prev"] : [])];
    const keys = Object.keys(e);
    if (keys.length !== want.length || !want.every((k) => k in e)) throw new Error("bad_devices");
    if (e.v !== 1 || e.account !== account || e.instance !== accountKey || e.seq !== seq) throw new Error("bad_devices");
    if (seq && e.prev !== prev) throw new Error("bad_devices");
    if (!Number.isSafeInteger(e.time)) throw new Error("bad_devices");
    const d = e.device;
    if (!d || Object.keys(d).length !== 3 || typeof d.label !== "string" || d.label.length > 64) throw new Error("bad_devices");
    const keyRaw = rc.parseKey(d.key, "ed25519");
    if (d.id !== (await deviceId(keyRaw))) throw new Error("bad_devices");
    let signerKey;
    if (seq === 0) {
      if (e.signer !== "account") throw new Error("bad_devices");
      signerKey = accountRaw;
    } else {
      const s = present.find((p) => p.id === e.signer);
      if (!s) throw new Error("bad_signer");
      signerKey = s.keyRaw;
    }
    await verifyObject(LABELS.devices, e, signerKey);
    if (e.op === "add") {
      if (present.some((p) => p.id === d.id)) throw new Error("bad_devices");
      present.push({ id: d.id, key: d.key, keyRaw, label: d.label });
      if (present.length > MAX_DEVICES) throw new Error("too_many_devices");
    } else if (e.op === "remove" && seq > 0) {
      const i = present.findIndex((p) => p.id === d.id);
      if (i < 0) throw new Error("bad_devices");
      present.splice(i, 1);
    } else throw new Error("bad_devices");
    prev = await entryHash(e);
  }
  return { entries, present, head: prev };
}

/** Whether `next` (verified) extends the list whose head is `pinned` after `pinnedLength` entries. */
export async function extendsPinned(next, pinnedHead, pinnedLength) {
  if (!pinnedHead) return true;
  if (next.entries.length < pinnedLength) return false;
  return (await entryHash(next.entries[pinnedLength - 1])) === pinnedHead;
}

// ── prekeys (DESIGN.md §5.2) ────────────────────────────────────────────────────────────────────────────────────

/** A new signed prekey for `device` = { id, privateKey }. Returns `{ value, secret: { id, privateKey, pkcs8, time } }`. */
export async function newPrekey(account, device) {
  const kp = await newKeyPair("X25519");
  const id = b64(random(8));
  const value = await signObject(
    LABELS.prekey,
    { v: 1, account, device: device.id, id, key: rc.formatKey("x25519", kp.publicRaw), time: now() },
    device.privateKey,
  );
  return { value, secret: { id, privateKey: kp.privateKey, pkcs8: kp.pkcs8, time: value.time } };
}

export async function verifyPrekey(account, device, p) {
  if (p.v !== 1 || p.account !== account || p.device !== device.id || typeof p.id !== "string") throw new Error("bad_prekey");
  rc.parseKey(p.key, "x25519");
  await verifyObject(LABELS.prekey, p, device.keyRaw);
  return p;
}

// ── WebSocket authentication ────────────────────────────────────────────────────────────────────────────────────

export async function wsAuth(account, device, nonce, origin) {
  const m = frame(LABELS.wsAuth, rc.canonical({ account, device: device.id, nonce, origin }));
  return b64(new Uint8Array(await subtle.sign("Ed25519", device.privateKey, m)));
}

// ── envelopes (DESIGN.md §5.1) ──────────────────────────────────────────────────────────────────────────────────

async function boxKey(sharedBits, epkRaw, spkRaw, usage) {
  const shared = new Uint8Array(sharedBits);
  if (shared.every((b) => b === 0)) throw new Error("bad_key");
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  shared.fill(0);
  const salt = new Uint8Array(64);
  salt.set(epkRaw, 0);
  salt.set(spkRaw, 32);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8(LABELS.box) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** Encrypt `plaintext` (bytes) to a recipient device's verified prekey. Returns the packed envelope string. */
export async function seal(toDevice, prekey, plaintext) {
  const spkRaw = rc.parseKey(prekey.key, "x25519");
  const eph = await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  const epkRaw = await rawPublic(eph.publicKey);
  const spk = await subtle.importKey("raw", spkRaw, { name: "X25519" }, false, []);
  const bits = await subtle.deriveBits({ name: "X25519", public: spk }, eph.privateKey, 256);
  const key = await boxKey(bits, epkRaw, spkRaw, "encrypt");
  const head = { v: 1, to: toDevice, spk: prekey.id, epk: rc.formatKey("x25519", epkRaw) };
  const n = random(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: n, additionalData: rc.canonical(head) }, key, plaintext));
  return pack({ ...head, n: b64(n), ct: b64(ct) });
}

/** Decrypt a packed envelope for `myDevice` with `prekeys` = Map id → { privateKey }. Returns plaintext bytes. */
export async function open(myDevice, prekeys, packed) {
  const env = unpack(packed);
  if (env.v !== 1 || env.to !== myDevice || typeof env.spk !== "string") throw new Error("bad_envelope");
  const pk = prekeys.get(env.spk);
  if (!pk) throw new Error("unknown_prekey");
  const epkRaw = rc.parseKey(env.epk, "x25519");
  const spkRaw = pk.publicRaw;
  const epk = await subtle.importKey("raw", epkRaw, { name: "X25519" }, false, []);
  const bits = await subtle.deriveBits({ name: "X25519", public: epk }, pk.privateKey, 256);
  const key = await boxKey(bits, epkRaw, spkRaw, "decrypt");
  const head = { v: 1, to: env.to, spk: env.spk, epk: env.epk };
  return new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv: unb64(env.n), additionalData: rc.canonical(head) }, key, unb64(env.ct)),
  );
}

// ── messages (DESIGN.md §5.3) ───────────────────────────────────────────────────────────────────────────────────

export const KINDS = ["request", "accept", "text", "file", "sync", "history"];

/** A signed message as bytes. */
export async function signMessage(fields, deviceKey) {
  const m = await signObject(LABELS.message, { v: 1, ...fields }, deviceKey);
  return rc.canonical(m);
}

/**
 * Parse and check a decrypted message. `lookupDevice(account, deviceId)` returns the sender's verified device
 * (`{ keyRaw }`) or undefined. Checks recipient, conversation membership and the signature.
 */
export async function verifyMessage(bytes, me, lookupDevice) {
  const m = rc.parseJson(bytes);
  if (m.v !== 1 || !KINDS.includes(m.kind) || typeof m.id !== "string" || !Number.isSafeInteger(m.time)) throw new Error("bad_message");
  if (!m.to || m.to.account !== me.account || m.to.device !== me.device) throw new Error("not_for_me");
  if (!m.from || typeof m.from.account !== "string" || typeof m.conv !== "string") throw new Error("bad_message");
  // Own devices may write about any conversation; anyone else only about the one with us.
  if (m.from.account !== me.account && m.conv !== me.account) throw new Error("bad_conversation");
  const dev = await lookupDevice(m.from.account, m.from.device);
  if (!dev) throw new Error("unknown_sender_device");
  await verifyObject(LABELS.message, m, dev.keyRaw);
  return m;
}

// ── codes ───────────────────────────────────────────────────────────────────────────────────────────────────────

function digits(hash, groups) {
  const out = [];
  for (let i = 0; i < groups; i++) out.push((((hash[2 * i] << 8) | hash[2 * i + 1]) % 10000).toString().padStart(4, "0"));
  return out.join(" ");
}

/** The safety code of a conversation: both accounts with their device-list heads. */
export async function safetyCode(a, b) {
  const pair = [a, b].map((x) => ({ account: x.account, head: x.head })).sort((x, y) => (x.account < y.account ? -1 : 1));
  return digits(await sha256(frame(LABELS.safety, rc.canonical(pair))), 12);
}

/** The code both screens show while linking a device. */
export async function linkCode(account, deviceKey, requestId) {
  return digits(await sha256(frame(LABELS.link, rc.canonical({ account, device: deviceKey, request: requestId }))), 6);
}

// ── local key (DESIGN.md §8) ────────────────────────────────────────────────────────────────────────────────────

/** The device's local AES-GCM key from the vault-held local secret and the device's salt; non-extractable. */
export async function localKey(secret, salt) {
  const ikm = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8(LABELS.local) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** The device's local index key (HMAC-SHA-256) for opaque record keys; non-extractable. */
export async function localIndexKey(secret, salt) {
  const ikm = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8(LABELS.local + "/index") },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** An opaque, stable tag for a value (conversation ids in the local database). */
export async function indexTag(key, value) {
  return b64(new Uint8Array(await subtle.sign("HMAC", key, utf8(value))).subarray(0, 16));
}

export async function encryptLocal(key, bytes, aad) {
  const n = random(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: n, additionalData: utf8(aad) }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(n);
  out.set(ct, 12);
  return out;
}

export async function decryptLocal(key, blob, aad) {
  return new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12), additionalData: utf8(aad) }, key, blob.subarray(12)),
  );
}

// ── files (DESIGN.md §9) ────────────────────────────────────────────────────────────────────────────────────────

function chunkNonce(i) {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setUint32(8, i);
  return n;
}

export async function newFileKey() {
  return random(32);
}

async function fileCryptoKey(raw, usage) {
  return subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

/** Encrypt chunk `i` of `n`; returns the packed relay payload. */
export async function encryptChunk(fileKeyRaw, f, i, n, bytes) {
  const key = await fileCryptoKey(fileKeyRaw, "encrypt");
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: chunkNonce(i), additionalData: utf8(`${f}:${i}:${n}`) }, key, bytes),
  );
  return pack({ k: "chunk", f, i, n, c: b64(ct) });
}

export async function decryptChunk(fileKeyRaw, p) {
  const key = await fileCryptoKey(fileKeyRaw, "decrypt");
  return new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv: chunkNonce(p.i), additionalData: utf8(`${p.f}:${p.i}:${p.n}`) }, key, unb64(p.c)),
  );
}

/** Whether a file of this type and size is shown inline. */
export function inlineImage(mime, size) {
  return IMAGE_TYPES.includes(mime) && size <= 25 * 1024 * 1024;
}
