// The authenticated WebSocket to the mailbox (docs/DESIGN.md §10), with reconnects and request/response by reference.

import * as p from "./protocol.js";

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
    this.backoff = 1000;
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onmessage = (ev) => this.onFrame(ev.data);
    ws.onclose = () => {
      const was = this.ready;
      this.ready = false;
      for (const [, w] of this.waiting) w.reject(new Error("disconnected"));
      this.waiting.clear();
      if (was) this.dispatchEvent(new CustomEvent("status", { detail: "offline" }));
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30000);
      }
    };
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  async onFrame(data) {
    let f;
    try {
      f = JSON.parse(data);
    } catch {
      return;
    }
    switch (f.t) {
      case "challenge": {
        const a = await this.auth(f.nonce);
        this.ws.send(JSON.stringify({ t: "auth", ...a }));
        return;
      }
      case "ready":
        this.ready = true;
        this.backoff = 1000;
        this.dispatchEvent(new CustomEvent("status", { detail: "online" }));
        return;
      case "sent":
      case "presence":
      case "prekey-ok":
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

  /** Send a frame that is answered by reference (`id` for send, `ref` for presence, `prekey-ok` by prekey id). */
  call(frame, ref, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(ref);
        reject(new Error("timeout"));
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

  relay(to, data) {
    this.send({ t: "relay", to, data });
  }

  ack(ids) {
    if (ids.length && this.ready) this.send({ t: "ack", ids });
  }

  /** Wait until the socket's buffer drains below `limit` bytes (back-pressure for file transfers). */
  async drain(limit = 2 * 1024 * 1024) {
    while (this.ws && this.ws.bufferedAmount > limit) await new Promise((r) => setTimeout(r, 20));
  }
}
