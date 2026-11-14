// The messenger engine: devices, contacts and requests, messages, multi-device sync, history hand-over and live
// file transfer (docs/DESIGN.md). No DOM: the UI listens to events.
//
// Events: "status" (online/offline), "contacts", "messages" ({ conv }), "link" ({ request, code }), "file" ({ f }),
// "removed" (this device was removed), "error" ({ message }).

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

/**
 * Prepare this browser as a device of the account after a login (docs/DESIGN.md §4.2, §4.3).
 * Returns `{ ready: true }`, or `{ ready: false, code, waitForApproval() }` while another device must approve.
 */
export async function setupDevice({ api, store, state, login, label }) {
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
  return {
    ready: false,
    code,
    async waitForApproval(signal) {
      while (!signal?.aborted) {
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
  constructor({ api, store, account, handle, home, realms }) {
    super();
    this.api = api;
    this.store = store;
    this.me = { account, device: null };
    this.handle = handle;
    this.home = home;
    this.realms = realms;
    this.lists = new Map(); // account → { state, list, prekeys: Map, at }
    this.contacts = new Map();
    this.prekeys = new Map(); // id → { privateKey, publicRaw, time }
    this.files = new Map(); // f → { meta, chunks: [], got, from }
    this.status = "offline";
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
    this.ws.addEventListener("relay", (e) => this.onRelay(e.detail).catch(() => {}));
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
    this.ws?.close();
    this.store.close();
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
    await this.send(c.account, kind, body);
    if (body.note) await this.record({ id: p.b64(p.random(16)), conv: c.account, dir: "out", time: p.now(), kind: "text", text: body.note });
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
      to.push({ device: t.device, env: await p.seal(t.device, t.prekey, bytes) });
    }
    if (to.length) await this.ws.sendEnvelopes(to);
    return { id, time };
  }

  async ownTargets() {
    const own = await this.list(this.me.account);
    return own.list.present
      .filter((d) => d.id !== this.me.device)
      .map((d) => ({ account: this.me.account, device: d.id, prekey: own.prekeys.get(d.id) }));
  }

  async peerTargets(account) {
    const c = this.contacts.get(account);
    if (c?.fork) throw new ApiError(409, "fork");
    const l = await this.list(account);
    return l.list.present.map((d) => ({ account, device: d.id, prekey: l.prekeys.get(d.id) }));
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
    await this.record({ id, conv, dir: "out", time, kind: "text", text: t, device: this.me.device });
  }

  async record(m) {
    // Local order within a second: when this device stored it (kept when history is handed over).
    m.at ??= Date.now();
    await this.store.putMessage(m);
    this.emit("messages", { conv: m.conv });
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
        // One pending request per sender; nothing changes for accepted or pending contacts.
        if (c?.state === "accepted" || c?.state === "incoming") return;
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
        return;
      }
      case "accept":
        // Only an answer to OUR request: a sender can never accept its own request on the recipient's behalf.
        if (c?.state === "outgoing") {
          c.state = "accepted";
          c.updated = p.now();
          await this.saveContact(c);
        }
        return;
      case "text":
        if (c?.state !== "accepted" || (await this.store.hasMessage(m.id))) return;
        await this.record({ id: m.id, conv: peer, dir: "in", time: m.time, kind: "text", text: String(m.body?.text ?? "").slice(0, TEXT_MAX), device: m.from.device });
        return;
      case "file":
        if (c?.state !== "accepted") return;
        await this.onFileMeta(m, peer, "in");
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
        if (note) await this.record({ id: m.id, conv, dir: "out", time: m.time, kind: "text", text: note });
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
        await this.record({ id: m.id, conv, dir: "out", time: m.time, kind: "text", text: String(m.body?.text ?? ""), device: m.from.device });
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
      if (m.file) m.file.have = false;
      await this.store.putMessage(m);
      this.emit("messages", { conv: m.conv });
    }
  }

  // ── files (DESIGN.md §9) ──────────────────────────────────────────────────────────────────────────────────────

  /** Send a file live to the devices connected now. Returns how many devices it went to. */
  async sendFile(conv, file) {
    const c = this.contacts.get(conv);
    if (c?.state !== "accepted") throw new ApiError(409, "not_accepted");
    if (file.size > p.MAX_FILE) throw new ApiError(413, "too_large");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const f = p.b64(p.random(16));
    const key = await p.newFileKey();
    const n = Math.max(1, Math.ceil(bytes.length / p.CHUNK));
    const meta = {
      f, name: String(file.name || "fil").slice(0, 200), mime: String(file.type || "application/octet-stream").slice(0, 100),
      size: bytes.length, sha256: p.b64(await p.sha256(bytes)), key: p.b64(key), n,
    };
    const peers = await this.peerTargets(conv);
    const owns = await this.ownTargets();
    const online = await this.ws.presence([...peers, ...owns].map((t) => t.device));
    await this.store.putFile(f, bytes);
    const { id, time } = await this.deliver([...peers, ...owns], "file", conv, meta);
    await this.record({ id, conv, dir: "out", time, kind: "file", file: { ...meta, have: true }, device: this.me.device });
    if (online.length) await this.streamFile(meta, bytes, online);
    return online.length;
  }

  async streamFile(meta, bytes, devices) {
    const key = p.unb64(meta.key);
    for (let i = 0; i < meta.n; i++) {
      const data = await p.encryptChunk(key, meta.f, i, meta.n, bytes.subarray(i * p.CHUNK, (i + 1) * p.CHUNK));
      await this.ws.drain();
      this.ws.relay(devices, data);
    }
  }

  async onFileMeta(m, conv, dir) {
    const b = m.body ?? {};
    if (typeof b.f !== "string" || !Number.isSafeInteger(b.size) || !Number.isSafeInteger(b.n) || b.size > p.MAX_FILE) return;
    if (!(await this.store.hasMessage(m.id))) {
      const have = await this.store.hasFile(b.f);
      await this.record({ id: m.id, conv, dir, time: m.time, kind: "file", file: { ...b, have }, device: m.from.device });
    }
    const t = this.files.get(b.f) ?? { chunks: [], got: 0 };
    t.meta = b;
    t.message = { id: m.id, conv };
    this.files.set(b.f, t);
    await this.tryAssemble(b.f);
  }

  async onRelay(f) {
    let r;
    try {
      r = p.unpack(f.data);
    } catch {
      return;
    }
    if (r.k === "chunk") {
      if (typeof r.f !== "string" || !Number.isSafeInteger(r.i) || !Number.isSafeInteger(r.n) || r.i < 0 || r.i >= r.n || r.n > 4096) return;
      const t = this.files.get(r.f) ?? { chunks: [], got: 0 };
      if (!t.chunks[r.i]) {
        t.chunks[r.i] = r;
        t.got++;
      }
      t.updated = Date.now();
      this.files.set(r.f, t);
      if (this.files.size > 64) this.sweepFiles();
      await this.tryAssemble(r.f);
    } else if (r.k === "file-req" && f.account === this.me.account) {
      // Later federation: serve our own other devices only.
      const own = await this.ownList();
      if (!own.present.some((d) => d.id === f.from)) return;
      const m = await this.findFileMessage(r.f, r.conv);
      const bytes = await this.store.file(r.f);
      if (m && bytes) await this.streamFile(m.file, bytes, [f.from]);
    }
  }

  sweepFiles() {
    const t = Date.now() - 10 * 60_000;
    for (const [f, v] of this.files) if ((v.updated ?? 0) < t && !v.meta) this.files.delete(f);
  }

  async tryAssemble(f) {
    const t = this.files.get(f);
    if (!t?.meta || t.got < t.meta.n) return;
    const key = p.unb64(t.meta.key);
    const parts = [];
    try {
      for (let i = 0; i < t.meta.n; i++) parts.push(await p.decryptChunk(key, t.chunks[i]));
    } catch {
      this.files.delete(f);
      return;
    }
    const total = parts.reduce((a, b) => a + b.length, 0);
    if (total !== t.meta.size) return this.files.delete(f);
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const x of parts) {
      bytes.set(x, o);
      o += x.length;
    }
    if (p.b64(await p.sha256(bytes)) !== t.meta.sha256) return this.files.delete(f);
    await this.store.putFile(f, bytes);
    this.files.delete(f);
    const msgs = await this.store.messages(t.message.conv);
    const m = msgs.find((x) => x.id === t.message.id);
    if (m) {
      m.file.have = true;
      await this.store.putMessage(m);
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
    const t = this.files.get(f) ?? { chunks: [], got: 0 };
    t.meta = m.file;
    t.message = { id: m.id, conv };
    this.files.set(f, t);
    const own = (await this.ownTargets()).map((x) => x.device);
    const online = await this.ws.presence(own);
    if (online.length) this.ws.relay(online, p.pack({ k: "file-req", f, conv }));
    return online.length;
  }

  async fileBlob(f, mime) {
    const bytes = await this.store.file(f);
    return bytes ? new Blob([bytes], { type: mime }) : null;
  }

  async messages(conv) {
    return this.store.messages(conv);
  }
}

export { Store };
