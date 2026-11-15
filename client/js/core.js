// The messenger engine: devices, contacts and requests, messages, multi-device sync, history hand-over and live
// file transfer (docs/DESIGN.md). No DOM: the UI listens to events.
//
// Events: "status" (online/offline), "contacts", "messages" ({ conv }), "link" ({ request, code }), "file" ({ f }),
// "incoming" ({ conv, kind }: something from a contact the user should hear about), "removed" (this device was
// removed), "error" ({ message }).

import * as rc from "../vendor/rootcard/src/index.js";
import * as p from "./protocol.js";
import { Store } from "./store.js";
import { Socket } from "./net.js";
import { fetchState, lookup, proveToServer } from "./identity.js";
import { ApiError } from "./api.js";

const LIST_TTL = 60_000;
const NOTE_MAX = 500;
const TEXT_MAX = 8000;
const HISTORY_CHUNK = 40 * 1024;
/** Message kinds the recipient should be notified about (the server only sees the flag, DESIGN.md §10.1). */
const NOTIFY_KINDS = ["request", "text", "file"];
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
    this.retryTimer = setInterval(() => this.flushFiles().catch(() => {}), FILE_RETRY_EVERY);
    this.pruneTimer = setInterval(() => this.prune().catch(() => {}), PRUNE_EVERY);
    this.prune().catch(() => {});
    this.ws.addEventListener("link", (e) => this.onLink(e.detail.request).catch(() => {}));
    this.ws.addEventListener("devices", (e) => {
      this.lists.delete(e.detail.account);
      this.emit("devices", e.detail);
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
    this.ws?.close();
    this.store.close();
  }

  /** The page is visible again or the network came back: check the connection now. */
  wake() {
    this.ws?.wake();
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
    c.handle = state.handle;
    c.home = state.instance.home.url;
    c.state = existing?.state === "incoming" ? "accepted" : "outgoing";
    c.pinned = { head: l.list.head, length: l.list.entries.length };
    c.updated = p.now();
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

  /** Encrypt one message to a list of `{ account, device, prekey }` targets and send it. */
  async deliver(targets, kind, conv, body, id = p.b64(p.random(16))) {
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

  /** A message to the other party and to our own other devices. */
  async send(conv, kind, body) {
    const targets = [...(await this.peerTargets(conv)), ...(await this.ownTargets())];
    return this.deliver(targets, kind, conv, body);
  }

  /** A message only to our own other devices. */
  async sendOwn(kind, conv, body) {
    return this.deliver(await this.ownTargets(), kind, conv, body);
  }

  async sendText(conv, text) {
    const c = this.contacts.get(conv);
    if (c?.state !== "accepted") throw new ApiError(409, "not_accepted");
    const t = String(text).slice(0, TEXT_MAX);
    const { id, time } = await this.send(conv, "text", { text: t });
    await this.record({ id, conv, dir: "out", time, kind: "text", text: t, device: this.me.device, delivered: 0 });
  }

  async record(m) {
    // Already past the conversation's retention (a message that waited long in the mailbox): not stored at all.
    if (m.time < this.cutoff(m.conv)) return;
    // Local order within a second: when this device stored it (kept when history is handed over).
    m.at ??= Date.now();
    if (m.dir === "out" && this.early.delete(m.id)) m.delivered = p.now();
    await this.store.putMessage(m);
    this.emit("messages", { conv: m.conv });
  }

  // ── receipts: "it arrived on one of my devices" (DESIGN.md §6.4) ──────────────────────────────────────────────

  /** Tell `account` soon that message `id` arrived on this device. Only for accepted contacts. */
  queueReceipt(account, id) {
    let set = this.receipts.get(account);
    if (!set) this.receipts.set(account, (set = new Set()));
    set.add(id);
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
      await this.store.putMessage(m);
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
        c.handle = state.handle;
        c.home = state.instance.home.url;
        c.updated = p.now();
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
        if (await this.store.hasMessage(m.id)) return;
        await this.record({ id: m.id, conv: peer, dir: "in", time: m.time, kind: "text", text: String(m.body?.text ?? "").slice(0, TEXT_MAX), device: m.from.device });
        this.emit("incoming", { conv: peer, kind: "text" });
        return;
      case "receipt":
        if (c?.state === "accepted" && Array.isArray(m.body?.ids)) await this.markDelivered(peer, m.body.ids);
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
        c.handle = state.handle;
        c.home = state.instance.home.url;
        c.updated = p.now();
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
        if (await this.store.hasMessage(m.id)) return;
        await this.record({ id: m.id, conv, dir: "out", time: m.time, kind: "text", text: String(m.body?.text ?? ""), device: m.from.device, delivered: 0 });
        return;
      case "file":
        await this.onFileMeta(m, conv, "out");
        return;
      case "sync": {
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

  async approveLink(request) {
    const own = await this.ownList(true);
    const accountKey = (await this.list(this.me.account)).state.instance.account_key;
    const e = await p.newEntry({
      account: this.me.account, accountKey, entries: own.entries, op: "add", device: request.device,
      signer: { id: this.me.device, key: this.device.privateKey },
    });
    await this.api.appendDevices(this.me.account, [e], [request.prekey]);
    await this.ownList(true);
    await this.sendHistory(request.device.id);
  }

  async removeDevice(id) {
    const own = await this.ownList(true);
    const d = own.present.find((x) => x.id === id);
    if (!d) return;
    const accountKey = (await this.list(this.me.account)).state.instance.account_key;
    const e = await p.newEntry({
      account: this.me.account, accountKey, entries: own.entries, op: "remove",
      device: { id: d.id, key: d.key, label: d.label },
      signer: { id: this.me.device, key: this.device.privateKey },
    });
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
        const accountKey = (await this.list(this.me.account)).state.instance.account_key;
        const entries = [...own.entries];
        const added = [];
        // Old keys go first, so that a list with the most devices still has room for the new one.
        for (const d of own.present.filter(p.isPaper)) {
          const e = await p.newEntry({
            account: this.me.account, accountKey, entries, op: "remove", device: { id: d.id, key: d.key, label: d.label },
            signer: { id: this.me.device, key: this.device.privateKey },
          });
          entries.push(e);
          added.push(e);
        }
        const e = await p.newEntry({
          account: this.me.account, accountKey, entries, op: "add", device: dev,
          signer: { id: this.me.device, key: this.device.privateKey },
        });
        added.push(e);
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
  }

  async mergeHistory(body) {
    for (const c of body?.contacts ?? []) {
      if (typeof c?.account !== "string") continue;
      const cur = this.contacts.get(c.account);
      if (!cur || (c.updated ?? 0) > (cur.updated ?? 0)) await this.saveContact({ ...c });
    }
    for (const m of body?.messages ?? []) {
      if (typeof m?.id !== "string" || typeof m.conv !== "string") continue;
      if (await this.store.hasMessage(m.id)) continue;
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
   * Returns `{ live, queued, waiting }` (numbers of the recipient's devices).
   */
  async sendFile(conv, file) {
    const c = this.contacts.get(conv);
    if (c?.state !== "accepted") throw new ApiError(409, "not_accepted");
    if (file.size > p.MAX_FILE) throw new ApiError(413, "too_large");
    const f = p.b64(p.random(16));
    const key = await p.newFileKey();
    const size = file.size;
    const n = Math.max(1, Math.ceil(size / p.CHUNK));
    // Read, hashed and stored part by part: the file is never in memory whole.
    const hash = new p.Sha256();
    for (let i = 0; i < n; i++) {
      const part = new Uint8Array(await file.slice(i * p.CHUNK, (i + 1) * p.CHUNK).arrayBuffer());
      hash.update(part);
      await this.store.putPart(f, i, part);
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
    await this.record(m);
    const to = [...online, ...queued];
    if (to.length) m.file.missed.push(...(await this.streamFile(meta, await this.store.fileReader(f), to, queued.length > 0)));
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
  async streamFile(meta, read, devices, store = false) {
    const key = p.unb64(meta.key);
    const ref = `${meta.f}.${p.b64(p.random(6))}`;
    const missed = new Set();
    this.missed.set(ref, missed);
    try {
      for (let i = 0; i < meta.n; i++) {
        const part = await read?.(i);
        if (!part) throw new Error("no_file");
        const data = await p.encryptChunk(key, meta.f, i, meta.n, part);
        await this.ws.drain();
        this.ws.relay(devices, data, { store, ref });
      }
      await this.ws.presence([this.me.device]); // answered after every chunk before it was handled
    } catch {
      return devices; // the connection broke: nobody got all of it for certain
    } finally {
      this.missed.delete(ref);
    }
    return [...missed];
  }

  /** Save which devices still miss a file and keep it on the list of files to offer again. */
  async settleFile(m) {
    m.file.missed = [...new Set(m.file.missed)];
    await this.store.putMessage(m);
    const rest = this.pendingFiles.filter((x) => x.id !== m.id);
    if (m.file.missed.length) rest.push({ conv: m.conv, id: m.id, time: m.time });
    if (rest.length !== this.pendingFiles.length || m.file.missed.length) {
      this.pendingFiles = rest;
      await this.store.setSecret("pendingFiles", rest);
    }
    this.emit("messages", { conv: m.conv });
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
        const m = (await this.store.messages(entry.conv)).find((x) => x.id === entry.id);
        const read = m?.file && (await this.store.fileReader(m.file.f));
        if (!m || !read || p.now() - entry.time > FILE_RETRY || !m.file.missed?.length) {
          this.pendingFiles = this.pendingFiles.filter((x) => x.id !== entry.id);
          await this.store.setSecret("pendingFiles", this.pendingFiles);
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
    if (b.n !== Math.max(1, Math.ceil(b.size / p.CHUNK))) return;
    b.name = p.safeFileName(b.name);
    b.mime = p.safeMime(b.mime);
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
      const m = await this.findFileMessage(r.f, r.conv);
      const read = await this.store.fileReader(r.f);
      if (m && read) await this.streamFile(m.file, read, [f.from]);
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
    await this.store.finishFile(f, t.meta.n, t.meta.size);
    await this.dropTransfer(f, t);
    const m = await this.store.message(t.message.id);
    if (m) {
      m.file.have = true;
      await this.store.putMessage(m);
      if (m.dir === "in" && this.contacts.get(m.conv)?.state === "accepted") this.queueReceipt(m.conv, m.id);
    }
    this.emit("file", { f });
    this.emit("messages", { conv: t.message.conv });
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

  async messages(conv) {
    return this.store.messages(conv);
  }
}

export { Store };
