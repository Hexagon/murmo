// The authenticated WebSocket to the mailbox (docs/DESIGN.md §10), with reconnects and request/response by reference.
//
// Browsers freeze background pages and drop their sockets without telling the page. So the socket is checked when
// the page comes back (`wake()`), a heartbeat notices a dead connection, and a send waits a moment for a connection
// that is being set up instead of failing at once.

import * as p from "./protocol.js";
import { ApiError } from "./api.js";

const HEARTBEAT = 25_000;
const PONG_WAIT = 8_000;
const CONNECT_WAIT = 15_000;
const SEND_WAIT = 12_000;
// The server's relay budgets per minute (sent again in "ready", server/src/ws.rs), in bytes of chunks as sent (text,
// or the payload of binary frames):
// - live, to connected devices: `bytes` per sending device (once per recipient), `peer` per recipient device for
//   the sending account;
// - `granted`: per sending device, to devices that granted it more (they asked for the file; 0: no grants);
// - `store`: per sending account, into the file queue (absent: an older server, which counts queued chunks as live);
// - `frames` per device in all, `slow_frames` of them to anything but granted devices.
// `grant` is the largest grant, `binary` whether the server takes binary frames.
const RELAY_DEFAULT = {
  bytes: 384 * 1024 * 1024,
  peer: 96 * 1024 * 1024,
  granted: 0,
  store: 0,
  remote: 0,
  frames: 3000,
  slowFrames: 3000,
  grant: 0,
  binary: false,
  window: 60,
};
// Stay this far under them, so that a paced transfer does not run into a limit.
const RELAY_MARGIN = 0.9;

/** `e` (an Error, or what was thrown) marked as having come after part of a send went out. */
function partial(e) {
  const err = e instanceof Error ? e : new Error(String(e?.message ?? e));
  err.partial = true;
  return err;
}

export class Socket extends EventTarget {
  /** `auth(nonce)` returns `{ account, device, sig }`. */
  constructor(url, auth) {
    super();
    this.url = url;
    this.auth = auth;
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.waiting = new Map(); // ref → { resolve, reject, timer }
    this.readyWaiters = new Set();
    this.backoff = 1000;
    this.retry = null;
    this.beat = null;
    this.lastFrame = 0;
    this.relayLimits = RELAY_DEFAULT;
    this.relayLog = []; // { at, len, live, granted, stored } of relay frames sent within the window
    this.relayPause = 0; // no relay before this time (ms) after a "rate_limited"
    this.grants = new Map(); // device → { bytes, until (ms) }: what that device lets this one stream to it
    this.textOnly = new Set(); // devices the server said take no binary frames (older clients)
    this.caps = ["bin"]; // what this connection takes beyond JSON frames (told in "auth")
  }

