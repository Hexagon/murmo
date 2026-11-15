// The messenger engine: devices, contacts and requests, messages, multi-device sync, history hand-over and live
// file transfer (docs/DESIGN.md). No DOM: the UI listens to events.
//
// Events: "status" (online/offline), "contacts", "messages" ({ conv }), "gifs" (the collection changed), "link"
// ({ request, code }), "file" ({ f }), "incoming" ({ conv, kind }: something from a contact the user should hear
// about), "removed" (this device was removed), "error" ({ message }).

import * as rc from "../vendor/rootcard/src/index.js";
import * as p from "./protocol.js";
import { Store } from "./store.js";
import { Socket } from "./net.js";
import { fetchState, lookup, proveToServer } from "./identity.js";
import { ApiError } from "./api.js";
import { emojiOnly } from "./emoji.js";

const LIST_TTL = 60_000;
const NOTE_MAX = 500;
const TEXT_MAX = 8000;
const HISTORY_CHUNK = 40 * 1024;
/** Message kinds the recipient should be notified about (the server only sees the flag, DESIGN.md §10.1). */
const NOTIFY_KINDS = ["request", "text", "file", "ephemeral"];
/** Timers a disappearing message can be sent with (seconds, DESIGN.md §6.8). */
export const EPHEMERAL_TTLS = [15, 60, 300, 3600];
/** Longest a disappearing message waits unread (in the mailbox or unseen on a device) before it is gone anyway. */
export const EPHEMERAL_WAIT = 7 * 24 * 3600;
/** A file nobody could take is offered again for this long (the mailbox lifetime). */
const FILE_RETRY = 14 * 24 * 3600;
const FILE_RETRY_EVERY = 60_000;
// Chunks that come before their `file` message wait in IndexedDB, within these limits (bytes): per sender account
// and for all senders. More is not taken (a queued chunk is then not acknowledged, so it comes again later).
const EARLY_SENDER = 16 * 1024 * 1024;
const EARLY_TOTAL = 64 * 1024 * 1024;
const EARLY_KEEP = 10 * 60_000;
/** How long the server keeps a link request (docs/DESIGN.md §4.3). */
const LINK_TTL = 10 * 60_000;
const MAX_CHUNK_TEXT = Math.ceil((p.CHUNK + 16) / 3) * 4; // base64url of one encrypted chunk
const IMAGE_HEAD = 256 * 1024; // where the dimensions of an image must be found
const OFFLINE = ["offline", "disconnected", "timeout"];
/** Receipts are collected for this long and sent together (a mailbox read after a while away is one receipt). */
const RECEIPT_WAIT = 400;
const RECEIPT_MAX = 200;
/** Longest retention a conversation can be set to (seconds); 0 keeps messages until the conversation is deleted. */
export const RETENTION_MAX = 10 * 365 * 24 * 3600;
const PRUNE_EVERY = 60_000;
/** The user's own GIF collection, kept encrypted on this device only (docs/DESIGN.md §9.2). */
export const GIF_MAX_BYTES = 8 * 1024 * 1024;
export const GIF_MAX_COUNT = 60;
/** The file id a saved GIF is stored and streamed under (apart from the files of messages). */
const gifFile = (id) => `gif:${id}`;
/** A saved GIF as the file it is streamed as (Messenger.streamFile, expectFile). */
const gifStream = (g) => ({ f: gifFile(g.id), key: g.key, n: g.n, size: g.size, sha256: g.sha256 });
/** Message kinds a reaction can be given to. */
const REACTABLE = ["text", "file", "ephemeral"];
/** What a disappearing message leaves behind once gone: no content, only its id, so a copy that comes again is ignored. */
const GONE = "gone";
/** How long after sending a message can be taken back from everyone (seconds, DESIGN.md §6.6). */
export const RETRACT_WINDOW = 24 * 3600;
/** How long after a message arrived on this device a retraction is still taken (it may wait in the mailbox). */
const RETRACT_LATEST = (14 * 86400 + RETRACT_WINDOW) * 1000;
/** Records that stand in for a message that is gone: kept so that a late copy of it does not come back. */
const TOMBSTONES = ["retracted", "deleted", GONE];
/** Whether a stored record is one the user does not see (a hidden tombstone). */
const hidden = (m) => m.kind === "deleted" || m.kind === GONE || (m.kind === "retracted" && m.pending);

/** Whether `t` is a timer (seconds) a received disappearing message may carry. */
export function validTtl(t) {
  return Number.isSafeInteger(t) && t >= 1 && t <= EPHEMERAL_WAIT;
}

/** A reaction is one emoji (`""` takes one's reaction back). */
export function validReaction(e) {
  return e === "" || (typeof e === "string" && e.length <= 32 && !/\s/u.test(e) && emojiOnly(e, 1));
}

/** A GIF of the collection as another own device describes it ("gifs" message), or null when it is not well formed. */
function gifEntry(g) {
  if (!g || typeof g !== "object") return null;
  const { id, size, n, sha256, key, width, height } = g;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
  if (!Number.isSafeInteger(size) || size < 1 || size > GIF_MAX_BYTES || n !== p.chunkCount(size)) return null;
  if (typeof sha256 !== "string" || sha256.length > 64 || typeof key !== "string" || key.length > 64) return null;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !p.imageFits({ width, height })) return null;
  return { id, size, n, sha256, key, width, height };
}

/** Whether `r` is a retention in seconds this client accepts (0: keep). */
export function validRetention(r) {
  return Number.isInteger(r) && r >= 0 && r <= RETENTION_MAX;
}

/**
 * Prepare this browser as a device of the account after a login (docs/DESIGN.md §4.2, §4.3).
 * Returns `{ ready: true }`, or `{ ready: false, code, expires, waitForApproval(), approveWithPaperKey() }` while
 * another device must approve. `waitForApproval` resolves to true once approved, false when cancelled or when the
 * request has expired (`expires`, ms since the epoch: the server keeps link requests for 10 minutes).
 * `approveWithPaperKey(text)` adds this device with the account's paper key instead (§4.5); it needs `secret`, the
 * local secret from the vault, and throws `bad_paper_key` or `wrong_paper_key`.
 */
export async function setupDevice({ api, store, state, login, label, secret }) {
  const account = state.account;
  const accountKey = state.instance.account_key;
  let device = await loadDevice(store);
  const remote = await api.devices(account);
  let list = remote.entries.length ? await p.verifyDevices(account, accountKey, remote.entries) : null;
  if (device && list && !list.present.some((d) => d.id === device.id)) {
    // This device was removed, or belongs to an earlier instance: start over as a new device.
    await store.deleteMeta("device");
    device = null;
  }
  if (device && list) return { ready: true };
  if (device && !list) device = null;

  const kp = await p.newKeyPair("Ed25519");
  device = { id: await p.deviceId(kp.publicRaw), privateKey: kp.privateKey, publicRaw: kp.publicRaw, label };
  const pk = await p.newPrekey(account, device);
  const deviceValue = { id: device.id, key: rc.formatKey("ed25519", kp.publicRaw), label };
  await store.setSecret("device", { pkcs8: kp.pkcs8, label });
  await store.setSecret("prekeys", [{ ...pk.secret, publicRaw: rc.parseKey(pk.value.key, "x25519") }]);
  await store.setMeta("device", { id: device.id, publicRaw: kp.publicRaw });

  if (!list) {
    // The first device of this instance: entry 0 signed with the account key.
    const e0 = await p.newEntry({
      account, accountKey, entries: [], op: "add", device: deviceValue,
      signer: { id: "account", key: login.unlocked.contents.accountSeed },
    });
    await api.appendDevices(account, [e0], [pk.value]);
    return { ready: true };
  }

  // Another device must approve (a password alone cannot add a device).
  const request = { v: 1, account, id: p.b64(p.random(16)), device: deviceValue, prekey: pk.value, time: p.now() };
  const { proof, nonce } = await proveToServer(api, state, login.unlocked.contents.accountSeed);
  await api.link(account, request, proof, nonce);
  const code = await p.linkCode(account, deviceValue.key, request.id);
  const expires = Date.now() + LINK_TTL;
  return {
    ready: false,
    code,
    expires,
    async approveWithPaperKey(text) {
      if (!secret) throw new ApiError(400, "wrong_paper_key");
      let paper;
      try {
        paper = await p.parsePaperKey(text);
      } catch {
        throw new ApiError(400, "bad_paper_key");
      }
      const seed = await p.paperSeed(paper, secret, account);
      paper.fill(0);
      try {
        const paperDev = await p.paperDevice(seed);
        const r = await api.devices(account);
        const l = r.entries.length ? await p.verifyDevices(account, accountKey, r.entries) : null;
        if (l?.present.some((d) => d.id === device.id)) return true; // approved meanwhile
        if (!l?.present.some((d) => d.id === paperDev.id)) throw new ApiError(400, "wrong_paper_key");
        const e = await p.newEntry({
          account, accountKey, entries: l.entries, op: "add", device: deviceValue,
          signer: { id: paperDev.id, key: seed },
        });
        await api.appendDevices(account, [e], [pk.value]);
        return true;
      } finally {
        seed.fill(0);
      }
    },
    async waitForApproval(signal) {
      while (!signal?.aborted && Date.now() < expires) {
        await new Promise((r) => setTimeout(r, 3000));
        const r = await api.devices(account);
        if (r.entries.length) {
          const l = await p.verifyDevices(account, accountKey, r.entries);
          if (l.present.some((d) => d.id === device.id)) return true;
        }
      }
      return false;
    },
  };
}

async function loadDevice(store) {
  const meta = await store.meta("device");
  const sec = await store.secret("device");
  if (!meta || !sec) return null;
  return { id: meta.id, publicRaw: meta.publicRaw, privateKey: await p.importPrivate("Ed25519", sec.pkcs8), label: sec.label };
}

