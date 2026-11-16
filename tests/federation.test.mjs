// Federation end to end: two real Murmo servers (target/debug/murmo-server) that exchange envelopes, and the real
// client engine on each. Alice is on server A, Bob on server B; each client talks only to its own server. Covers
// lookup with `@server`, the request and acceptance, text both ways with receipts, that files are refused for now,
// that a server outside the federation policy is refused, and that nothing stays on either server once delivered.
//
//   cargo build && npm test

import "fake-indexeddb/auto";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Api, ApiError } from "../client/js/api.js";
import * as id from "../client/js/identity.js";
import { Messenger, Store, setupDevice } from "../client/js/core.js";

const PORT = 21000 + Math.floor(Math.random() * 1000);
const A = `http://127.0.0.1:${PORT}`;
const B = `http://127.0.0.1:${PORT + 1000}`;
const C = `http://127.0.0.1:${PORT + 2000}`; // a server that A does not federate with
const D = `http://127.0.0.1:${PORT + 3000}`; // a server with federation turned off (like one from before federation)
const dir = mkdtempSync(join(tmpdir(), "murmo-fed-"));
const apiA = new Api(A);
const apiB = new Api(B);
const apiC = new Api(C);
const apiD = new Api(D);
const servers = [];
const running = [];
let realms;

