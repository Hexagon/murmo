// The HTTP client (client/js/api.js) against small local servers: answers, error codes, a server that never answers
// (a timeout, not a stall) and one that cannot be reached (offline).
//
//   npm test

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Api, ApiError, REQUEST_TIMEOUT } from "../client/js/api.js";

let server;
let origin;
const hanging = new Set();

before(async () => {
  server = createServer((req, res) => {
    if (req.url.endsWith("/info")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } else if (req.url.endsWith("/missing")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"unknown_account"}');
    } else if (req.url.endsWith("/slow-body")) {
      // Headers at once, the body never.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
      hanging.add(res);
    } else {
      hanging.add(res); // never answers
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const r of hanging) r.destroy();
  server.closeAllConnections();
  server.close();
});

test("answers and error codes", async () => {
  const api = new Api(origin);
  assert.equal(api.timeout, REQUEST_TIMEOUT);
  assert.equal((await api.info()).ok, true);
  await assert.rejects(api.murmo("GET", "/missing"), (e) => e instanceof ApiError && e.status === 404 && e.code === "unknown_account");
});

test("a server that never answers fails as timeout instead of stalling", async () => {
  const api = new Api(origin, { timeout: 200 });
  const t = Date.now();
  await assert.rejects(api.murmo("GET", "/hang"), (e) => e instanceof ApiError && e.status === 0 && e.code === "timeout" && e.message === "timeout");
  assert.ok(Date.now() - t < 5000, "failed in time");
});

test("an answer whose body never ends fails as timeout too", async () => {
  const api = new Api(origin, { timeout: 200 });
  await assert.rejects(api.murmo("GET", "/slow-body"), (e) => e instanceof ApiError && e.code === "timeout");
});

test("an unreachable server fails as offline", async () => {
  // A port that was just free: nothing listens there.
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const api = new Api(`http://127.0.0.1:${port}`, { timeout: 2000 });
  await assert.rejects(api.info(), (e) => e instanceof ApiError && e.status === 0 && e.code === "offline");
});
