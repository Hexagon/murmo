// murmo protocol: device lists, prekeys, envelopes, signed messages, codes and file chunks (docs/DESIGN.md §4–§9).
// Pure functions over WebCrypto and the vendored rootcard core; no DOM, no storage, no network. Runs in browsers and
// in Node 22 (used by the end-to-end test).

import * as rc from "../vendor/rootcard/src/index.js";
import { frame, hkdf } from "../vendor/rootcard/src/crypto.js";
import { B32, base32Normalize } from "../vendor/rootcard/src/encoding.js";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export const LABELS = {
  // Signature and key-derivation labels keep the project's old name: changing them would invalidate existing data.
  devices: "mesg/devices/v1",
  prekey: "mesg/prekey/v1",
  wsAuth: "mesg/ws-auth/v1",
  message: "mesg/message/v1",
  box: "mesg/box/v1",
  safety: "mesg/safety/v1",
  link: "mesg/link-code/v1",
  local: "mesg/local/v1",
  paper: "murmo/paper-key/v1",
  paperCheck: "murmo/paper-key/check/v1",
};
export const MAX_ENTRIES = 32;
export const MAX_DEVICES = 8;
export const PREKEY_ROTATE = 7 * 24 * 3600;
export const PREKEY_KEEP = 21 * 24 * 3600;
export const CHUNK = 48 * 1024;
/**
 * The largest file. Files are read, stored and sent part by part, so this is not bounded by memory; the server's file
 * queue usually takes less (its `file_queue_limits`, compared with `queuedBytes`), and a larger file then goes live only.
 */
export const MAX_FILE = 1024 * 1024 * 1024;
/** How many CHUNK-sized parts a file of `size` bytes has (an empty file still has one). */
export const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK));
/**
 * Above this a file is not sent to any device by itself: the recipient chooses whether and on which device to take it
 * (mobile data). It goes only live, from the sending device, never through the file queue.
 */
export const ASK_ABOVE = 50 * 1024 * 1024;
/** The most parts a file can have. */
export const MAX_PARTS = chunkCount(MAX_FILE);
/**
 * The largest file shown or played in the conversation: it is put together in memory first (as a `Blob`). Larger
 * files are offered for saving only, written part by part where the browser allows it.
 */
export const MAX_INLINE = 100 * 1024 * 1024;
/**
 * Bytes a file of `size` bytes takes in the server's file queue, per device: the encrypted chunks as sent (base64
 * and framing), an upper bound. The unit of `relay-space` and of `file_queue_limits` in `/api/v1/info`.
 */
export const queuedBytes = (size) => Math.ceil(size * 1.4) + chunkCount(size) * 256;
/** The largest file (at most MAX_FILE) whose queued bytes fit in `limit`; -1 if not even an empty one does. */
export function largestQueued(limit) {
  if (!(limit >= queuedBytes(0))) return -1;
  let lo = 0;
  let hi = MAX_FILE;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (queuedBytes(mid) <= limit) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
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

export const KINDS = ["request", "accept", "text", "file", "sync", "history", "receipt", "reaction", "gifs", "retract", "edit", "ephemeral"];

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

// ── paper key (DESIGN.md §4.5) ──────────────────────────────────────────────────────────────────────────────────

/** The label of a paper key in a device list. Only for showing: devices are told apart by their keys. */
export const PAPER_LABEL = "Pappersnyckel";
const PAPER_BYTES = 20;

/** Whether a device of a list is a paper key (by its label; a paper key also never publishes a prekey). */
export const isPaper = (d) => d?.label === PAPER_LABEL;

async function paperChecksum(paper) {
  return rc.base32Encode(await sha256(frame(LABELS.paperCheck, paper))).slice(0, 4);
}

/** The written form of a paper key: `MPK-XXXX-…` (32 characters of key and 4 of checksum, Crockford base32). */
export async function formatPaperKey(paper) {
  const body = rc.base32Encode(paper) + (await paperChecksum(paper));
  const groups = [];
  for (let i = 0; i < body.length; i += 4) groups.push(body.slice(i, i + 4));
  return "MPK-" + groups.join("-");
}

/** Parse a typed paper key (case, spaces, dashes, I/L/O are forgiven); throws `bad_paper_key`. */
export async function parsePaperKey(text) {
  let s = base32Normalize(String(text ?? ""));
  if (s.length === 39 && s.startsWith("MPK")) s = s.slice(3);
  if (s.length !== 36 || [...s].some((c) => !B32.includes(c))) throw new Error("bad_paper_key");
  let paper;
  try {
    paper = rc.base32Decode(s.slice(0, 32), PAPER_BYTES);
  } catch {
    throw new Error("bad_paper_key");
  }
  if (s.slice(32) !== (await paperChecksum(paper))) throw new Error("bad_paper_key");
  return paper;
}

/**
 * The Ed25519 seed of a paper key's device. It needs both the paper and the account's local secret from the rootcard
 * vault (§8), which only the password unlocks: the paper alone, or the password alone, cannot add a device.
 */
export async function paperSeed(paper, localSecret, account) {
  return hkdf(paper, localSecret, frame(LABELS.paper, rc.canonical({ account })));
}

/** The device-list value `{ id, key, label }` of a paper key's seed. */
export async function paperDevice(seed) {
  const pub = await rc.ed25519Public(seed);
  return { id: await deviceId(pub), key: rc.formatKey("ed25519", pub), label: PAPER_LABEL };
}

/** A new paper key for an account: `{ paper, seed }`, drawn again while the seed is unusable (rootcard [CRY-9]). */
export async function newPaperKey(localSecret, account) {
  for (let i = 0; i < 64; i++) {
    const paper = random(PAPER_BYTES);
    const seed = await paperSeed(paper, localSecret, account);
    if (rc.usableSeed(seed)) return { paper, seed };
    paper.fill(0);
    seed.fill(0);
  }
  throw new Error("cannot create a usable key");
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

/**
 * A file name that is safe to show and to save: no control or bidirectional-formatting characters (which can make
 * `photo\u202Egpj.exe` look like `photoexe.jpg`), no path separators, not empty, at most 200 characters.
 */
export function safeFileName(name) {
  const s = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g, "")
    .replace(/[\/\\]/g, "_")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 200);
  return s || "fil";
}