function start(origin, port, name, extra = {}) {
  const bin = new URL("../target/debug/murmo-server", import.meta.url).pathname;
  assert.ok(existsSync(bin), "run `cargo build` first");
  const s = spawn(bin, [], {
    env: {
      ...process.env, MURMO_ORIGIN: origin, MURMO_BIND: `127.0.0.1:${port}`, MURMO_DB: join(dir, `${name}.sqlite`),
      MURMO_HOST_KEY_FILE: join(dir, `${name}.key`), MURMO_CLIENT_DIR: "", MURMO_LIMIT_SCALE: "10", MURMO_REMOTE_HOMES: "",
      ...extra,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  servers.push(s);
  return s;
}

async function up(a) {
  for (let i = 0; i < 100; i++) {
    try {
      return await a.rc("GET", "/host");
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not start");
}

before(async () => {
  // Plain http on loopback is only possible with an explicit list of origins (an open server needs public https).
  start(A, PORT, "a", { MURMO_FEDERATION: `${B},${C},${D}`, MURMO_FEDERATION_BLOCK: C });
  start(B, PORT + 1000, "b", { MURMO_FEDERATION: A });
  start(C, PORT + 2000, "c", { MURMO_FEDERATION: A });
  start(D, PORT + 3000, "d", { MURMO_FEDERATION: "off" });
  await Promise.all([up(apiA), up(apiB), up(apiC), up(apiD)]);
  realms = (await apiA.info()).realms;
});

after(() => {
  for (const m of running) m.stop();
  for (const s of servers) s.kill();
});

function waitFor(target, type, pred = () => true, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    const f = (e) => {
      if (pred(e.detail)) {
        clearTimeout(t);
        target.removeEventListener(type, f);
        resolve(e.detail);
      }
    };
    target.addEventListener(type, f);
  });
}

async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const PW = "correct horse battery staple";

/** Register `username` on the server of `api` and start its first device there. */
async function user(api, username) {
  const reg = await id.prepareRegistration(api, username, PW);
  const { handle } = await reg.finish();
  const login = await id.login(api, api.base, handle, PW);
  const secret = await id.localSecret(api, login);
  const store = await Store.open(login.state.account, `${username}-${api.origin}`);
  await store.unlock(secret);
  const setup = await setupDevice({ api, store, state: login.state, login, label: username });
  assert.ok(setup.ready);
  login.unlocked.contents.accountSeed.fill(0);
  const m = new Messenger({ api, store, account: login.state.account, handle, home: api.base, realms });
  running.push(m);
  const online = waitFor(m, "status", (s) => s === "online");
  await m.start();
  await online;
  return { m, handle };
}

let alice, bob, aliceHandle, bobHandle;

test("each server publishes a federation key", async () => {
  const [ia, ib] = await Promise.all([apiA.info(), apiB.info()]);
  assert.match(ia.federation.key, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ia.federation.key, ib.federation.key);
});

test("an account on another server is found with @server, and only there", async () => {
  ({ m: alice, handle: aliceHandle } = await user(apiA, "Alice"));
  ({ m: bob, handle: bobHandle } = await user(apiB, "Bob"));
  // Without @, Bob is not on A.
  await assert.rejects(id.lookup(apiA, realms, bobHandle), (e) => e instanceof ApiError && e.code === "unknown_account");
  // Another server is only asked through the logged-in connection.
  await assert.rejects(id.lookup(apiA, realms, `${bobHandle}@127.0.0.1:${PORT + 1000}`), (e) => e.code === "unknown_account");
  const found = await id.lookup(apiA, realms, `${bobHandle}@127.0.0.1:${PORT + 1000}`, alice.remote);
  assert.equal(found.server, B);
  assert.equal(found.state.account, bob.me.account);
  // The own server's host means this server.
  const self = await id.lookup(apiA, realms, `${aliceHandle}@127.0.0.1:${PORT}`);
  assert.equal(self.server, null);
  // The full address also works with the server's lookup alone (clients from before federation send it as it is).
  assert.equal((await apiA.lookup(`${aliceHandle}@127.0.0.1:${PORT}`)).account, alice.me.account);
});

test("request, acceptance and text between servers", async () => {
  const incoming = waitFor(bob, "contacts", () => bob.contacts.get(alice.me.account)?.state === "incoming");
  const c = await alice.request(`${bobHandle}@127.0.0.1:${PORT + 1000}`, "Hej från server A");
  assert.equal(c.server, B);
  assert.equal(c.handle, `${bobHandle}@127.0.0.1:${PORT + 1000}`);
  await incoming;
  const ca = bob.contacts.get(alice.me.account);
  assert.equal(ca.server, A);
  assert.equal(ca.handle, `${aliceHandle}@127.0.0.1:${PORT}`);
  const accepted = waitFor(alice, "contacts", () => alice.contacts.get(bob.me.account)?.state === "accepted");
  await bob.accept(alice.me.account);
  await accepted;
  await alice.sendText(bob.me.account, "Hemligt över federationen");
  await until(async () => (await bob.messages(alice.me.account)).some((m) => m.text === "Hemligt över federationen"));
  await bob.sendText(alice.me.account, "Svar från B");
  await until(async () => (await alice.messages(bob.me.account)).some((m) => m.text === "Svar från B"));
  // Receipts come back across the servers too.
  await until(async () => (await alice.messages(bob.me.account)).every((m) => m.dir !== "out" || m.delivered > 0));
  assert.equal(await alice.safetyCode(bob.me.account), await bob.safetyCode(alice.me.account));
});

test("files to another server are refused for now", async () => {
  const file = new File([new Uint8Array(1000)], "x.bin", { type: "application/octet-stream" });
  await assert.rejects(alice.sendFile(bob.me.account, file), (e) => e.code === "remote_files");
});

test("servers outside the policy are refused", async () => {
  // A blocks C even though C is on its list; B does not federate with C at all.
  await assert.rejects(alice.remote.lookup(C, "Nobody#AAAA"), (e) => e.code === "federation_refused");
  await assert.rejects(bob.remote.lookup(C, "Nobody#AAAA"), (e) => e.code === "federation_refused");
  // A server that does not take part (an older one, say) is refused as such, not reported as an unknown account.
  assert.equal((await apiD.info()).federation, undefined);
  await assert.rejects(alice.remote.lookup(D, "Nobody#AAAA"), (e) => e.code === "federation_refused");
  // A delivery that claims to come from A but is not signed by A's key is refused.
  const res = await fetch(`${B}/api/v1/federation/deliver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      req: { v: 1, from: A, to: B, time: Math.floor(Date.now() / 1000), nonce: "AAAAAAAAAAAAAAAAAAAAAA", msgs: [{ device: "x", env: "AA" }] },
      sig: "A".repeat(86),
    }),
  });
  assert.equal(res.status, 401);
});

test("a server is no relay: only its own accounts send, only its own devices receive", async () => {
  // Nobody outside can make a server ask other servers: there is no such HTTP endpoint, only the logged-in socket.
  for (const path of ["/api/v1/remote/lookup?server=x&handle=y", "/api/v1/remote/devices?server=x&account=y"]) {
    const res = await fetch(`${A}${path}`);
    assert.notEqual(res.status, 200);
  }
  // A delivery to B for a device that is not on B (here Alice's own, on A) is refused, never passed on.
  const own = alice.ws;
  const r = await own.call({ t: "send", id: "relay-test", to: [{ device: alice.me.device, env: "AAAA", server: B }] }, "relay-test");
  assert.deepEqual(r.failed, [alice.me.device]);
  const unknown = await own.call({ t: "send", id: "relay-test2", to: [{ device: "Zm9vYmFyYmF6", env: "AAAA", server: B }] }, "relay-test2");
  assert.deepEqual(unknown.failed, ["Zm9vYmFyYmF6"]);
});

test("nothing stays on either server once delivered", async () => {
  await until(() => {
    for (const name of ["a", "b"]) {
      const db = new DatabaseSync(join(dir, `${name}.sqlite`), { readOnly: true });
      const n = db.prepare("SELECT COUNT(*) AS n FROM mailbox").get().n;
      db.close();
      if (n !== 0) return false;
    }
    return true;
  });
});
