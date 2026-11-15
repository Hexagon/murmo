// The authenticated WebSocket to the mailbox (docs/DESIGN.md §10), with reconnects and request/response by reference.
//
// Browsers freeze background pages and drop their sockets without telling the page. So the socket is checked when
// the page comes back (`wake()`), a heartbeat notices a dead connection, and a send waits a moment for a connection
// that is being set up instead of failing at once.

import * as p from "./protocol.js";

const HEARTBEAT = 25_000;
const PONG_WAIT = 8_000;
const CONNECT_WAIT = 15_000;
const SEND_WAIT = 12_000;
// The server's relay budgets in bytes of chunk text per minute (sent again in "ready"): per sending device, counted
// once per recipient device, and per recipient device for the sending account (server/src/ws.rs).
const RELAY_DEFAULT = { bytes: 384 * 1024 * 1024, peer: 96 * 1024 * 1024, window: 60 };
// Stay this far under them, so that a paced transfer does not run into a limit.
const RELAY_MARGIN = 0.9;

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
    this.relayLog = []; // { at, len, to } of relay frames sent within the window
    this.relayPause = 0; // no relay before this time (ms) after a "rate_limited"
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
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onFrame(ev.data);
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
        if (this.ws === ws) ws.send(JSON.stringify({ t: "auth", ...a }));
        return;
      }
      case "ready":
        this.ready = true;
        this.relayLimits = relayLimits(f.relay);
        this.backoff = 1000;
        clearTimeout(this.ws.connectTimer);
        clearInterval(this.beat);
        this.beat = setInterval(() => this.check(), HEARTBEAT);
        this.dispatchEvent(new CustomEvent("status", { detail: "online" }));
        for (const w of [...this.readyWaiters]) w(true);
        return;
      case "pong":
        return;
      case "sent":
      case "presence":
      case "seen":
      case "prekey-ok":
      case "relay-space":
      case "ok":
        this.settle(f.id ?? f.ref, f);
        return;
      case "error":
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

  async sendEnvelopes(to) {
    for (let i = 0; i < to.length; i += 24) {
      const id = p.b64(p.random(12));
      await this.call({ t: "send", id, to: to.slice(i, i + 24) }, id);
    }
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

  /** `store`: the server keeps the chunk for devices that are not connected. Misses come as "relay-missed". */
  relay(to, data, { store = false, ref } = {}) {
    const frame = { t: "relay", to, data };
    if (store) frame.store = true;
    if (ref) frame.ref = ref;
    this.send(frame);
    const now = Date.now();
    while (this.relayLog.length && this.relayLog[0].at <= now - this.relayLimits.window * 1000) this.relayLog.shift();
    this.relayLog.push({ at: now, len: data.length, to: [...new Set(to)] });
  }

  /**
   * Wait until `len` bytes of relay text to `to` fit in the server's budgets: what was sent in the last window
   * (sliding, so the server's fixed windows are never exceeded either), with a margin, and no earlier than a
   * "rate_limited" said.
   */
  async pace(to, len) {
    to = [...new Set(to)];
    const { bytes, peer, window } = this.relayLimits;
    for (;;) {
      const now = Date.now();
      const since = now - window * 1000;
      while (this.relayLog.length && this.relayLog[0].at <= since) this.relayLog.shift();
      let wait = this.relayPause - now;
      if (wait <= 0) {
        let total = len * to.length;
        const per = new Map(to.map((d) => [d, len]));
        for (const e of this.relayLog) {
          total += e.len * e.to.length;
          for (const d of e.to) if (per.has(d)) per.set(d, per.get(d) + e.len);
        }
        const over = total > bytes * RELAY_MARGIN || [...per.values()].some((n) => n > peer * RELAY_MARGIN);
        // Nothing left to wait for: one frame larger than the whole budget is sent anyway (and refused).
        if (!over || !this.relayLog.length) return;
        wait = this.relayLog[0].at - since;
      }
      await new Promise((r) => setTimeout(r, Math.max(wait, 20)));
    }
  }

  ack(ids) {
    if (ids.length && this.ready) this.send({ t: "ack", ids });
  }

  relayAck(ids) {
    if (ids.length && this.ready) this.send({ t: "relay-ack", ids });
  }

  /** Wait until the socket's buffer drains below `limit` bytes (back-pressure for file transfers). */
  async drain(limit = 2 * 1024 * 1024) {
    while (this.ws && this.ws.bufferedAmount > limit) await new Promise((r) => setTimeout(r, 20));
  }
}

/** The relay budgets from "ready", or the defaults for a server that does not send them. */
function relayLimits(r) {
  const ok = (n) => Number.isSafeInteger(n) && n > 0;
  if (!r || !ok(r.bytes) || !ok(r.peer) || !ok(r.window) || r.window > 3600) return RELAY_DEFAULT;
  return { bytes: r.bytes, peer: r.peer, window: r.window };
}