  connect() {
    if (this.closed) return;
    clearTimeout(this.retry);
    this.retry = null;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === "string") this.onFrame(ev.data);
      else this.onBinary(ev.data);
    };
    ws.onclose = () => this.dropped(ws);
    ws.onerror = () => {};
    // A connection that never becomes ready (a hanging network) is given up.
    ws.connectTimer = setTimeout(() => {
      if (this.ws === ws && !this.ready) this.dropped(ws);
    }, CONNECT_WAIT);
  }

  schedule() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  /** The connection `ws` is gone (closed, or declared dead): clean up and connect again. */
  dropped(ws) {
    if (this.ws !== ws) return;
    clearTimeout(ws.connectTimer);
    ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already closed
    }
    this.ws = null;
    const was = this.ready;
    this.ready = false;
    clearInterval(this.beat);
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new Error("disconnected"));
    }
    this.waiting.clear();
    if (was) this.dispatchEvent(new CustomEvent("status", { detail: "offline" }));
    this.schedule();
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.beat);
    const ws = this.ws;
    if (ws) {
      this.dropped(ws);
      clearTimeout(this.retry);
    }
    for (const w of this.readyWaiters) w(false);
    this.readyWaiters.clear();
  }

  /**
   * The page is visible again, or the network came back: connect now instead of waiting for the backoff, and make
   * sure a socket that looks open really is.
   */
  wake() {
    if (this.closed) return;
    if (!this.ws) {
      this.backoff = 1000;
      this.connect();
    } else if (this.ready) {
      this.check(4000);
    }
  }

  /** Ping the server; without an answer in time the connection is dead. */
  check(wait = PONG_WAIT) {
    const ws = this.ws;
    if (!ws || !this.ready) return;
    const sent = Date.now();
    try {
      ws.send('{"t":"ping"}');
    } catch {
      this.dropped(ws);
      return;
    }
    setTimeout(() => {
      if (this.ws === ws && this.lastFrame < sent) {
        this.backoff = 1000;
        this.dropped(ws);
      }
    }, wait);
  }

  /** Resolves `true` when connected, `false` when that takes longer than `ms`. */
  whenReady(ms = SEND_WAIT) {
    if (this.ready) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer);
        this.readyWaiters.delete(done);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), ms);
      this.readyWaiters.add(done);
    });
  }

  async onFrame(data) {
    let f;
    try {
      f = JSON.parse(data);
    } catch {
      return;
    }
    this.lastFrame = Date.now();
    switch (f.t) {
      case "challenge": {
        const ws = this.ws;
        const a = await this.auth(f.nonce);
        // `caps`: this connection takes binary relay frames (servers that do not know it ignore it).
        if (this.ws === ws) ws.send(JSON.stringify({ t: "auth", ...a, caps: this.caps }));
        return;
      }
      case "ready":
        this.ready = true;
        this.relayLimits = relayLimits(f.relay);
        this.textOnly.clear();
        this.backoff = 1000;
        clearTimeout(this.ws.connectTimer);
        clearInterval(this.beat);
        this.beat = setInterval(() => this.check(), HEARTBEAT);
        this.dispatchEvent(new CustomEvent("status", { detail: "online" }));
        for (const w of [...this.readyWaiters]) w(true);
        return;
      case "pong":
        return;
      case "relay-grant":
        // A device of a contact or of this account asked for a file and lets this device stream it faster.
        if (typeof f.to === "string" && Number.isSafeInteger(f.bytes) && Number.isSafeInteger(f.ttl)) {
          if (f.bytes > 0) this.grants.set(f.to, { bytes: f.bytes, until: Date.now() + Math.min(f.ttl, 3600) * 1000 });
          else this.grants.delete(f.to);
        }
        return;
      case "relay-missed":
        for (const d of Array.isArray(f.text) ? f.text : []) if (typeof d === "string") this.textOnly.add(d);
        this.dispatchEvent(new CustomEvent(f.t, { detail: f }));
        return;
      case "sent":
      case "remote":
      case "presence":
      case "seen":
      case "prekey-ok":
      case "relay-space":
      case "ok":
        this.settle(f.id ?? f.ref, f);
        return;
      case "error":
        if (f.error === "replaced") {
          // This device connected again elsewhere (another tab or window of this browser): that one has the
          // connection now. Connecting again here would push it out in turn, so this page stops until it is reloaded.
          this.closed = true;
          clearTimeout(this.retry);
          this.dispatchEvent(new CustomEvent("replaced"));
          this.dropped(this.ws);
          return;
        }
        if (f.error === "rate_limited" && Number.isSafeInteger(f.retry) && f.retry > 0) {
          this.relayPause = Math.max(this.relayPause, Date.now() + Math.min(f.retry, 3600) * 1000);
        }
        if (f.id && !this.waiting.has(f.id)) {
          this.dispatchEvent(new CustomEvent("frame-error", { detail: { id: f.id, error: f.error, retry: f.retry } }));
        }
        if (f.id && this.waiting.has(f.id)) {
          const w = this.waiting.get(f.id);
          this.waiting.delete(f.id);
          clearTimeout(w.timer);
          w.reject(new Error(f.error));
          return;
        }
        this.dispatchEvent(new CustomEvent("server-error", { detail: f.error }));
        if (!this.ready) this.dropped(this.ws); // refused before "ready" (the server closes too)
        return;
      default:
        this.dispatchEvent(new CustomEvent(f.t, { detail: f }));
    }
  }

  settle(ref, f) {
    const w = ref && this.waiting.get(ref);
    if (!w) return;
    this.waiting.delete(ref);
    clearTimeout(w.timer);
    w.resolve(f);
  }

  send(frame) {
    if (!this.ready) throw new Error("offline");
    this.ws.send(JSON.stringify(frame));
  }

  /**
   * Send a frame that is answered by reference (`id` for send, `ref` for the others, `prekey-ok` by prekey id).
   * Waits a moment for a connection that is not there yet.
   */
  async call(frame, ref, timeout = 30000) {
    if (!this.ready && !(await this.whenReady())) throw new Error("offline");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(ref);
        reject(new Error("timeout"));
        this.check(4000);
      }, timeout);
      this.waiting.set(ref, { resolve, reject, timer });
      try {
        this.send(frame);
      } catch (e) {
        clearTimeout(timer);
        this.waiting.delete(ref);
        reject(e);
      }
    });
  }

  /**
   * Ask this server to ask another Murmo server (federation): `remote-lookup` or `remote-devices`. Only over this
   * authenticated connection, so the server answers for its own users only. Returns the other server's answer.
   */
  async remote(frame) {
    const ref = p.b64(p.random(12));
    try {
      return (await this.call({ ...frame, ref }, ref)).value;
    } catch (e) {
      throw new ApiError(502, e?.message ?? "server_error");
    }
  }

  /**
   * Send envelopes, 24 to a frame. Returns what the server said about them: `failed`, the devices they could not be
   * delivered to (unknown, full mailbox, another server that refused them), and `queued`, devices on another server
   * that could not be reached now, which their server keeps trying. The server takes a frame whole or not at all; when
   * a later frame fails after an earlier one was taken, the error is marked `partial`: some devices have the message,
   * and sending it again under a new id would give them a second copy.
   */
  async sendEnvelopes(to) {
    const failed = [];
    const queued = [];
    const strings = (a) => (Array.isArray(a) ? a.filter((d) => typeof d === "string") : []);
    for (let i = 0; i < to.length; i += 24) {
      const id = p.b64(p.random(12));
      let r;
      try {
        r = await this.call({ t: "send", id, to: to.slice(i, i + 24) }, id);
      } catch (e) {
        if (i > 0) throw partial(e);
        throw e;
      }
      failed.push(...strings(r?.failed));
      queued.push(...strings(r?.queued));
    }
    return { failed, queued };
  }

  async presence(devices) {
    if (devices.length === 0) return [];
    const ref = p.b64(p.random(12));
    const r = await this.call({ t: "presence", devices: devices.slice(0, 32), ref }, ref);
    return r.online ?? [];
  }

  /** When the account's own devices were last connected: `{ device: seconds }`, `0` for connected now. */
  async seen() {
    const ref = p.b64(p.random(12));
    const r = await this.call({ t: "seen", ref }, ref, 10000);
    return r.devices ?? {};
  }

  /** Which of `devices` the server can keep `bytes` of file chunks for while they are away. */
  async relaySpace(devices, bytes) {
    if (devices.length === 0) return [];
    const ref = p.b64(p.random(12));
    const r = await this.call({ t: "relay-space", devices: devices.slice(0, 32), bytes, ref }, ref);
    return r.ok ?? [];
  }

  /** Where this device is woken by push (`null`: nowhere). */
  async pushSubscription(endpoint) {
    const ref = p.b64(p.random(12));
    const frame = { t: "push-sub", ref };
    if (endpoint) frame.endpoint = endpoint;
    await this.call(frame, ref);
  }

  /**
   * A binary frame: a file chunk, dispatched as a "relay" event `{ from, account, id?, chunk }` with the chunk as
   * `{ k: "chunk", f, i, n, ct }` (`chunk: null` when the payload is malformed).
   */
  onBinary(data) {
    this.lastFrame = Date.now();
    const d = p.parseDelivered(data);
    if (!d) return;
    const detail = { from: d.from, account: d.account, chunk: p.parseChunkPayload(d.payload) };
    if (d.id) detail.id = d.id;
    this.dispatchEvent(new CustomEvent("relay", { detail }));
  }

  /** `store`: the server keeps the chunk for devices that are not connected. Misses come as "relay-missed". */
  relay(to, data, { store = false, ref, ttl = 0, stored, remote } = {}) {
    const frame = { t: "relay", to, data };
    if (store) frame.store = true;
    if (store && ttl > 0) frame.ttl = ttl; // queued chunks kept no longer (disappearing pictures)
    if (ref) frame.ref = ref;
    const routes = this.routes(to, data.length, stored, remote);
    this.send(frame);
    this.logRelay(routes, data.length);
  }

  /**
   * Send a sealed chunk `{ f, i, n, ct }` (p.sealChunk) to `to`, paced to the server's budgets: as a binary frame
   * where the server takes them, as text to devices that do not (and to all on an older server). `stored`: the
   * devices it is queued for (they are away), which the server counts against the queue's budget. `stop()` is
   * asked before each frame; it returns false when it said to stop. `ref` is 8 random bytes as base64url, so that
   * it fits a binary frame.
   */
  /**
   * `remote`: devices on other servers (federation), each with what its server takes per minute from this account
   * for this transfer. They count against this server's budget for other servers and against theirs, the smaller.
   */
  async sendChunk(to, chunk, { store = false, ref, ttl = 0, stored = new Set(), remote = new Map(), stop = () => false } = {}) {
    to = [...new Set(to)];
    const frames = [];
    const payload = this.relayLimits.binary ? p.chunkPayload(chunk) : null;
    const bin = payload ? to.filter((d) => !this.textOnly.has(d)) : [];
    const data = payload && bin.length ? p.relayFrame(bin, payload, { store, ttl, ref: p.unb64(ref) }) : null;
    if (data) frames.push({ to: bin, data, len: payload.length });
    const text = data ? to.filter((d) => this.textOnly.has(d)) : to;
    if (text.length) {
      const packed = p.packChunk(chunk);
      frames.push({ to: text, data: packed, len: packed.length });
    }
    for (const fr of frames) {
      await this.pace(fr.to, fr.len, stored, remote);
      await this.drain();
      if (stop()) return false;
      if (typeof fr.data === "string") {
        this.relay(fr.to, fr.data, { store, ref, ttl, stored, remote });
      } else {
        if (!this.ready) throw new Error("offline");
        const routes = this.routes(fr.to, fr.len, stored, remote);
        this.ws.send(fr.data);
        this.logRelay(routes, fr.len);
      }
    }
    return true;
  }

  /**
   * How the server counts a chunk of `len` bytes to each of `to`: devices that granted this one at least `len` more,
   * devices it is queued for (`stored`, on a server with a queue budget), and the rest, which go live.
   */
  routes(to, len, stored = new Set(), remote = new Map()) {
    const r = { live: [], granted: [], stored: 0, remote: [] };
    const now = Date.now();
    for (const d of new Set(to)) {
      const g = this.grants.get(d);
      if (remote.has(d)) r.remote.push(d);
      else if (stored.has(d) && this.relayLimits.store > 0) r.stored++;
      else if (this.relayLimits.granted > 0 && g && g.until > now && g.bytes >= len) r.granted.push(d);
      else r.live.push(d);
    }
    return r;
  }

  logRelay(routes, len) {
    const now = Date.now();
    for (const d of routes.granted) {
      const g = this.grants.get(d);
      if (g) g.bytes -= len;
    }
    while (this.relayLog.length && this.relayLog[0].at <= now - this.relayLimits.window * 1000) this.relayLog.shift();
    this.relayLog.push({ at: now, len, ...routes });
  }

  /**
   * Wait until a chunk of `len` bytes to `to` fits in the server's budgets: what was sent in the last window
   * (sliding, so the server's fixed windows are never exceeded either), with a margin, and no earlier than a
   * "rate_limited" said. Each route has its own budgets (see RELAY_DEFAULT).
   */
  async pace(to, len, stored = new Set(), remote = new Map()) {
    const L = this.relayLimits;
    const m = RELAY_MARGIN;
    for (;;) {
      const now = Date.now();
      const since = now - L.window * 1000;
      while (this.relayLog.length && this.relayLog[0].at <= since) this.relayLog.shift();
      let wait = this.relayPause - now;
      if (wait <= 0) {
        const next = this.routes(to, len, stored, remote);
        let live = 0;
        let granted = 0;
        let store = 0;
        let far = 0;
        let slow = 0;
        const per = new Map(next.live.map((d) => [d, 0]));
        const perFar = new Map(next.remote.map((d) => [d, 0]));
        for (const e of [...this.relayLog, { ...next, len }]) {
          live += e.len * e.live.length;
          granted += e.len * e.granted.length;
          store += e.len * e.stored;
          far += e.len * (e.remote?.length ?? 0);
          if (e.live.length || e.stored || e.remote?.length) slow++;
          for (const d of e.live) if (per.has(d)) per.set(d, per.get(d) + e.len);
          for (const d of e.remote ?? []) if (perFar.has(d)) perFar.set(d, perFar.get(d) + e.len);
        }
        const over =
          live > L.bytes * m ||
          [...per.values()].some((n) => n > L.peer * m) ||
          granted > L.granted * m ||
          store > L.store * m ||
          // Chunks to other servers: this server's budget for them (none announced: an older server, which has no
          // remote route), and each other server's own limit for this transfer, whichever is smaller.
          (L.remote > 0 && far > L.remote * m) ||
          [...perFar].some(([d, n]) => n > Math.min(L.remote || Infinity, remote.get(d) ?? L.peer) * m) ||
          this.relayLog.length + 1 > L.frames * m ||
          slow > L.slowFrames * m;
        // Nothing left to wait for: one frame larger than the whole budget is sent anyway (and refused).
        if (!over || !this.relayLog.length) return;
        wait = this.relayLog[0].at - since;
      }
      await new Promise((r) => setTimeout(r, Math.max(wait, 20)));
    }
  }

  /**
   * Let device `from` stream up to `bytes` more to this device for a while, beyond the live budgets (this device
   * asked it for a file). Resolves false when the server does not offer grants or refused.
   */
  async grant(from, bytes) {
    const max = this.relayLimits.grant;
    if (!(max > 0) || !this.ready) return false;
    const ref = p.b64(p.random(12));
    try {
      await this.call({ t: "relay-grant", from, bytes: Math.max(0, Math.min(Math.ceil(bytes), max)), ref }, ref, 10000);
      return true;
    } catch {
      return false;
    }
  }

  ack(ids) {
    if (ids.length && this.ready) this.send({ t: "ack", ids });
  }

  relayAck(ids) {
    if (ids.length && this.ready) this.send({ t: "relay-ack", ids });
  }

  /** Wait until the socket's buffer drains below `limit` bytes (back-pressure for file transfers). */
  async drain(limit = 4 * 1024 * 1024) {
    while (this.ws && this.ws.bufferedAmount > limit) await new Promise((r) => setTimeout(r, 10));
  }
}

/** The relay budgets from "ready", or the defaults for a server that does not send them. */
export function relayLimits(r) {
  const ok = (n) => Number.isSafeInteger(n) && n > 0;
  const opt = (n, d) => (Number.isSafeInteger(n) && n >= 0 ? n : d);
  if (!r || !ok(r.bytes) || !ok(r.peer) || !ok(r.window) || r.window > 3600) return RELAY_DEFAULT;
  return {
    bytes: r.bytes,
    peer: r.peer,
    granted: opt(r.granted, 0),
    store: opt(r.store, 0),
    remote: opt(r.remote, 0),
    frames: ok(r.frames) ? r.frames : RELAY_DEFAULT.frames,
    slowFrames: ok(r.slow_frames) ? r.slow_frames : RELAY_DEFAULT.slowFrames,
    grant: opt(r.grant, 0),
    binary: r.binary === 1,
    window: r.window,
  };
}