export class Messenger extends EventTarget {
  /** `fileQueue()`: whether the server may keep encrypted file chunks for devices that are away (a setting). */
  constructor({ api, store, account, handle, home, realms, fileQueue = () => true }) {
    super();
    this.fileQueue = fileQueue;
    this.pendingFiles = []; // [{ conv, id, time }] files some device has not been given yet
    this.missed = new Map(); // f → Set(device): "relay-missed" during a transfer
    this.refused = new Set(); // refs of transfers of which the server refused a chunk
    this.api = api;
    this.store = store;
    this.me = { account, device: null };
    this.handle = handle;
    this.home = home;
    this.realms = realms;
    this.lists = new Map(); // account → { state, list, prekeys: Map, at }
    this.contacts = new Map();
    this.prekeys = new Map(); // id → { privateKey, publicRaw, time }
    this.files = new Map(); // f → transfer state, see fileState()
    this.fileWork = Promise.resolve(); // chunks and file messages are handled one at a time
    this.status = "offline";
    this.receipts = new Map(); // account → Set(message id): arrived here, the sender is told soon
    this.early = new Set(); // receipts that came before this device had stored the message
    this.timed = new Map(); // message id → { conv, at (ms) }: disappearing messages and what they leave, by deadline
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async start() {
    const device = await loadDevice(this.store);
    if (!device) throw new Error("no_device");
    this.device = device;
    this.me.device = device.id;
    for (const s of (await this.store.secret("prekeys")) ?? []) {
      this.prekeys.set(s.id, { privateKey: await p.importPrivate("X25519", s.pkcs8), publicRaw: s.publicRaw, time: s.time, pkcs8: s.pkcs8 });
    }
    for (const c of await this.store.contacts()) this.contacts.set(c.account, c);
    this.pendingFiles = (await this.store.secret("pendingFiles")) ?? [];
    for (const t of (await this.store.secret("timed")) ?? []) this.timed.set(t.id, { conv: t.conv, at: t.at });
    await this.sweepTimed(); // the app may have been closed in the middle of a countdown
    this.store.sweepParts(Date.now() - 3600_000).catch(() => {}); // left by a transfer that was interrupted
    this.ws = new Socket(this.api.wsUrl(), async (nonce) => ({
      account: this.me.account,
      device: this.me.device,
      sig: await p.wsAuth(this.me.account, this.device, nonce, this.api.origin),
    }));
    this.ws.addEventListener("status", (e) => {
      this.status = e.detail;
      this.emit("status", e.detail);
      if (e.detail === "online") this.onOnline().catch((err) => this.fail(err));
    });
    this.ws.addEventListener("msg", (e) => this.onEnvelope(e.detail));
    this.ws.addEventListener("relay", (e) => {
      const f = e.detail;
      // file-req streams a whole file: not in the queue, or arriving chunks would wait for it
      if (this.isChunk(f)) this.serial(() => this.onRelay(f)).catch(() => {});
      else this.onRelay(f).catch(() => {});
    });
    this.ws.addEventListener("relay-missed", (e) => {
      const set = this.missed.get(e.detail.ref);
      if (set) for (const d of e.detail.devices ?? []) set.add(d);
    });
    // A second start (after the connection was closed) replaces the timers instead of adding to them.
    clearInterval(this.retryTimer);
    clearInterval(this.pruneTimer);
    this.retryTimer = setInterval(() => {
      this.flushFiles().catch(() => {});
      this.fetchMissingGifs().catch(() => {}); // a device that has them may have connected since
    }, FILE_RETRY_EVERY);
    this.pruneTimer = setInterval(() => this.prune().catch(() => {}), PRUNE_EVERY);
    this.prune().catch(() => {});
    this.ws.addEventListener("link", (e) => this.onLink(e.detail.request).catch(() => {}));
    this.ws.addEventListener("devices", (e) => this.lists.delete(e.detail.account));
    // A relay frame of a transfer was refused (a rate limit): the transfer stops and is offered again later.
    this.ws.addEventListener("frame-error", (e) => {
      if (this.missed.has(e.detail.id)) this.refused.add(e.detail.id);
    });
    this.ws.addEventListener("server-error", (e) => {
      if (e.detail === "unknown_device") this.emit("removed");
    });
    this.queue = Promise.resolve();
    this.ws.connect();
  }

  stop() {
    clearInterval(this.retryTimer);
    clearInterval(this.pruneTimer);
    clearTimeout(this.receiptTimer);
    clearTimeout(this.timedTimer);
    this.stopped = true;
    this.ws?.close();
    this.store.close();
  }

  /** The page is visible again or the network came back: check the connection now. */
  wake() {
    this.ws?.wake();
    this.sweepTimed().catch(() => {}); // timers do not run while a page sleeps
  }

  /** Tell the server where this device is woken by push (`null`: nowhere). */
  setPushEndpoint(endpoint) {
    return this.ws.pushSubscription(endpoint);
  }

  fail(err) {
    this.emit("error", { message: err?.message ?? String(err) });
  }

  // ── device lists ──────────────────────────────────────────────────────────────────────────────────────────────

  /** The verified device list of an account with verified prekeys; cached for a minute. */
  async list(account, fresh = false) {
    const c = this.lists.get(account);
    if (c && !fresh && Date.now() - c.at < LIST_TTL) return c;
    // The server says where the identity lives; its log is fetched from there and verified here.
    const r = await this.api.devices(account);
    const state = await fetchState(this.api, r.home, this.realms, account);
    const list = r.entries.length
      ? await p.verifyDevices(account, state.instance.account_key, r.entries)
      : { entries: [], present: [], head: "" };
    const prekeys = new Map();
    for (const pk of r.prekeys ?? []) {
      const d = list.present.find((x) => x.id === pk.device);
      if (!d) continue;
      try {
        prekeys.set(d.id, await p.verifyPrekey(account, d, pk));
      } catch {
        // a prekey that does not verify is ignored
      }
    }
    const entry = { state, list, prekeys, home: r.home, at: Date.now() };
    this.lists.set(account, entry);
    if (account !== this.me.account) await this.checkPinned(account, list);
    return entry;
  }

  /** Pinned heads: a list must extend what we saw before (TOFU), otherwise it is a fork (DESIGN.md §5.3). */
  async checkPinned(account, list) {
    const c = this.contacts.get(account);
    if (!c) return;
    if (c.pinned && !(await p.extendsPinned(list, c.pinned.head, c.pinned.length))) {
      if (!c.fork) {
        c.fork = true;
        await this.saveContact(c);
      }
      return;
    }
    if (!c.pinned || c.pinned.head !== list.head) {
      const changed = !!c.pinned && list.head !== c.pinned.head;
      c.pinned = { head: list.head, length: list.entries.length };
      if (changed) c.devicesChanged = p.now();
      await this.saveContact(c);
    }
  }

  async lookupDevice(account, id) {
    let l = await this.list(account);
    let d = l.list.present.find((x) => x.id === id);
    if (!d) {
      l = await this.list(account, true);
      d = l.list.present.find((x) => x.id === id);
    }
    return d;
  }

  async ownList(fresh = false) {
    return (await this.list(this.me.account, fresh)).list;
  }

  async onOnline() {
    await this.rotatePrekey();
    await this.flushReceipts();
    await this.flushFiles();
    await this.fetchMissingGifs();
  }

  async rotatePrekey() {
    const newest = Math.max(0, ...[...this.prekeys.values()].map((x) => x.time));
    const t = p.now();
    if (t - newest > p.PREKEY_ROTATE) {
      const pk = await p.newPrekey(this.me.account, this.device);
      this.prekeys.set(pk.secret.id, { ...pk.secret, publicRaw: rc.parseKey(pk.value.key, "x25519") });
      await this.ws.call({ t: "prekey", prekey: pk.value }, pk.secret.id);
    }
    // Forget prekeys replaced long enough ago (forward secrecy window, DESIGN.md §5.2).
    const sorted = [...this.prekeys.entries()].sort((a, b) => b[1].time - a[1].time);
    for (const [id, v] of sorted.slice(1)) if (t - v.time > p.PREKEY_ROTATE + p.PREKEY_KEEP) this.prekeys.delete(id);
    await this.store.setSecret(
      "prekeys",
      [...this.prekeys.entries()].map(([id, v]) => ({ id, pkcs8: v.pkcs8, publicRaw: v.publicRaw, time: v.time })),
    );
  }

  // ── contacts ──────────────────────────────────────────────────────────────────────────────────────────────────

  async saveContact(c) {
    this.contacts.set(c.account, c);
    await this.store.putContact(c);
    this.emit("contacts");
  }

  /** Throw `not_accepted` unless the conversation with `account` has been accepted. */
  requireAccepted(account) {
    if (this.contacts.get(account)?.state !== "accepted") throw new ApiError(409, "not_accepted");
  }

  /** Bring a contact's handle and home up to date from its verified rootcard state. */
  static fromState(c, state) {
    c.handle = state.handle;
    c.home = state.instance.home.url;
    c.updated = p.now();
  }

  contactList() {
    return [...this.contacts.values()].filter((c) => c.state !== "declined");
  }

  /** Start a conversation with an exact identifier (`Name#TAG`): a message request (DESIGN.md §6.1). */
  async request(handle, note = "") {
    const state = await lookup(this.api, this.realms, handle);
    if (state.account === this.me.account) throw new ApiError(400, "self");
    const existing = this.contacts.get(state.account);
    if (existing?.state === "accepted") return existing;
    const l = await this.list(state.account, true);
    if (l.list.present.length === 0) throw new ApiError(409, "no_devices");
    const c = existing ?? { account: state.account, handle: state.handle, created: p.now() };
    Messenger.fromState(c, state);
    c.state = existing?.state === "incoming" ? "accepted" : "outgoing";
    c.pinned = { head: l.list.head, length: l.list.entries.length };
    await this.saveContact(c);
    const body = { note: String(note).slice(0, NOTE_MAX) };
    const kind = c.state === "accepted" ? "accept" : "request";
    const { id, time } = await this.send(c.account, kind, body);
    if (body.note) await this.record({ id, conv: c.account, dir: "out", time, kind: "text", text: body.note, delivered: 0 });
    return c;
  }

  async accept(account) {
    const c = this.contacts.get(account);
    if (!c) return;
    c.state = "accepted";
    c.updated = p.now();
    await this.saveContact(c);
    await this.send(account, "accept", {});
  }

  /** Decline (forget) or block a contact; synced to own devices. */
  async setState(account, state) {
    const c = this.contacts.get(account);
    if (!c) return;
    c.state = state;
    c.updated = p.now();
    await this.saveContact(c);
    if (state === "declined") await this.store.deleteConversation(account);
    await this.sendOwn("sync", account, { contact: { account, state } });
    this.emit("messages", { conv: account });
  }

  // ── retention (DESIGN.md §8.1) ────────────────────────────────────────────────────────────────────────────────

  /** Keep the messages of a conversation for `seconds` (0: until the conversation is deleted); synced to own devices. */
  async setRetention(account, seconds) {
    const c = this.contacts.get(account);
    if (!c || !validRetention(seconds)) return;
    c.retention = seconds;
    c.updated = p.now();
    await this.saveContact(c);
    await this.sendOwn("sync", account, { contact: { account, retention: seconds } });
    await this.prune(account);
  }

  /** The time before which messages of `account` are deleted, or 0 when they are kept. */
  cutoff(account) {
    const r = this.contacts.get(account)?.retention;
    return r && validRetention(r) ? p.now() - r : 0;
  }

  /** Delete the messages (and their files) that have outlived their conversation's retention. */
  async prune(only = null) {
    for (const c of [...this.contacts.values()]) {
      if (only && c.account !== only) continue;
      const before = this.cutoff(c.account);
      if (before && (await this.store.pruneConversation(c.account, before))) this.emit("messages", { conv: c.account });
    }
  }

  async safetyCode(account) {
    const own = await this.ownList(true);
    const other = (await this.list(account, true)).list;
    return p.safetyCode({ account: this.me.account, head: own.head }, { account, head: other.head });
  }

  // ── sending ───────────────────────────────────────────────────────────────────────────────────────────────────

  async heads(conv) {
    const h = { [this.me.account]: (await this.ownList()).head };
    if (conv !== this.me.account) h[conv] = (await this.list(conv)).list.head;
    return h;
  }

  /**
   * Encrypt one message to a list of `{ account, device, prekey }` targets and send it. `ttl` (seconds) asks the server
   * to keep the envelopes no longer than that while they wait (disappearing messages).
   */
  async deliver(targets, kind, conv, body, id = p.b64(p.random(16)), { ttl } = {}) {
    const heads = await this.heads(conv);
    const time = p.now();
    const to = [];
    for (const t of targets) {
      if (!t.prekey) continue;
      const bytes = await p.signMessage(
        { id, kind, time, from: { ...this.me }, to: { account: t.account, device: t.device }, conv, heads, body },
        this.device.privateKey,
      );
      const item = { device: t.device, env: await p.seal(t.device, t.prekey, bytes) };
      if (t.account !== this.me.account && NOTIFY_KINDS.includes(kind)) item.notify = true;
      if (ttl) item.ttl = ttl;
      to.push(item);
    }
    if (to.length) {
      try {
        await this.ws.sendEnvelopes(to);
      } catch (e) {
        // The connection broke on the way (a page that was in the background): once more on the new connection.
        // Recipients ignore a message id they already have.
        if (!OFFLINE.includes(e?.message) || !(await this.ws.whenReady())) throw e;
        await this.ws.sendEnvelopes(to);
      }
    }
    return { id, time };
  }

  async ownTargets() {
    const own = await this.list(this.me.account);
    // Devices without a prekey (a paper key, §4.5) cannot receive anything.
    return own.list.present
      .filter((d) => d.id !== this.me.device && own.prekeys.has(d.id))
      .map((d) => ({ account: this.me.account, device: d.id, prekey: own.prekeys.get(d.id) }));
  }

  async peerTargets(account) {
    const c = this.contacts.get(account);
    if (c?.fork) throw new ApiError(409, "fork");
    const l = await this.list(account);
    return l.list.present.filter((d) => l.prekeys.has(d.id)).map((d) => ({ account, device: d.id, prekey: l.prekeys.get(d.id) }));
  }

  /** A message to the other party and to our own other devices; `id` may be chosen beforehand. */
  async send(conv, kind, body, { id, ttl } = {}) {
    const targets = [...(await this.peerTargets(conv)), ...(await this.ownTargets())];
    return this.deliver(targets, kind, conv, body, id, { ttl });
  }

  /** A message only to our own other devices. */
  async sendOwn(kind, conv, body) {
    return this.deliver(await this.ownTargets(), kind, conv, body);
  }

  /** Send a text. `id` may be chosen beforehand (the interface shows it under that id while it waits for "Ångra"). */
  async sendText(conv, text, id = p.b64(p.random(16))) {
    this.requireAccepted(conv);
    const t = String(text).slice(0, TEXT_MAX);
    const { time } = await this.send(conv, "text", { text: t }, { id });
    await this.record({ id, conv, dir: "out", time, kind: "text", text: t, device: this.me.device, delivered: 0 });
    return { id, time };
  }

  async record(m) {
    // Already past the conversation's retention (a message that waited long in the mailbox): not stored at all.
    if (m.time < this.cutoff(m.conv)) return;
    // Local order within a second: when this device stored it (kept when history is handed over).
    m.at ??= Date.now();
    if (m.dir === "out" && this.early.delete(m.id)) m.delivered = p.now();
    if (m.kind === "ephemeral") {
      if (m.dir === "out" && m.delivered) m.expires = Date.now() + m.ttl * 1000;
      if (this.deadline(m) <= Date.now()) return; // waited unread for too long
    }
    await this.store.putMessage(m);
    if (m.kind === "ephemeral") await this.track(m);
    this.emit("messages", { conv: m.conv });
  }

  // ── disappearing messages (DESIGN.md §6.8) ────────────────────────────────────────────────────────────────────
  //
  // A disappearing message carries its timer (`ttl`) and how long it may wait unread (`wait`) inside the encryption.
  // Its countdown starts on the recipient's device when it is shown, and on the sender's devices when a receipt says
  // it arrived; one that is never seen or never acknowledged is gone `wait` seconds after it was sent. When the time
  // is up the message is replaced by a record without content (GONE), which is deleted once a late copy could no
  // longer come. Deadlines are kept in `timed` (an encrypted secret), so they survive a reload.

  /** The body of an "ephemeral" message, checked: `{ text, ttl, wait }`, or null. */
  ephemeralBody(m) {
    const b = m.body ?? {};
    if (typeof b.text !== "string" || !validTtl(b.ttl) || !validTtl(b.wait)) return null;
    return { text: b.text.slice(0, TEXT_MAX), ttl: b.ttl, wait: b.wait };
  }

  /** How long a disappearing message to `conv` may wait unread: EPHEMERAL_WAIT, or less when messages are kept less. */
  ephemeralWait(conv) {
    const r = this.contacts.get(conv)?.retention;
    return r && validRetention(r) ? Math.min(r, EPHEMERAL_WAIT) : EPHEMERAL_WAIT;
  }

  /** When a disappearing message is gone (ms since the epoch). */
  deadline(m) {
    const unread = (m.time + Math.min(m.wait ?? EPHEMERAL_WAIT, EPHEMERAL_WAIT)) * 1000;
    return m.expires ? Math.min(m.expires, unread) : unread;
  }

  /** The timer the composer of `conv` starts with (seconds, 0: off). Kept in the contact record on this device only. */
  timer(conv) {
    const t = this.contacts.get(conv)?.timer;
    return EPHEMERAL_TTLS.includes(t) ? t : 0;
  }

  async setTimer(conv, ttl) {
    const c = this.contacts.get(conv);
    if (!c || (ttl !== 0 && !EPHEMERAL_TTLS.includes(ttl))) return;
    c.timer = ttl;
    await this.saveContact(c);
  }

  /** Send a disappearing message; `id` as for sendText ("Ångra"). */
  async sendEphemeral(conv, text, ttl, id = p.b64(p.random(16))) {
    this.requireAccepted(conv);
    if (!EPHEMERAL_TTLS.includes(ttl)) throw new ApiError(400, "bad_ttl");
    const t = String(text).slice(0, TEXT_MAX);
    const wait = this.ephemeralWait(conv);
    const { time } = await this.send(conv, "ephemeral", { text: t, ttl, wait }, { id, ttl: wait });
    await this.record({ id, conv, dir: "out", time, kind: "ephemeral", text: t, ttl, wait, device: this.me.device, delivered: 0 });
    return { id, time };
  }

  /** A received disappearing message is on the screen: its countdown starts on this device. */
  async markSeen(conv, ids) {
    let changed = false;
    for (const id of ids) {
      const m = await this.store.message(id);
      if (!m || m.conv !== conv || m.kind !== "ephemeral" || m.dir !== "in" || m.expires) continue;
      m.expires = Date.now() + m.ttl * 1000;
      await this.store.putMessage(m);
      await this.track(m);
      changed = true;
    }
    if (changed) this.emit("messages", { conv });
  }

  async track(m) {
    this.timed.set(m.id, { conv: m.conv, at: m.kind === GONE ? m.until : this.deadline(m) });
    await this.saveTimed();
    this.scheduleTimed();
  }

  async saveTimed() {
    await this.store.setSecret("timed", [...this.timed].map(([id, t]) => ({ id, ...t })));
  }

  scheduleTimed() {
    clearTimeout(this.timedTimer);
    if (this.stopped || !this.timed.size) return;
    const next = Math.min(...[...this.timed.values()].map((t) => t.at));
    // At most a day ahead (setTimeout's limit is ~24.8 days); a sweep then finds what is due.
    this.timedTimer = setTimeout(() => this.sweepTimed().catch((e) => this.fail(e)), Math.min(Math.max(0, next - Date.now()) + 50, 86_400_000));
  }

  /** Remove what is due: disappearing messages become GONE, and GONE records are deleted. One sweep at a time. */
  sweepTimed() {
    const r = (this.sweeping ?? Promise.resolve()).then(() => this.sweepDue());
    this.sweeping = r.catch(() => {});
    return r;
  }

  async sweepDue() {
    const now = Date.now();
    const convs = new Set();
    for (const [id, t] of [...this.timed]) {
      if (t.at > now) continue;
      this.timed.delete(id);
      const m = await this.store.message(id);
      if (m?.kind === "ephemeral") {
        // A copy that comes again (a resend, a mailbox read twice) must not bring it back: keep its id until no
        // copy can be in a mailbox any longer.
        const gone = { id, conv: m.conv, dir: m.dir, time: m.time, at: m.at, kind: GONE, until: (m.time + EPHEMERAL_WAIT) * 1000 + 3600_000 };
        await this.store.putMessage(gone);
        if (gone.until > now) this.timed.set(id, { conv: m.conv, at: gone.until });
        else await this.store.deleteMessage(id);
        convs.add(m.conv);
      } else if (m?.kind === GONE) {
        await this.store.deleteMessage(id);
      }
    }
    await this.saveTimed();
    for (const conv of convs) this.emit("messages", { conv });
    this.scheduleTimed();
  }

  // ── receipts: "it arrived on one of my devices" (DESIGN.md §6.4) ──────────────────────────────────────────────

  /** Tell `account` soon that message `id` arrived on this device. Only for accepted contacts. */
  queueReceipt(account, id) {
    this.queueReceiptLater(account, id);
    clearTimeout(this.receiptTimer);
    this.receiptTimer = setTimeout(() => this.flushReceipts().catch(() => {}), RECEIPT_WAIT);
  }

  async flushReceipts() {
    const waiting = [...this.receipts];
    this.receipts = new Map();
    for (const [account, set] of waiting) {
      const ids = [...set];
      for (let i = 0; i < ids.length; i += RECEIPT_MAX) {
        const part = ids.slice(i, i + RECEIPT_MAX);
        try {
          if (this.contacts.get(account)?.state !== "accepted") break;
          await this.deliver(await this.peerTargets(account), "receipt", account, { ids: part });
        } catch (e) {
          // Not connected: once more when the connection is back. Anything else (a fork, say): no receipt.
          if (OFFLINE.includes(e?.message)) for (const id of ids.slice(i)) this.queueReceiptLater(account, id);
          break;
        }
      }
    }
  }

  /** Add to the receipts for `account` without sending them soon (they go with the next flush). */
  queueReceiptLater(account, id) {
    let set = this.receipts.get(account);
    if (!set) this.receipts.set(account, (set = new Set()));
    set.add(id);
  }

  /** Mark our outgoing messages in `conv` as delivered: the given ids, or (without ids) all of them. */
  async markDelivered(conv, ids) {
    const t = p.now();
    let changed = false;
    const mark = async (m) => {
      if (!m || m.conv !== conv || m.dir !== "out" || m.delivered) return;
      m.delivered = t;
      // The sender's countdown starts when the message has arrived (there are no read receipts, §6.4).
      if (m.kind === "ephemeral") m.expires = Date.now() + m.ttl * 1000;
      await this.store.putMessage(m);
      if (m.kind === "ephemeral") await this.track(m);
      changed = true;
    };
    if (!ids) {
      for (const m of await this.store.messages(conv)) if (m.delivered === 0) await mark(m);
    } else {
      for (const id of ids.slice(0, RECEIPT_MAX)) {
        if (typeof id !== "string" || id.length > 64) continue;
        const m = await this.store.message(id);
        if (m) await mark(m);
        else {
          if (this.early.size >= 1000) this.early.clear();
          this.early.add(id);
        }
      }
    }
    if (changed) this.emit("messages", { conv });
  }

  // ── receiving ─────────────────────────────────────────────────────────────────────────────────────────────────

  onEnvelope(f) {
    // One at a time, in order.
    this.queue = this.queue.then(() => this.handleEnvelope(f)).catch((err) => this.fail(err));
  }

  async handleEnvelope(f) {
    let m;
    try {
      const plain = await p.open(this.me.device, this.prekeys, f.env);
      m = await p.verifyMessage(plain, this.me, (a, d) => this.lookupDevice(a, d));
    } catch {
      this.ws.ack([f.id]); // undecryptable or forged: drop it
      return;
    }
    try {
      await this.handleMessage(m);
    } finally {
      this.ws.ack([f.id]);
    }
  }

  async handleMessage(m) {
    // Gossip: a head we have not seen means the list changed (DESIGN.md §5.3).
    for (const [account, head] of Object.entries(m.heads ?? {})) {
      const cached = this.lists.get(account);
      if (cached && cached.list.head !== head) this.lists.delete(account);
    }
    if (m.from.account === this.me.account) return this.handleOwn(m);
    const peer = m.from.account;
    let c = this.contacts.get(peer);
    if (c?.state === "blocked") return;
    switch (m.kind) {
      case "request": {
        // One pending request per sender; nothing changes for accepted or pending contacts. An accepted contact that
        // asks again has lost its data (a new device after a paper key or a reset): it is told that it is accepted.
        if (c?.state === "accepted") return void (await this.send(peer, "accept", {}));
        if (c?.state === "incoming") return;
        const state = (await this.list(peer, true)).state;
        const note = String(m.body?.note ?? "").slice(0, NOTE_MAX);
        if (c?.state === "outgoing") {
          c.state = "accepted";
        } else {
          c = { account: peer, handle: state.handle, created: p.now(), state: "incoming", note };
        }
        Messenger.fromState(c, state);
        await this.saveContact(c);
        if (note) await this.record({ id: m.id, conv: peer, dir: "in", time: m.time, kind: "text", text: note });
        if (c.state === "accepted") await this.send(peer, "accept", {});
        this.emit("incoming", { conv: peer, kind: "request" });
        return;
      }
      case "accept":
        // Only an answer to OUR request: a sender can never accept its own request on the recipient's behalf.
        if (c?.state === "outgoing") {
          c.state = "accepted";
          c.updated = p.now();
          await this.saveContact(c);
          await this.markDelivered(peer); // the request (and its note) evidently arrived
        }
        return;
      case "text":
        if (c?.state !== "accepted") return;
        this.queueReceipt(peer, m.id); // also for a copy we already have: the first receipt may have been lost
        if (!(await this.isNew({ id: m.id, conv: peer, dir: "in", time: m.time, device: m.from.device }))) return;
        await this.record({ id: m.id, conv: peer, dir: "in", time: m.time, kind: "text", text: String(m.body?.text ?? "").slice(0, TEXT_MAX), device: m.from.device });
        this.emit("incoming", { conv: peer, kind: "text" });
        return;
      case "ephemeral": {
        if (c?.state !== "accepted") return;
        const e = this.ephemeralBody(m);
        if (!e) return;
        this.queueReceipt(peer, m.id);
        // Taken back, deleted or already gone: not again.
        if (!(await this.isNew({ id: m.id, conv: peer, dir: "in", time: m.time, device: m.from.device }))) return;
        // How long it may wait unread: what the sender asked for, and never longer than kept here.
        const wait = Math.min(e.wait, this.ephemeralWait(peer));
        if ((m.time + wait) * 1000 <= Date.now()) return;
        await this.record({ id: m.id, conv: peer, dir: "in", time: m.time, kind: "ephemeral", text: e.text, ttl: e.ttl, wait, device: m.from.device });
        this.emit("incoming", { conv: peer, kind: "ephemeral" });
        return;
      }
      case "receipt":
        if (c?.state === "accepted" && Array.isArray(m.body?.ids)) await this.markDelivered(peer, m.body.ids);
        return;
      case "reaction":
        if (c?.state === "accepted") await this.applyReaction(peer, m.body?.id, peer, m.body?.e, m.time);
        return;
      case "retract":
        if (c?.state === "accepted") await this.applyRetract(peer, m.body?.id, peer, m.time);
        return;
      case "edit":
        if (c?.state === "accepted") await this.applyEdit(peer, m.body?.id, peer, m.body?.text, m.time, m.id);
        return;
      case "file":
        if (c?.state !== "accepted") return;
        if (await this.onFileMeta(m, peer, "in")) this.emit("incoming", { conv: peer, kind: "file" });
        return;
      default:
        return;
    }
  }

  async handleOwn(m) {
    const conv = m.conv;
    switch (m.kind) {
      case "request": {
        if (conv === this.me.account) return;
        const state = (await this.list(conv, true)).state;
        const c = this.contacts.get(conv) ?? { account: conv, handle: state.handle, created: p.now() };
        if (c.state !== "accepted") c.state = c.state === "incoming" ? "accepted" : "outgoing";
        Messenger.fromState(c, state);
        await this.saveContact(c);
        const note = String(m.body?.note ?? "");
        if (note) await this.record({ id: m.id, conv, dir: "out", time: m.time, kind: "text", text: note, delivered: 0 });
        return;
      }
      case "accept": {
        const c = this.contacts.get(conv);
        if (c) {
          c.state = "accepted";
          await this.saveContact(c);
        }
        return;
      }
      case "text":
        if (!(await this.isNew({ id: m.id, conv, dir: "out", time: m.time, device: m.from.device }))) return;
        await this.record({ id: m.id, conv, dir: "out", time: m.time, kind: "text", text: String(m.body?.text ?? ""), device: m.from.device, delivered: 0 });
        return;
      case "ephemeral": {
        const e = this.ephemeralBody(m);
        if (!e || conv === this.me.account) return;
        if (!(await this.isNew({ id: m.id, conv, dir: "out", time: m.time, device: m.from.device }))) return;
        await this.record({ id: m.id, conv, dir: "out", time: m.time, kind: "ephemeral", text: e.text, ttl: e.ttl, wait: e.wait, device: m.from.device, delivered: 0 });
        return;
      }
      case "file":
        await this.onFileMeta(m, conv, "out");
        return;
      case "sync": {
        // "Delete for me" on another own device (DESIGN.md §6.6).
        if (Array.isArray(m.body?.remove)) for (const id of m.body.remove.slice(0, RECEIPT_MAX)) await this.applyDelete(conv, id, m.time);
        const s = m.body?.contact;
        const c = s && this.contacts.get(s.account);
        if (c && ["accepted", "blocked", "declined"].includes(s.state)) {
          c.state = s.state;
          await this.saveContact(c);
          if (s.state === "declined") await this.store.deleteConversation(s.account);
          this.emit("messages", { conv: s.account });
        }
        if (c && validRetention(s.retention)) {
          c.retention = s.retention;
          c.updated = Math.max(c.updated ?? 0, m.time);
          await this.saveContact(c);
          await this.prune(s.account);
        }
        return;
      }
      case "history":
        await this.mergeHistory(m.body);
        return;
      case "reaction":
        await this.applyReaction(conv, m.body?.id, this.me.account, m.body?.e, m.time);
        return;
      case "retract":
        await this.applyRetract(conv, m.body?.id, this.me.account, m.time);
        return;
      case "edit":
        await this.applyEdit(conv, m.body?.id, this.me.account, m.body?.text, m.time, m.id);
        return;
      case "gifs":
        if (conv === this.me.account) await this.mergeGifs(m.body);
        return;
      default:
        return;
    }
  }

  // ── linking and history (DESIGN.md §4.3, §7) ──────────────────────────────────────────────────────────────────

  async onLink(request) {
    if (request?.account !== this.me.account) return;
    const code = await p.linkCode(this.me.account, request.device.key, request.id);
    this.emit("link", { request, code });
  }

  declineLink(request) {
    this.ws.send({ t: "link-decline", id: request.id });
  }

  /** A new entry of the account's device list after `entries`, signed by this device. */
  async ownEntry(entries, op, device) {
    const accountKey = (await this.list(this.me.account)).state.instance.account_key;
    return p.newEntry({ account: this.me.account, accountKey, entries, op, device, signer: { id: this.me.device, key: this.device.privateKey } });
  }

  async approveLink(request) {
    const own = await this.ownList(true);
    const e = await this.ownEntry(own.entries, "add", request.device);
    await this.api.appendDevices(this.me.account, [e], [request.prekey]);
    await this.ownList(true);
    await this.sendHistory(request.device.id);
  }

  /** When this account's devices were last connected (`{}` while offline: the list works without it). */
  async ownSeen() {
    return this.ws.seen().catch(() => ({}));
  }

  async removeDevice(id) {
    const own = await this.ownList(true);
    const d = own.present.find((x) => x.id === id);
    if (!d) return;
    const e = await this.ownEntry(own.entries, "remove", { id: d.id, key: d.key, label: d.label });
    await this.api.appendDevices(this.me.account, [e]);
    await this.ownList(true);
  }

  /** The account's paper keys (normally at most one) in its verified device list (§4.5). */
  async paperKeys(fresh = false) {
    return (await this.ownList(fresh)).present.filter(p.isPaper);
  }

  /**
   * Prepare a new paper key (§4.5) with the account's local secret from the vault (the caller unlocks it with the
   * password and erases it afterwards). Returns `{ text, commit() }`: the user must save `text` first; `commit` then
   * adds the key to the device list and removes earlier paper keys in the same change.
   */
  async preparePaperKey(secret) {
    const { paper, seed } = await p.newPaperKey(secret, this.me.account);
    const text = await p.formatPaperKey(paper);
    const dev = await p.paperDevice(seed);
    paper.fill(0);
    seed.fill(0);
    return {
      text,
      commit: async () => {
        const own = await this.ownList(true);
        const entries = [...own.entries];
        const added = [];
        // Old keys go first, so that a list with the most devices still has room for the new one.
        for (const d of own.present.filter(p.isPaper)) {
          const e = await this.ownEntry(entries, "remove", { id: d.id, key: d.key, label: d.label });
          entries.push(e);
          added.push(e);
        }
        added.push(await this.ownEntry(entries, "add", dev));
        await this.api.appendDevices(this.me.account, added);
        await this.ownList(true);
      },
    };
  }

  /** Send contacts and messages to a newly linked device, in chunks. File contents follow on request. */
  async sendHistory(deviceId) {
    const own = await this.list(this.me.account, true);
    const target = [{ account: this.me.account, device: deviceId, prekey: own.prekeys.get(deviceId) }];
    const contacts = this.contactList();
    let batch = { contacts, messages: [] };
    let size = rc.canonical(batch).length;
    for (const c of contacts) {
      for (const m of await this.store.messages(c.account)) {
        if (m.kind === "ephemeral" || m.kind === GONE) continue; // disappearing messages stay on the devices they reached
        const s = rc.canonical(m).length;
        if (size + s > HISTORY_CHUNK && batch.messages.length) {
          await this.deliver(target, "history", this.me.account, batch);
          batch = { contacts: [], messages: [] };
          size = 0;
        }
        batch.messages.push(m);
        size += s;
      }
    }
    await this.deliver(target, "history", this.me.account, batch);
    const gifs = await this.gifs();
    if (gifs.length) await this.deliver(target, "gifs", this.me.account, { add: gifs });
  }

  async mergeHistory(body) {
    for (const c of body?.contacts ?? []) {
      if (typeof c?.account !== "string") continue;
      const cur = this.contacts.get(c.account);
      if (!cur || (c.updated ?? 0) > (cur.updated ?? 0)) await this.saveContact({ ...c });
    }
    for (const m of body?.messages ?? []) {
      if (typeof m?.id !== "string" || typeof m.conv !== "string") continue;
      // Disappearing messages (and what is left of them) stay on the devices they reached (§6.8).
      if (m.kind === "ephemeral" || m.kind === GONE) continue;
      if (TOMBSTONES.includes(m.kind)) {
        await this.mergeTombstone(m);
        continue;
      }
      if (!(await this.isNew(m))) continue;
      if (typeof m.time !== "number" || m.time < this.cutoff(m.conv)) continue;
      if (m.file) m.file.have = false;
      await this.store.putMessage(m);
      this.emit("messages", { conv: m.conv });
    }
  }

  // ── files (DESIGN.md §9) ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Send a file: live to the devices connected now and, unless the user turned that off, as encrypted chunks the
   * server keeps for the devices that are away. Devices that got neither are tried again when they are connected.
   * Returns `{ live, queued, waiting }` (numbers of the recipient's devices). `progress({ phase, done, total, id })`
   * is told how far it has come: "read" while it is read and stored, "send" while it is sent (`id` is the message's
   * from then on).
   */
  async sendFile(conv, file, progress = null) {
    this.requireAccepted(conv);
    if (file.size > p.MAX_FILE) throw new ApiError(413, "too_large");
    const f = p.b64(p.random(16));
    const key = await p.newFileKey();
    const size = file.size;
    const n = p.chunkCount(size);
    // Read, hashed and stored part by part: the file is never in memory whole.
    const hash = new p.Sha256();
    for (let i = 0; i < n; i++) {
      const part = new Uint8Array(await file.slice(i * p.CHUNK, (i + 1) * p.CHUNK).arrayBuffer());
      hash.update(part);
      await this.store.putPart(f, i, part);
      progress?.({ phase: "read", done: i + 1, total: n });
    }
    if (hash.length !== size) throw new ApiError(409, "file_changed");
    const meta = {
      f, name: p.safeFileName(file.name), mime: p.safeMime(file.type),
      size, sha256: p.b64(hash.digest()), key: p.b64(key), n,
    };
    const peers = await this.peerTargets(conv);
    const owns = await this.ownTargets();
    const all = [...peers, ...owns].map((t) => t.device);
    const online = await this.ws.presence(all);
    const away = all.filter((d) => !online.includes(d));
    // Asked before the transfer, so that a file is queued whole or not at all.
    const queued = this.fileQueue() ? await this.ws.relaySpace(away, Math.ceil(size * 1.4) + n * 256) : [];
    await this.store.finishFile(f, n, size);
    const { id, time } = await this.deliver([...peers, ...owns], "file", conv, meta);
    const m = { id, conv, dir: "out", time, kind: "file", file: { ...meta, have: true }, device: this.me.device, delivered: 0 };
    m.file.missed = away.filter((d) => !queued.includes(d));
    m.file.peers = peers.map((t) => t.device);
    progress?.({ phase: "send", done: 0, total: n, id });
    await this.record(m);
    const to = [...online, ...queued];
    const sending = (done) => progress?.({ phase: "send", done, total: n, id });
    if (to.length) m.file.missed.push(...(await this.streamFile(meta, await this.store.fileReader(f), to, queued.length > 0, sending)));
    await this.settleFile(m);
    const isPeer = (d) => m.file.peers.includes(d);
    return {
      live: online.filter((d) => isPeer(d) && !m.file.missed.includes(d)).length,
      queued: queued.filter((d) => isPeer(d) && !m.file.missed.includes(d)).length,
      waiting: m.file.missed.filter(isPeer).length,
    };
  }

  /**
   * Stream the chunks of a file to devices; `read(i)` gives part `i` (Store.fileReader). Returns the devices the server
   * could not give them to.
   */
  async streamFile(meta, read, devices, store = false, progress = null) {
    const key = p.unb64(meta.key);
    const ref = `${meta.f}.${p.b64(p.random(6))}`;
    const missed = new Set();
    this.missed.set(ref, missed);
    try {
      for (let i = 0; i < meta.n; i++) {
        const part = await read?.(i);
        if (!part) throw new Error("no_file");
        const data = await p.encryptChunk(key, meta.f, i, meta.n, part);
        await this.ws.pace(devices, data.length);
        await this.ws.drain();
        if (this.refused.has(ref)) return devices;
        this.ws.relay(devices, data, { store, ref });
        progress?.(i + 1);
      }
      await this.ws.presence([this.me.device]); // answered after every chunk before it was handled
      if (this.refused.has(ref)) return devices; // a chunk was refused: nobody got all of it
    } catch {
      return devices; // the connection broke: nobody got all of it for certain
    } finally {
      this.missed.delete(ref);
      this.refused.delete(ref);
    }
    return [...missed];
  }

  /** Save which devices still miss a file and keep it on the list of files to offer again. */
  async settleFile(m) {
    m.file.missed = [...new Set(m.file.missed)];
    // Reactions may have come while the file was on its way; `m` is from before them.
    const cur = await this.store.message(m.id);
    if (cur && TOMBSTONES.includes(cur.kind)) return; // taken back or deleted while it was on its way
    if (cur?.reactions) m.reactions = cur.reactions;
    await this.store.putMessage(m);
    const rest = this.pendingFiles.filter((x) => x.id !== m.id);
    if (m.file.missed.length) rest.push({ conv: m.conv, id: m.id, time: m.time });
    if (rest.length !== this.pendingFiles.length || m.file.missed.length) {
      this.pendingFiles = rest;
      await this.store.setSecret("pendingFiles", rest);
    }
    this.emit("messages", { conv: m.conv });
  }

  /** Stop offering the file of message `id` again. */
  async forgetPendingFile(id) {
    if (!this.pendingFiles.some((x) => x.id === id)) return;
    this.pendingFiles = this.pendingFiles.filter((x) => x.id !== id);
    await this.store.setSecret("pendingFiles", this.pendingFiles);
  }

  /** Whether none of the recipient's devices has been given this (outgoing) file yet. */
  static undelivered(m) {
    const f = m?.file;
    return m?.dir === "out" && !!f?.peers?.length && f.peers.every((d) => f.missed?.includes(d));
  }

  /** Offer files again to the devices that missed them and are connected now. Returns how many devices got one. */
  async flushFiles() {
    if (this.flushing || !this.pendingFiles.length || this.status !== "online") return 0;
    this.flushing = true;
    let sent = 0;
    try {
      for (const entry of [...this.pendingFiles]) {
        const m = await this.store.message(entry.id);
        const read = m?.file && (await this.store.fileReader(m.file.f));
        if (!m || !read || p.now() - entry.time > FILE_RETRY || !m.file.missed?.length) {
          await this.forgetPendingFile(entry.id);
          continue;
        }
        const online = await this.ws.presence(m.file.missed);
        if (!online.length) continue;
        const failed = await this.streamFile(m.file, read, online);
        sent += online.length - failed.length;
        m.file.missed = m.file.missed.filter((d) => !online.includes(d) || failed.includes(d));
        await this.settleFile(m);
      }
    } finally {
      this.flushing = false;
    }
    return sent;
  }

  async onFileMeta(m, conv, dir) {
    const b = m.body ?? {};
    if (typeof b.f !== "string" || !Number.isSafeInteger(b.size) || !Number.isSafeInteger(b.n) || b.size < 0 || b.size > p.MAX_FILE) return;
    if (b.n !== p.chunkCount(b.size)) return;
    b.name = p.safeFileName(b.name);
    b.mime = p.safeMime(b.mime);
    if (await this.superseded({ id: m.id, conv, dir, time: m.time, device: m.from.device })) return false;
    const fresh = !(await this.store.hasMessage(m.id));
    if (fresh) {
      const have = await this.store.hasFile(b.f);
      const rec = { id: m.id, conv, dir, time: m.time, kind: "file", file: { ...b, have }, device: m.from.device };
      if (dir === "out") rec.delivered = 0;
      await this.record(rec);
      // A file counts as arrived when its content is here (otherwise tryAssemble says so later).
      if (dir === "in" && have) this.queueReceipt(conv, m.id);
    }
    await this.serial(() => this.expectFile(b, { id: m.id, conv }));
    return fresh;
  }

  /** Run file work one piece at a time (chunks arrive concurrently; a file is hashed in order). */
  serial(fn) {
    const r = this.fileWork.then(fn);
    this.fileWork = r.catch(() => {});
    return r;
  }

  isChunk(f) {
    try {
      return p.unpack(f.data).k === "chunk";
    } catch {
      return false;
    }
  }

  /**
   * The state of a transfer that is under way. Parts are stored as they arrive and hashed in order, so memory holds
   * only which parts are here: `have` (indices stored as parts), `early` (index → bytes of chunks waiting in
   * `incoming` for the `file` message), `hash` and `next` (parts hashed so far), `ids` (queued copies to acknowledge).
   */
  fileState(f) {
    let t = this.files.get(f);
    if (!t) {
      t = { have: new Set(), early: new Map(), earlyBytes: 0, ids: [], hash: new p.Sha256(), next: 0, total: 0, updated: Date.now() };
      this.files.set(f, t);
    }
    return t;
  }

  /** The `file` message for a transfer is known (it came, or this device asked its own devices for the file). */
  async expectFile(meta, message) {
    const f = meta.f;
    if (await this.store.hasFile(f)) {
      const t = this.files.get(f);
      if (t) await this.dropTransfer(f, t);
      return;
    }
    let t = this.files.get(f);
    if (t?.meta && t.meta.key !== meta.key) {
      // Another file message with this id: start again with the newer one.
      await this.dropTransfer(f, t);
      t = undefined;
    }
    t = t ?? this.fileState(f);
    t.meta = meta;
    t.message = message;
    t.updated = Date.now();
    // Chunks that came first are checked and stored as parts now.
    if (t.early.size) {
      const early = [...t.early.keys()].sort((x, y) => x - y);
      t.early.clear();
      t.earlyBytes = 0;
      for (const i of early) {
        const c = await this.store.incoming(f, i);
        if (c && i < meta.n && c.n === meta.n) await this.storeChunk(f, t, { f, i, n: c.n, c: c.c });
      }
      await this.store.deleteIncoming(f);
    }
    await this.tryAssemble(f);
  }

  async onRelay(f) {
    let r;
    try {
      r = p.unpack(f.data);
    } catch {
      return;
    }
    if (r.k === "chunk") {
      const ack = () => f.id && this.ws.relayAck([f.id]);
      if (typeof r.f !== "string" || r.f.length > 64 || !Number.isSafeInteger(r.i) || !Number.isSafeInteger(r.n) || r.i < 0 || r.i >= r.n || r.n > 4096) return ack();
      if (typeof r.c !== "string" || r.c.length > MAX_CHUNK_TEXT) return ack();
      // Chunks only from own devices and from contacts we talk to: anyone else could fill storage, or this device's
      // share of the server's file queue (queued copies are acknowledged so the server drops them).
      if (!this.mayRelay(f)) return ack();
      let t = this.files.get(r.f);
      if (!t && (await this.store.hasFile(r.f))) return ack(); // a queued copy of a file we already have
      if (!t) {
        if (this.files.size >= 64) this.sweepFiles();
        if (this.files.size >= 64) return; // too many transfers at once; a queued copy comes again
        t = this.fileState(r.f);
      }
      t.updated = Date.now();
      if (t.have.has(r.i) || t.early.has(r.i)) {
        if (f.id) t.ids.push(f.id);
        return;
      }
      if (t.meta) {
        // With the file key known, a chunk that does not decrypt is dropped at once, so it cannot spoil the file.
        if (r.n !== t.meta.n || !(await this.storeChunk(r.f, t, r))) return ack();
      } else {
        // Before the file message: kept in IndexedDB, within a budget per sender, until the key is known.
        const size = Math.ceil((r.c.length * 3) / 4);
        this.sweepFiles();
        let mine = 0;
        let all = 0;
        for (const x of this.files.values()) {
          all += x.earlyBytes;
          if (x.from === f.account) mine += x.earlyBytes;
        }
        if (mine + size > EARLY_SENDER || all + size > EARLY_TOTAL) return; // not acknowledged: it comes again
        await this.store.putIncoming(r.f, r.i, { n: r.n, c: r.c });
        t.from ??= f.account;
        t.early.set(r.i, size);
        t.earlyBytes += size;
      }
      if (f.id) t.ids.push(f.id); // from the server's queue: acknowledged when the file is complete
      await this.tryAssemble(r.f);
    } else if (r.k === "file-req" && f.account === this.me.account) {
      // Later federation: serve our own other devices only.
      const own = await this.ownList();
      if (!own.present.some((d) => d.id === f.from)) return;
      const meta = typeof r.f === "string" && r.f.startsWith("gif:") ? await this.gifMeta(r.f.slice(4)) : (await this.findFileMessage(r.f, r.conv))?.file;
      const read = meta && (await this.store.fileReader(r.f));
      if (read) await this.streamFile(meta, read, [f.from]);
    }
  }

  /** Decrypt a chunk with the file key and store it as a part; false if it does not decrypt. */
  async storeChunk(f, t, r) {
    let bytes;
    try {
      bytes = await p.decryptChunk(p.unb64(t.meta.key), r);
    } catch {
      return false;
    }
    if (bytes.length > p.CHUNK) return false;
    await this.store.putPart(f, r.i, bytes);
    t.have.add(r.i);
    // Hash the parts that are now here in order; the one that just came is still in memory.
    while (t.have.has(t.next)) {
      const x = t.next === r.i ? bytes : await this.store.part(f, t.next);
      if (!x) break;
      t.hash.update(x);
      t.total += x.length;
      t.next++;
    }
    return true;
  }

  /** Forget a transfer: its incoming chunks and, unless the file is complete, its parts; acknowledge queued copies. */
  async dropTransfer(f, t, parts = false) {
    if (this.files.get(f) === t) this.files.delete(f);
    if (t.ids.length) this.ws.relayAck(t.ids);
    t.ids = [];
    if (parts) await this.store.deleteFile(f);
    else if (t.early.size) await this.store.deleteIncoming(f);
  }

  /** Whether a relay frame comes from an own device or from a contact this account talks to. */
  mayRelay(f) {
    if (f.account === this.me.account) return true;
    return ["accepted", "outgoing"].includes(this.contacts.get(f.account)?.state);
  }

  /** Forget chunks whose file message has not come within EARLY_KEEP. */
  sweepFiles() {
    const t = Date.now() - EARLY_KEEP;
    for (const [f, v] of this.files) {
      if (v.updated < t && !v.meta) {
        this.files.delete(f);
        this.store.deleteIncoming(f).catch(() => {});
      }
    }
  }

  async tryAssemble(f) {
    const t = this.files.get(f);
    if (!t?.meta || t.have.size < t.meta.n) return;
    // Complete, good or bad: the server may forget its queued copy.
    const good = t.next === t.meta.n && t.total === t.meta.size && p.b64(t.hash.digest()) === t.meta.sha256;
    if (!good) return this.dropTransfer(f, t, true);
    const m = await this.store.message(t.message.id);
    if (m && TOMBSTONES.includes(m.kind)) return this.dropTransfer(f, t, true); // taken back meanwhile
    await this.store.finishFile(f, t.meta.n, t.meta.size);
    await this.dropTransfer(f, t);
    if (m?.file) {
      m.file.have = true;
      await this.store.putMessage(m);
      if (m.dir === "in" && this.contacts.get(m.conv)?.state === "accepted") this.queueReceipt(m.conv, m.id);
    }
    this.emit("file", { f });
    if (f.startsWith("gif:")) this.emit("gifs");
    else this.emit("messages", { conv: t.message.conv });
  }

  async findFileMessage(f, conv) {
    const convs = conv ? [conv] : [...this.contacts.keys()];
    for (const c of convs) {
      const m = (await this.store.messages(c)).find((x) => x.kind === "file" && x.file?.f === f);
      if (m) return m;
    }
    return null;
  }

  /** Ask our own connected devices for a file we know about but do not have. Returns how many were asked. */
  async fetchFromOwnDevices(conv, f) {
    const m = await this.findFileMessage(f, conv);
    if (!m) return 0;
    await this.serial(() => this.expectFile(m.file, { id: m.id, conv }));
    const own = (await this.ownTargets()).map((x) => x.device);
    const online = await this.ws.presence(own);
    if (online.length) this.ws.relay(online, p.pack({ k: "file-req", f, conv }));
    return online.length;
  }

  async fileBlob(f, mime) {
    const parts = await this.store.fileParts(f);
    return parts ? new Blob(parts, { type: mime }) : null;
  }

  /** Width and height of a stored image, from its header (null when they cannot be read). */
  async imageSize(f) {
    const head = await this.store.fileHead(f, IMAGE_HEAD);
    return head ? p.imageSize(head) : null;
  }

  /** The messages of a conversation as the user sees them (with "retracted" placeholders, without hidden records). */
  async messages(conv) {
    const now = Date.now();
    // A disappearing message whose time is up is not shown, even before the sweep has removed it.
    return (await this.store.messages(conv)).filter((m) => !hidden(m) && !(m.kind === "ephemeral" && this.deadline(m) <= now));
  }

  // ── taking messages back (DESIGN.md §6.6) ─────────────────────────────────────────────────────────────────────

  /** Who wrote a stored message. */
  author(m) {
    return m.dir === "out" ? this.me.account : m.conv;
  }

  /** Whether the user can react to message `m` (a text, file or disappearing message of an accepted contact). */
  canReact(m) {
    return REACTABLE.includes(m?.kind) && this.contacts.get(m.conv)?.state === "accepted";
  }

  /** Whether our message `m` can still be taken back from everyone. */
  canRetract(m) {
    return m?.dir === "out" && REACTABLE.includes(m.kind) && p.now() - m.time <= RETRACT_WINDOW
      && this.contacts.get(m.conv)?.state === "accepted";
  }

  /**
   * "Delete for everyone": our own text or file, within RETRACT_WINDOW of sending it. The other party's devices
   * and our own replace it with a placeholder; devices that do not know `retract` (or a modified client) keep it.
   */
  async retract(conv, id) {
    this.requireAccepted(conv);
    const m = await this.store.message(id);
    if (!m || m.conv !== conv || m.dir !== "out" || !REACTABLE.includes(m.kind)) throw new ApiError(404, "no_message");
    if (!this.canRetract(m)) throw new ApiError(409, "too_late");
    const { time } = await this.send(conv, "retract", { id });
    await this.applyRetract(conv, id, this.me.account, time);
  }

  /** Whether a retraction sent at `rt` may take back a message sent at `time` (both signed by the author). */
  static retractable(time, rt) {
    return Number.isSafeInteger(time) && Number.isSafeInteger(rt) && rt >= time - 300 && rt - time <= RETRACT_WINDOW;
  }

  /** Take back message `id` of `conv`, written by `who`, as told by a `retract` sent at `time`. */
  async applyRetract(conv, id, who, time) {
    if (typeof id !== "string" || id.length > 64 || !Number.isSafeInteger(time)) return;
    const m = await this.store.message(id);
    if (!m) {
      // Not here (yet): a history hand-over may still bring it. Remembered, unseen, so that it does not show up.
      if (time < this.cutoff(conv)) return;
      const dir = who === this.me.account ? "out" : "in";
      await this.store.putMessage({ id, conv, dir, kind: "retracted", by: who, time, rt: time, at: Date.now(), pending: true });
      return;
    }
    if (m.conv !== conv || !REACTABLE.includes(m.kind) || this.author(m) !== who) return;
    if (!Messenger.retractable(m.time, time)) return;
    if (m.at && Date.now() - m.at > RETRACT_LATEST) return;
    await this.tombstone(m, { kind: "retracted", by: who, rt: time });
  }

  /** Replace stored message `m` by a tombstone, with its file and anything still on its way for it. */
  async tombstone(m, extra) {
    const f = m.file?.f;
    if (f) {
      const t = this.files.get(f);
      if (t) await this.dropTransfer(f, t);
      await this.forgetPendingFile(m.id);
    }
    const t = { id: m.id, conv: m.conv, dir: m.dir, time: m.time, at: m.at, device: m.device, ...extra };
    await this.store.replaceMessage(t, f);
    this.emit("messages", { conv: m.conv });
  }

  /** Whether a message arriving now (`rec`, as for superseded) is neither taken back, deleted nor already here. */
  async isNew(rec) {
    return !(await this.superseded(rec)) && !(await this.store.hasMessage(rec.id));
  }

  /**
   * Whether a message arriving now (`rec`: id, conv, dir, time) must be ignored because it was taken back or deleted.
   * A retraction that came before the message is made visible now; one that does not fit the message is dropped.
   */
  async superseded(rec) {
    const t = await this.store.message(rec.id);
    if (!t || !TOMBSTONES.includes(t.kind)) return false;
    if (t.kind === "deleted" || !t.pending) return t.conv === rec.conv;
    if (t.conv === rec.conv && t.by === this.author(rec) && Messenger.retractable(rec.time, t.rt)) {
      await this.store.putMessage({ id: rec.id, conv: rec.conv, dir: rec.dir, time: rec.time, at: rec.at ?? Date.now(), device: rec.device, kind: "retracted", by: t.by, rt: t.rt });
      this.emit("messages", { conv: rec.conv });
      return true;
    }
    await this.store.deleteMessage(rec.id); // a retraction that did not belong to this message
    return false;
  }

  /** A tombstone in a history hand-over from an own device. */
  async mergeTombstone(m) {
    if (!Number.isSafeInteger(m.time) || m.time < this.cutoff(m.conv)) return;
    const cur = await this.store.message(m.id);
    const t = { id: m.id, conv: m.conv, dir: m.dir === "out" ? "out" : "in", time: m.time, at: m.at, kind: m.kind };
    if (m.kind === "retracted") Object.assign(t, { by: m.by, rt: m.rt }, m.pending ? { pending: true } : {});
    if (!cur) return void (await this.store.putMessage(t));
    if (cur.conv !== m.conv) return;
    if (TOMBSTONES.includes(cur.kind)) {
      if (cur.pending && !t.pending) await this.store.putMessage(t);
      return;
    }
    if (t.kind === "retracted" && !t.pending && t.by === this.author(cur)) await this.tombstone(cur, { kind: "retracted", by: t.by, rt: t.rt });
    else if (t.kind === "deleted") await this.tombstone(cur, { kind: "deleted" });
  }

  // ── editing (DESIGN.md §6.7) ──────────────────────────────────────────────────────────────────────────────────

  /** Whether our message `m` can still be edited: an own text, within RETRACT_WINDOW of sending it. */
  canEdit(m) {
    return m?.kind === "text" && this.canRetract(m);
  }

  /** Replace the text of our own message `id` for everyone. */
  async edit(conv, id, text) {
    this.requireAccepted(conv);
    const t = String(text ?? "").trim().slice(0, TEXT_MAX);
    if (!t) throw new ApiError(400, "empty_text");
    const m = await this.store.message(id);
    if (!m || m.conv !== conv || m.dir !== "out" || m.kind !== "text") throw new ApiError(404, "no_message");
    if (!this.canEdit(m)) throw new ApiError(409, "too_late");
    if (t === m.text) return;
    const { id: eid, time } = await this.send(conv, "edit", { id, text: t });
    await this.applyEdit(conv, id, this.me.account, t, time, eid);
  }

  /**
   * Take an edit of text message `id` by `who`, sent at `time` (edit message id `eid`): only the author's, within the
   * window, and only if it is newer than the edit the message already has (an older edit arriving late is ignored).
   */
  async applyEdit(conv, id, who, text, time, eid) {
    if (typeof id !== "string" || id.length > 64 || typeof text !== "string" || !Number.isSafeInteger(time)) return;
    const t = text.trim().slice(0, TEXT_MAX);
    if (!t) return;
    const m = await this.store.message(id);
    if (!m || m.conv !== conv || m.kind !== "text" || this.author(m) !== who) return;
    if (!Messenger.retractable(m.time, time)) return;
    if (m.at && Date.now() - m.at > RETRACT_LATEST) return;
    if (m.edited && (m.edited > time || (m.edited === time && (m.eid ?? "") >= eid))) return;
    m.text = t;
    m.edited = time;
    m.eid = eid;
    await this.store.putMessage(m);
    this.emit("messages", { conv });
  }

  /** "Delete for me": gone from this device and our other devices; the other party keeps its copy. */
  async deleteForMe(conv, id) {
    const m = await this.store.message(id);
    if (!m || m.conv !== conv || hidden(m)) throw new ApiError(404, "no_message");
    await this.applyDelete(conv, id, p.now());
    await this.sendOwn("sync", conv, { remove: [id] });
  }

  async applyDelete(conv, id, time) {
    if (typeof id !== "string" || id.length > 64) return;
    const m = await this.store.message(id);
    if (!m) {
      if (Number.isSafeInteger(time) && time >= this.cutoff(conv)) await this.store.putMessage({ id, conv, dir: "in", time, at: Date.now(), kind: "deleted" });
      return;
    }
    if (m.conv !== conv || m.kind === "deleted") return;
    await this.tombstone(m, { kind: "deleted" });
  }

  // ── reactions (DESIGN.md §6.5) ────────────────────────────────────────────────────────────────────────────────

  /** React to a message of a conversation with one emoji, or take the reaction back with `""`. */
  async react(conv, id, e) {
    this.requireAccepted(conv);
    if (!validReaction(e)) throw new ApiError(400, "bad_reaction");
    const m = await this.store.message(id);
    if (!m || m.conv !== conv || !REACTABLE.includes(m.kind)) throw new ApiError(404, "no_message");
    const { time } = await this.send(conv, "reaction", { id, e });
    await this.applyReaction(conv, id, this.me.account, e, time);
  }

  /**
   * Record `who`'s reaction to message `id` of conversation `conv`: one per account, the latest wins (a taken-back
   * reaction stays as `""` with its time, so an older one that arrives late does not come back).
   */
  async applyReaction(conv, id, who, e, time) {
    if (typeof id !== "string" || !validReaction(e) || !Number.isSafeInteger(time)) return;
    const m = await this.store.message(id);
    if (!m || m.conv !== conv || !REACTABLE.includes(m.kind)) return;
    const r = { ...(m.reactions ?? {}) };
    if ((r[who]?.t ?? 0) > time) return;
    r[who] = { e, t: time };
    m.reactions = r;
    await this.store.putMessage(m);
    this.emit("messages", { conv });
  }

  // ── the user's GIF collection (DESIGN.md §9.2) ────────────────────────────────────────────────────────────────
  //
  // Encrypted like everything else in the store: the list in a secret, each GIF as a file under its own id
  // (`gif:<id>`), apart from the files of messages so that pruning a conversation keeps it. The account's devices
  // keep the same collection: additions and removals go to the own devices as "gifs" messages, and the bytes go with
  // the file relay like any file, encrypted under a key of their own (or are asked for later with file-req).

  /** The saved GIFs, newest first: `[{ id, size, n, width, height, sha256, key }]`. */
  async gifs() {
    const list = await this.store.secret("gifs");
    if (!Array.isArray(list)) return [];
    // Entries saved before the collection was shared between devices have no file key yet.
    if (list.some((g) => !g.key)) {
      for (const g of list) {
        g.key ??= p.b64(await p.newFileKey());
        g.n ??= p.chunkCount(g.size);
      }
      await this.store.setSecret("gifs", list);
    }
    return list;
  }

  /** What a GIF is streamed as (Messenger.streamFile, expectFile), or null when it is not in the collection. */
  async gifMeta(id) {
    const g = (await this.gifs()).find((x) => x.id === id);
    return g ? gifStream(g) : null;
  }

  /**
   * Save a GIF (a Blob) in the collection, and on the account's other devices. Only a real GIF is taken (by its
   * header, whatever its type says), at most GIF_MAX_BYTES and with dimensions that fit (p.imageFits). Returns
   * `"saved"` or `"exists"`; throws `not_gif`, `gif_too_large`, `too_big_image` or `gifs_full`.
   */
  async saveGif(blob) {
    if (!blob || blob.size > GIF_MAX_BYTES) throw new ApiError(413, blob ? "gif_too_large" : "not_gif");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!p.isGif(bytes)) throw new ApiError(400, "not_gif");
    const size = p.imageSize(bytes.subarray(0, IMAGE_HEAD));
    if (!p.imageFits(size)) throw new ApiError(400, "too_big_image");
    const hash = new p.Sha256();
    hash.update(bytes);
    const sha256 = p.b64(hash.digest());
    const list = await this.gifs();
    if (list.some((g) => g.sha256 === sha256)) return "exists";
    if (list.length >= GIF_MAX_COUNT) throw new ApiError(409, "gifs_full");
    const g = {
      id: p.b64(p.random(16)), size: bytes.length, n: p.chunkCount(bytes.length),
      width: size.width, height: size.height, sha256, key: p.b64(await p.newFileKey()),
    };
    await this.store.putFile(gifFile(g.id), bytes);
    await this.store.setSecret("gifs", [g, ...list]);
    this.emit("gifs");
    this.shareGif(g).catch(() => {}); // the other devices can also ask for it later
    return "saved";
  }

  /**
   * Tell the own other devices about a new GIF. The bytes are not pushed: each device asks for them (file-req) once it
   * knows the entry. A device from before the collection was shared drops the "gifs" message as an unknown kind, and
   * chunks pushed to it would wait in its storage and come back from the server's queue for nothing.
   */
  async shareGif(g) {
    const owns = await this.ownTargets();
    if (owns.length) await this.deliver(owns, "gifs", this.me.account, { add: [g] });
  }

  /** "gifs" from an own device: `{ add: [entry], remove: [id] }`. */
  async mergeGifs(body) {
    let list = await this.gifs();
    const removed = (Array.isArray(body?.remove) ? body.remove : []).filter((id) => typeof id === "string" && list.some((g) => g.id === id));
    for (const id of removed) await this.store.deleteFile(gifFile(id));
    list = list.filter((g) => !removed.includes(g.id));
    const added = [];
    for (const raw of Array.isArray(body?.add) ? body.add.slice(0, GIF_MAX_COUNT) : []) {
      const g = gifEntry(raw);
      if (!g || list.length >= GIF_MAX_COUNT || list.some((x) => x.id === g.id || x.sha256 === g.sha256)) continue;
      if (body.add.length === 1) list.unshift(g); // a new one: first, like on the device that saved it
      else list.push(g); // the whole collection (a newly linked device): in its order
      added.push(g);
    }
    if (!removed.length && !added.length) return;
    await this.store.setSecret("gifs", list);
    this.emit("gifs");
    if (added.length) await this.fetchMissingGifs();
  }

  /**
   * Make ready for the GIFs of the collection whose bytes are not here yet, and ask the own connected devices for
   * them. Returns how many were asked for.
   */
  async fetchMissingGifs() {
    const missing = [];
    for (const g of await this.gifs()) {
      const meta = gifStream(g);
      const f = meta.f;
      if (await this.store.hasFile(f)) continue;
      await this.serial(() => this.expectFile(meta, { id: f, conv: this.me.account }));
      if (!(await this.store.hasFile(f))) missing.push(f);
    }
    if (!missing.length || this.status !== "online") return 0;
    const own = (await this.ownTargets()).map((x) => x.device);
    const online = own.length ? await this.ws.presence(own) : [];
    if (!online.length) return 0;
    for (const f of missing) this.ws.relay(online, p.pack({ k: "file-req", f }));
    return missing.length;
  }

  /** The bytes of a saved GIF as a Blob of type image/gif, or null (not here yet). */
  async gifBlob(id) {
    return this.fileBlob(gifFile(id), "image/gif");
  }

  /** Remove a GIF from the collection, here and on the own other devices. */
  async removeGif(id) {
    await this.store.setSecret("gifs", (await this.gifs()).filter((g) => g.id !== id));
    await this.store.deleteFile(gifFile(id));
    this.emit("gifs");
    const owns = await this.ownTargets();
    if (owns.length) await this.deliver(owns, "gifs", this.me.account, { remove: [id] });
  }

  /** Send a saved GIF: an ordinary file message, under a neutral name. */
  async sendGif(conv, id, progress = null) {
    const blob = await this.gifBlob(id);
    if (!blob) throw new ApiError(404, "gif_missing");
    return this.sendFile(conv, new File([blob], "animation.gif", { type: "image/gif" }), progress);
  }

  // ── recently used emoji, encrypted on this device ──────────────────────────────────────────────────────────────

  async recentEmoji() {
    const r = await this.store.secret("recentEmoji");
    return Array.isArray(r) ? r.filter((x) => typeof x === "string") : [];
  }

  async setRecentEmoji(list) {
    await this.store.setSecret("recentEmoji", list);
  }
}

export { Store };
