// End to end: the real server (target/debug/mesg-server) and the real client engine (client/js/core.js) in Node 22,
// with IndexedDB from fake-indexeddb. Covers registration, login, device genesis, message requests, text, linking a
// second device with history hand-over, live file transfer, later federation between own devices, an identity whose
// home is another rootcard server (a second server plays rootcard.org), and that the server keeps nothing once
// messages are delivered.
//
//   cargo build && npm test

import "fake-indexeddb/auto";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Api, ApiError } from "../client/js/api.js";
import * as id from "../client/js/identity.js";
import { Messenger, Store, setupDevice } from "../client/js/core.js";
import * as p from "../client/js/protocol.js";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OTHER = `http://127.0.0.1:${PORT + 1000}`; // another rootcard home, like rootcard.org
const dir = mkdtempSync(join(tmpdir(), "mesg-e2e-"));
const DB = join(dir, "mesg.sqlite"); // the mesg server's database
let server, other, info;
const api = new Api(ORIGIN);
const otherApi = new Api(OTHER);
const running = [];
// A stand-in for a browser push service: records the wake-ups the server sends.
const pushes = [];
const PUSH_PORT = PORT + 2000;
const pushService = createServer((req, res) => {
  pushes.push({ url: req.url, auth: req.headers.authorization ?? "", ttl: req.headers.ttl });
  req.resume();
  res.writeHead(201).end();
});

