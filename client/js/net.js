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
      case "prekey-ok":
      case "relay-space":
      case "ok":
        this.settle(f.id ?? f.ref, f);
        return;
      case "error":
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
