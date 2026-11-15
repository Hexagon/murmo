// HTTP calls to the murmo server: the rootcard home under /id and the murmo API under /api/v1.

import * as rc from "../vendor/rootcard/src/index.js";

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export class Api {
  /** `origin` is the server's origin, such as `https://murmo.example` (no trailing slash). */
  constructor(origin) {
    this.origin = origin;
    this.base = `${origin}/id`; // the rootcard base URL ([HST-22]): never ends in /v0
    this.rcApi = `${this.base}/${rc.API_VERSION}`;
  }

  async request(url, method, body, token) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : rc.canonicalString(body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    const text = await res.text();
    let value = null;
    if (text) {
      try {
        value = rc.parseJson(new TextEncoder().encode(text));
      } catch {
        throw new ApiError(res.status, "bad_response");
      }
    }
    if (!res.ok) throw new ApiError(res.status, value?.error ?? `http_${res.status}`);
    return value;
  }

  /** A rootcard call to this server's own home. */
  rc(method, path, body, token) {
    return this.request(`${this.rcApi}${path}`, method, body, token);
  }

  /** A rootcard call to any home by its base URL (this server's or another, such as rootcard.org). */
  rcAt(base, method, path, body, token) {
    return this.request(`${base}/${rc.API_VERSION}${path}`, method, body, token);
  }

  murmo(method, path, body, token) {
    return this.request(`${this.origin}/api/v1${path}`, method, body, token);
  }

  devices(account) {
    return this.murmo("GET", `/accounts/${account}/devices`);
  }

  appendDevices(account, entries, prekeys) {
    const body = { entries };
    if (prekeys?.length) body.prekeys = prekeys;
    return this.murmo("POST", `/accounts/${account}/devices`, body);
  }

  info() {
    return this.murmo("GET", "/info");
  }

  /** Exact identifier among the identities this server knows; there is no search. */
  lookup(handle) {
    return this.murmo("GET", `/lookup?handle=${encodeURIComponent(handle)}`);
  }

  /** Make an identity from another home known to this server. */
  connect(account, home) {
    return this.murmo("POST", `/accounts/${account}/connect`, { home });
  }

  challenge() {
    return this.murmo("POST", "/challenge", {});
  }

  link(account, request, proof, nonce) {
    return this.murmo("POST", `/accounts/${account}/link`, { request, proof, nonce });
  }

  wsUrl() {
    return `${this.origin.replace(/^http/, "ws")}/api/v1/ws`;
  }
}