/** A MIME type as sent by another device, or `application/octet-stream` when it is not a plain `type/subtype`. */
export function safeMime(mime) {
  const s = String(mime ?? "").toLowerCase().slice(0, 100);
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(s) ? s : "application/octet-stream";
}

/** Whether a file of this type and size is shown inline. */
export function inlineImage(mime, size) {
  return IMAGE_TYPES.includes(mime) && size <= 25 * 1024 * 1024;
}

/** Video types offered for playing in the conversation (whether the browser can decode one is known only by trying). */
export const VIDEO_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-m4v", "video/3gpp"];

/** Whether a file of this type and size can be played in the conversation instead of only saved. */
export function inlineVideo(mime, size) {
  return VIDEO_TYPES.includes(mime) && size <= MAX_INLINE;
}

/** Whether bytes start like a GIF file ("GIF87a" or "GIF89a"), whatever type the sender claimed. */
export function isGif(b) {
  if (!b || b.length < 6) return false;
  const sig = String.fromCharCode(...b.subarray(0, 6));
  return sig === "GIF87a" || sig === "GIF89a";
}

/** Inline images larger than this many pixels are offered only for saving (a small file can decode to gigabytes). */
export const MAX_PIXELS = 40_000_000;

/**
 * Width and height from the header of a PNG, GIF, JPEG or WebP, without decoding it; `null` when they cannot be
 * found in `head` (the first bytes of the file). For a GIF, the largest frame within the first bytes counts too.
 */
export function imageSize(head) {
  const b = head;
  const be16 = (o) => (b[o] << 8) | b[o + 1];
  const le16 = (o) => b[o] | (b[o + 1] << 8);
  const le24 = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  const be32 = (o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  const ascii = (o, s) => [...s].every((ch, j) => b[o + j] === ch.charCodeAt(0));
  if (b.length >= 24 && ascii(0, "\x89PNG\r\n\x1a\n") && ascii(12, "IHDR")) return { width: be32(16), height: be32(20) };
  if (b.length >= 10 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) {
    let width = le16(6);
    let height = le16(8);
    // Frames may claim more than the logical screen; look at the descriptors that are in `head`.
    let o = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0);
    const skip = (o) => {
      while (o < b.length && b[o]) o += b[o] + 1;
      return o + 1;
    };
    while (o < b.length) {
      if (b[o] === 0x21) o = skip(o + 2);
      else if (b[o] === 0x2c && o + 10 <= b.length) {
        width = Math.max(width, le16(o + 1) + le16(o + 5));
        height = Math.max(height, le16(o + 3) + le16(o + 7));
        o += 10 + (b[o + 9] & 0x80 ? 3 << ((b[o + 9] & 7) + 1) : 0);
        o = skip(o + 1);
      } else break;
    }
    return { width, height };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) return null;
      const m = b[o + 1];
      if (m === 0xff) {
        o++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        o += 2;
        continue;
      }
      if (m === 0xd9 || m === 0xda) return null; // end of image or scan before any frame header
      const len = be16(o + 2);
      const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (sof) return o + 9 <= b.length ? { width: be16(o + 7), height: be16(o + 5) } : null;
      if (len < 2) return null;
      o += 2 + len;
    }
    return null;
  }
  if (b.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8X")) return { width: le24(24) + 1, height: le24(27) + 1 };
    if (ascii(12, "VP8L") && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (ascii(12, "VP8 ") && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    }
  }
  return null;
}

/** Whether an image of this size may be decoded for showing inline. */
export function imageFits(size) {
  return !!size && size.width > 0 && size.height > 0 && size.width * size.height <= MAX_PIXELS;
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Incremental SHA-256 (WebCrypto hashes only whole buffers): files are hashed chunk by chunk as they are read or
 * arrive, so they never have to be in memory at once.
 */
export class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.w = new Uint32Array(64);
    this.buf = new Uint8Array(64);
    this.fill = 0;
    this.length = 0;
  }

  block(b, o) {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const h = this.h;
    let [a, bb, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh; // prettier-ignore
  }

  update(bytes) {
    let o = 0;
    this.length += bytes.length;
    if (this.fill) {
      const n = Math.min(64 - this.fill, bytes.length);
      this.buf.set(bytes.subarray(0, n), this.fill);
      this.fill += n;
      o = n;
      if (this.fill < 64) return this;
      this.block(this.buf, 0);
      this.fill = 0;
    }
    for (; o + 64 <= bytes.length; o += 64) this.block(bytes, o);
    this.buf.set(bytes.subarray(o), 0);
    this.fill = bytes.length - o;
    return this;
  }

  digest() {
    const bits = this.length * 8;
    const pad = new Uint8Array(((this.fill < 56 ? 56 : 120) - this.fill) + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32));
    dv.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    const out = new Uint8Array(32);
    const v = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) v.setUint32(4 * i, this.h[i]);
    return out;
  }
}