function start(origin, port, name, extra = {}) {
  const bin = new URL("../target/debug/mesg-server", import.meta.url).pathname;
  assert.ok(existsSync(bin), "run `cargo build` first");
  return spawn(bin, [], {
    env: {
      ...process.env, MESG_ORIGIN: origin, MESG_BIND: `127.0.0.1:${port}`, MESG_DB: join(dir, `${name}.sqlite`),
      MESG_HOST_KEY_FILE: join(dir, `${name}.key`), MESG_CLIENT_DIR: "", MESG_LIMIT_SCALE: "10", ...extra,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
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
  await new Promise((r) => pushService.listen(PUSH_PORT, "127.0.0.1", r));
  server = start(ORIGIN, PORT, "mesg", { MESG_REMOTE_HOMES: OTHER, MESG_PUSH_HOSTS: `http://127.0.0.1:${PUSH_PORT}` });
  other = start(OTHER, PORT + 1000, "other", { MESG_REMOTE_HOMES: "" });
  await up(api);
  await up(otherApi);
  info = await api.info();
});

after(() => {
  for (const m of running) m.stop();
  server?.kill();
  other?.kill();
  pushService.close();
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

async function device(handle, password, prefix, onLink, home = api.base) {
  const login = await id.login(api, home, handle, password);
  if (home !== api.base) await api.connect(login.state.account, home);
  const secret = await id.localSecret(api, login);
  const store = await Store.open(login.state.account, prefix);
  await store.unlock(secret);
  const setup = await setupDevice({ api, store, state: login.state, login, label: prefix });
  if (!setup.ready) {
    await onLink(setup);
    assert.equal(await setup.waitForApproval(), true);
  }
  login.unlocked.contents.accountSeed.fill(0);
  const m = new Messenger({ api, store, account: login.state.account, handle: login.state.handle, home, realms: info.realms });
  running.push(m);
  const online = waitFor(m, "status", (s) => s === "online");
  await m.start();
  await online;
  return m;
}

async function register(username, password, at = api) {
  const reg = await id.prepareRegistration(at, username, password);
  assert.match(reg.cardText, /RCR/); // the card exists before anything is sent
  const done = await reg.finish();
  return done.handle;
}

const PW = "correct horse battery staple";

/** Random bytes of any length (getRandomValues gives at most 64 KiB per call). */
function noise(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) out.set(p.random(Math.min(65536, n - i)), i);
  return out;
}
let alice, bob, alice2, aliceHandle, bobHandle;

test("register, login and first devices", async () => {
  aliceHandle = await register("Alice", PW);
  bobHandle = await register("Bob", PW);
  alice = await device(aliceHandle, PW, "alice1");
  bob = await device(bobHandle, PW, "bob1");
  assert.equal((await alice.ownList(true)).present.length, 1);
});

test("no search: only exact identifiers", async () => {
  await assert.rejects(id.lookup(api, info.realms, "Bob"), (e) => e instanceof ApiError && e.code === "bad_handle");
  await assert.rejects(api.lookup("Bob"), ApiError);
  await assert.rejects(api.lookup("B*"), ApiError);
  await assert.rejects(api.rc("GET", "/id/lookup?realm=global&handle=Bob"), ApiError);
  await assert.rejects(alice.request("Bob#ZZZZ"), ApiError);
});

test("message request, acceptance and text", async () => {
  const incoming = waitFor(bob, "contacts", () => bob.contacts.get(alice.me.account)?.state === "incoming");
  await alice.request(bobHandle, "Hej Bob, det är Alice");
  await incoming;
  const c = bob.contacts.get(alice.me.account);
  assert.equal(c.handle, aliceHandle);
  // Nothing but the request is accepted before Bob says yes.
  await assert.rejects(alice.sendText(bob.me.account, "för tidigt"), (e) => e.code === "not_accepted");
  // A sender cannot accept its own request on the recipient's behalf, nor slip text past it.
  await alice.deliver(await alice.peerTargets(bob.me.account), "accept", bob.me.account, {});
  await alice.deliver(await alice.peerTargets(bob.me.account), "text", bob.me.account, { text: "smugglad" });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(bob.contacts.get(alice.me.account).state, "incoming");
  assert.ok(!(await bob.messages(alice.me.account)).some((m) => m.text === "smugglad"));
  const accepted = waitFor(alice, "contacts", () => alice.contacts.get(bob.me.account)?.state === "accepted");
  await bob.accept(alice.me.account);
  await accepted;
  const got = waitFor(bob, "messages");
  await alice.sendText(bob.me.account, "Hemligt meddelande");
  await got;
  await until(async () => (await bob.messages(alice.me.account)).some((m) => m.text === "Hemligt meddelande"));
  // Bob's device tells Alice that it arrived: queued on the server (0) becomes delivered. The request note too.
  await until(async () => (await alice.messages(bob.me.account)).every((m) => m.dir !== "out" || m.delivered > 0));
  assert.equal((await alice.messages(bob.me.account)).filter((m) => m.dir === "out").length, 2);
  assert.equal(await alice.safetyCode(bob.me.account), await bob.safetyCode(alice.me.account));
});

test("a password alone cannot add a device", async () => {
  const login = await id.login(api, api.base, aliceHandle, PW);
  const state = login.state;
  const remote = await api.devices(state.account);
  const kp = await p.newKeyPair("Ed25519");
  const devValue = { id: await p.deviceId(kp.publicRaw), key: (await import("../client/vendor/rootcard/src/index.js")).formatKey("ed25519", kp.publicRaw), label: "thief" };
  const forged = await p.newEntry({
    account: state.account, accountKey: state.instance.account_key, entries: remote.entries, op: "add", device: devValue,
    signer: { id: "account", key: login.unlocked.contents.accountSeed },
  });
  await assert.rejects(api.appendDevices(state.account, [forged]), (e) => e.status === 400);
  login.unlocked.contents.accountSeed.fill(0);
});

test("link a second device: approval on the first, history handed over", async () => {
  alice2 = await device(aliceHandle, PW, "alice2", async (setup) => {
    const req = await waitFor(alice, "link");
    assert.equal(req.code, setup.code); // both screens show the same code
    await alice.approveLink(req.request);
  });
  assert.equal((await alice2.ownList(true)).present.length, 2);
  await until(async () => alice2.contacts.get(bob.me.account)?.state === "accepted");
  await until(async () => (await alice2.messages(bob.me.account)).some((m) => m.text === "Hemligt meddelande"));
  // New messages reach both of Alice's devices; Alice's own sends are mirrored.
  bob.lists.clear();
  await bob.sendText(alice.me.account, "Svar från Bob");
  await until(async () => (await alice2.messages(bob.me.account)).some((m) => m.text === "Svar från Bob" && m.dir === "in"));
  await until(async () => (await alice.messages(bob.me.account)).some((m) => m.text === "Svar från Bob"));
  alice.lists.clear();
  await alice.sendText(bob.me.account, "Från laptopen");
  await until(async () => (await alice2.messages(bob.me.account)).some((m) => m.text === "Från laptopen" && m.dir === "out"));
  // Bob's receipt reaches both of Alice's devices: the one that wrote it and the other.
  for (const dev of [alice, alice2]) await until(async () => (await dev.messages(bob.me.account)).find((m) => m.text === "Från laptopen")?.delivered > 0);
});

test("files go live to connected devices, wait for absent ones, and own devices federate later", async () => {
  const data = noise(150_000);
  const file = new File([data], "bild.png", { type: "image/png" });
  const bobGot = waitFor(bob, "file");
  const alice2Got = waitFor(alice2, "file");
  alice.lists.clear();
  const r = await alice.sendFile(bob.me.account, file);
  assert.deepEqual(r, { live: 1, queued: 0, waiting: 0 }); // Bob's device (Alice's second device got it too)
  const { f } = await bobGot;
  await alice2Got;
  assert.deepEqual(await bob.store.file(f), data);
  assert.deepEqual(await alice2.store.file(f), data);

  // Alice's second device goes offline and the server may not keep files (the setting is off): a new file reaches
  // only Bob's connected device, and the second device is noted as still missing it.
  alice2.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  alice.fileQueue = () => false;
  const data2 = noise(70_000);
  const bobGot2 = waitFor(bob, "file");
  const r2 = await alice.sendFile(bob.me.account, new File([data2], "dok.pdf", { type: "application/pdf" }));
  assert.deepEqual(r2, { live: 1, queued: 0, waiting: 0 });
  const { f: f2 } = await bobGot2;
  const sent2 = (await alice.messages(bob.me.account)).find((m) => m.file?.f === f2);
  assert.deepEqual(sent2.file.missed, [alice2.me.device]);
  alice.fileQueue = () => true;

  // Back online, the second device knows the file but has no content; it asks its own devices.
  alice2.stop();
  const store = await Store.open(alice.me.account, "alice2");
  const secretLogin = await id.login(api, api.base, aliceHandle, PW);
  await store.unlock(await id.localSecret(api, secretLogin));
  secretLogin.unlocked.contents.accountSeed.fill(0);
  const a2 = new Messenger({ api, store, account: alice.me.account, handle: aliceHandle, home: api.base, realms: info.realms });
  running.push(a2);
  const online = waitFor(a2, "status", (s) => s === "online");
  await a2.start();
  await online;
  const meta = await until(async () => (await a2.messages(bob.me.account)).find((m) => m.file?.f === f2));
  assert.equal(meta.file.have, false);
  const fed = waitFor(a2, "file", (d) => d.f === f2);
  assert.equal(await a2.fetchFromOwnDevices(bob.me.account, f2), 1);
  await fed;
  assert.deepEqual(await a2.store.file(f2), data2);

  // A file for a recipient that is not connected waits, encrypted, on the server and arrives when it connects.
  bob.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  const data3 = noise(120_000);
  const r3 = await alice.sendFile(bob.me.account, new File([data3], "foto.jpg", { type: "image/jpeg" }));
  assert.deepEqual(r3, { live: 0, queued: 1, waiting: 0 });
  const db = new DatabaseSync(DB, { readOnly: true });
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM relay_queue").get().n > 0);
  db.close();
  const sent3 = (await alice.messages(bob.me.account)).find((m) => m.file?.name === "foto.jpg");
  assert.equal(Messenger.undelivered(sent3), false);
  clearInterval(bob.retryTimer);
  const bobGot3 = waitFor(bob, "file", (d) => d.f === sent3.file.f, 20000);
  const back = waitFor(bob, "status", (s) => s === "online");
  await bob.start();
  await back;
  await bobGot3;
  assert.deepEqual(await bob.store.file(sent3.file.f), data3);
  await until(() => {
    const d = new DatabaseSync(DB, { readOnly: true });
    const n = d.prepare("SELECT COUNT(*) AS n FROM relay_queue").get().n;
    d.close();
    return n === 0;
  });
});

test("a message to a device that is away wakes it with an empty push", async () => {
  assert.ok(info.push_key, "the server offers push");
  await bob.setPushEndpoint(`http://127.0.0.1:${PUSH_PORT}/sub/bob`);
  await assert.rejects(bob.setPushEndpoint("https://evil.example/sub"), /push_host_not_allowed/);
  bob.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  const before = pushes.length;
  await alice.sendText(bob.me.account, "Är du där?");
  await until(() => pushes.length > before, 10000);
  const push = pushes.at(-1);
  assert.equal(push.url, "/sub/bob");
  assert.match(push.auth, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
  // Alice's own devices are not woken for her own messages.
  assert.ok(pushes.slice(before).every((x) => x.url === "/sub/bob"));
  // While Bob is away the message is queued on the server: not delivered on any of Alice's devices.
  const waiting = async (dev) => (await dev.messages(bob.me.account)).find((m) => m.text === "Är du där?");
  assert.equal((await waiting(alice)).delivered, 0);
  clearInterval(bob.retryTimer);
  const back = waitFor(bob, "status", (s) => s === "online");
  await bob.start();
  await back;
  await until(async () => (await bob.messages(alice.me.account)).some((m) => m.text === "Är du där?"));
  // Delivered once Bob's device has read its mailbox, on the device that sent it.
  await until(async () => (await waiting(alice)).delivered > 0);
  await bob.setPushEndpoint(null);
});

test("an identity from another rootcard home (like rootcard.org) logs in and talks", async () => {
  // Carol's identity lives at the other home; she never registers at the mesg server.
  const carolHandle = await register("Carol", PW, otherApi);
  // Before she connects, the mesg server does not know her: no lookup by identifier.
  await assert.rejects(api.lookup(carolHandle), (e) => e.code === "unknown_account");
  const carol = await device(carolHandle, PW, "carol1", undefined, otherApi.base);
  assert.equal(carol.home, otherApi.base);
  // Alice finds her by the exact identifier (also with @host), verifies her log at her own home, and they talk.
  const found = await api.lookup(`${carolHandle}@${new URL(OTHER).host}`);
  assert.equal(found.home, otherApi.base);
  const incoming = waitFor(carol, "contacts", () => carol.contacts.get(alice.me.account)?.state === "incoming");
  alice.lists.clear();
  await alice.request(carolHandle, "Hej Carol");
  await incoming;
  await carol.accept(alice.me.account);
  await until(async () => alice.contacts.get(carol.me.account)?.state === "accepted");
  assert.equal(alice.contacts.get(carol.me.account).home, otherApi.base);
  await carol.sendText(alice.me.account, "Hej från en annan home");
  await until(async () => (await alice.messages(carol.me.account)).some((m) => m.text === "Hej från en annan home"));
  // A second device of a remote identity is linked with a rootcard proof, approved on the first device.
  const carol2 = await device(carolHandle, PW, "carol2", async (setup) => {
    const req = await waitFor(carol, "link");
    assert.equal(req.code, setup.code);
    await carol.approveLink(req.request);
  }, otherApi.base);
  await until(async () => (await carol2.messages(alice.me.account)).some((m) => m.text === "Hej från en annan home"));
});

test("homes that are not allowed are refused", async () => {
  await assert.rejects(api.connect("0".repeat(52), "https://evil.example/id"), (e) => e.status === 403 || e.status === 404);
});

test("the server keeps no delivered messages and no files", async () => {
  await new Promise((r) => setTimeout(r, 500));
  const db = new DatabaseSync(DB, { readOnly: true });
  const left = db.prepare("SELECT COUNT(*) AS n FROM mailbox").get().n;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name).sort();
  db.close();
  assert.equal(left, 0);
  const queued = db2count("relay_queue");
  assert.equal(queued, 0);
  assert.deepEqual(tables, ["changes", "device_lists", "identities", "mailbox", "prekeys", "push_subs", "relay_queue", "remote_ids", "settings", "sqlite_sequence"]);
});

function db2count(table) {
  const db = new DatabaseSync(DB, { readOnly: true });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  db.close();
  return n;
}
