// End to end: the real server (target/debug/murmo-server) and the real client engine (client/js/core.js) in Node 22,
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
const dir = mkdtempSync(join(tmpdir(), "murmo-e2e-"));
const DB = join(dir, "murmo.sqlite"); // the murmo server's database
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
  const bin = new URL("../target/debug/murmo-server", import.meta.url).pathname;
  assert.ok(existsSync(bin), "run `cargo build` first");
  return spawn(bin, [], {
    env: {
      ...process.env, MURMO_ORIGIN: origin, MURMO_BIND: `127.0.0.1:${port}`, MURMO_DB: join(dir, `${name}.sqlite`),
      MURMO_HOST_KEY_FILE: join(dir, `${name}.key`), MURMO_CLIENT_DIR: "", MURMO_LIMIT_SCALE: "10", ...extra,
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
  server = start(ORIGIN, PORT, "murmo", { MURMO_REMOTE_HOMES: OTHER, MURMO_PUSH_HOSTS: `http://127.0.0.1:${PUSH_PORT}` });
  other = start(OTHER, PORT + 1000, "other", { MURMO_REMOTE_HOMES: "" });
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

test("retention: old messages are deleted on all own devices, new ones kept", async () => {
  const conv = bob.me.account;
  const old = Math.floor(Date.now() / 1000) - 3 * 86400;
  for (const dev of [alice, alice2]) await dev.store.putMessage({ id: `old-${dev.me.device}`, conv, dir: "in", time: old, kind: "text", text: "gammalt" });
  assert.ok((await alice2.messages(conv)).some((m) => m.text === "gammalt"));
  await alice.setRetention(conv, 86400);
  assert.ok(!(await alice.messages(conv)).some((m) => m.text === "gammalt"));
  // The setting reaches the other device, which prunes too; recent messages stay.
  await until(async () => alice2.contacts.get(conv)?.retention === 86400);
  await until(async () => !(await alice2.messages(conv)).some((m) => m.text === "gammalt"));
  assert.ok((await alice2.messages(conv)).some((m) => m.text === "Från laptopen"));
  // A message older than the retention is not stored at all.
  await alice.record({ id: "too-old", conv, dir: "in", time: old, kind: "text", text: "för gammalt" });
  assert.ok(!(await alice.store.hasMessage("too-old")));
  await alice.setRetention(conv, 0);
  await until(async () => alice2.contacts.get(conv)?.retention === 0);
});

test("reactions: one per person, the latest wins, on all devices of both", async () => {
  const conv = bob.me.account;
  const target = (await alice.messages(conv)).find((m) => m.text === "Från laptopen");
  await bob.react(alice.me.account, target.id, "👍");
  await until(async () => (await alice.store.message(target.id)).reactions?.[bob.me.account]?.e === "👍");
  await until(async () => (await alice2.store.message(target.id)).reactions?.[bob.me.account]?.e === "👍");
  // Alice's own reaction reaches her other device and Bob; changing it replaces it.
  await alice.react(conv, target.id, "❤️");
  await alice.react(conv, target.id, "😂");
  for (const [dev, id] of [[bob, target.id], [alice2, target.id]]) {
    await until(async () => (await dev.store.message(id)).reactions?.[alice.me.account]?.e === "😂");
  }
  // Taken back: kept as "" so that an older reaction arriving late does not come back.
  await bob.react(alice.me.account, target.id, "");
  await until(async () => (await alice.store.message(target.id)).reactions?.[bob.me.account]?.e === "");
  await alice.applyReaction(conv, target.id, bob.me.account, "👍", 1);
  assert.equal((await alice.store.message(target.id)).reactions[bob.me.account].e, "");
  // Only an emoji, only to a message of that conversation, only from accepted contacts.
  await assert.rejects(alice.react(conv, target.id, "<b>hej</b>"), (x) => x.code === "bad_reaction");
  await assert.rejects(alice.react(conv, "nope", "👍"), (x) => x.code === "no_message");
  await bob.deliver(await bob.peerTargets(alice.me.account), "reaction", alice.me.account, { id: target.id, e: "text" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await alice.store.message(target.id)).reactions[bob.me.account].e, "");
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
  alice2 = a2; // Alice's second device from here on

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

test("the GIF collection: only real GIFs, encrypted locally, sent as an ordinary file", async () => {
  const gif = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64")); // 1 × 1
  assert.equal(await alice.saveGif(new Blob([gif], { type: "image/gif" })), "saved");
  assert.equal(await alice.saveGif(new Blob([gif])), "exists"); // by content, whatever the type says
  await assert.rejects(alice.saveGif(new Blob([noise(100)], { type: "image/gif" })), (x) => x.code === "not_gif");
  const huge = Uint8Array.from(gif);
  huge.set([0x50, 0xc3, 0x50, 0xc3], 6); // 50000 × 50000 in the header
  await assert.rejects(alice.saveGif(new Blob([huge])), (x) => x.code === "too_big_image");
  const [g, ...rest] = await alice.gifs();
  assert.equal(rest.length, 0);
  assert.deepEqual([g.width, g.height, g.size], [1, 1, gif.length]);
  // Stored under its own file id, encrypted: the bytes are not in the database in the clear.
  assert.deepEqual(new Uint8Array(await (await alice.gifBlob(g.id)).arrayBuffer()), gif);

  const bobGot = waitFor(bob, "file");
  await alice.sendGif(bob.me.account, g.id);
  const { f } = await bobGot;
  const m = (await bob.messages(alice.me.account)).find((x) => x.file?.f === f);
  assert.equal(m.file.name, "animation.gif");
  assert.equal(m.file.mime, "image/gif");
  assert.deepEqual(await bob.store.file(f), gif);

  // The collection is the same on Alice's other device: the entry comes as a message, the bytes over the relay.
  await until(async () => (await alice2.gifs()).some((x) => x.id === g.id) && (await alice2.gifBlob(g.id)));
  assert.deepEqual(new Uint8Array(await (await alice2.gifBlob(g.id)).arrayBuffer()), gif);
  // A bad entry from an own device is ignored; Bob cannot add to Alice's collection at all.
  await alice.deliver(await alice.ownTargets(), "gifs", alice.me.account, { add: [{ ...g, id: "x", size: 1e9 }] });
  await bob.deliver(await bob.peerTargets(alice.me.account), "gifs", alice.me.account, { add: [{ ...g, id: "B".repeat(22), sha256: "other" }] });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await alice2.gifs()).length, 1);
  assert.equal((await alice.gifs()).length, 1);

  await alice2.removeGif(g.id);
  await until(async () => (await alice.gifs()).length === 0);
  assert.equal(await alice.gifBlob(g.id), null);
});

test("a GIF saved while another own device is away reaches it later", async () => {
  alice2.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  const gif = Uint8Array.from(Buffer.from("R0lGODlhAgACAIAAAP///wAAACH5BAEAAAAALAAAAAACAAIAAAIChFEAOw==", "base64")); // 2 × 2
  alice.fileQueue = () => false; // nothing kept on the server: the device asks for the bytes itself
  assert.equal(await alice.saveGif(new Blob([gif])), "saved");
  alice.fileQueue = () => true;
  const [g] = await alice.gifs();
  const back = waitFor(alice2, "status", (s) => s === "online");
  await alice2.start();
  await back;
  await until(async () => (await alice2.gifBlob(g.id)) !== null, 20000);
  assert.deepEqual(new Uint8Array(await (await alice2.gifBlob(g.id)).arrayBuffer()), gif);
  await alice.removeGif(g.id);
});

test("chunks are stored as they come: before the file message, out of order, within a budget per sender", async () => {
  const conv = alice.me.account;
  const from = { account: alice.me.account, from: alice.me.device };
  const data = noise(3 * p.CHUNK + 1000);
  const f = p.b64(p.random(16));
  const key = await p.newFileKey();
  const n = 4;
  const meta = { f, name: "x.bin", mime: "application/octet-stream", size: data.length, sha256: p.b64(await p.sha256(data)), key: p.b64(key), n };
  const chunk = (i) => p.encryptChunk(key, f, i, n, data.subarray(i * p.CHUNK, (i + 1) * p.CHUNK));
  const relay = async (bytes) => bob.serial(() => bob.onRelay({ ...from, data: bytes }));

  // Two chunks before the file message wait in IndexedDB, not in memory.
  await relay(await chunk(3));
  await relay(await chunk(1));
  assert.deepEqual([...bob.files.get(f).early.keys()], [3, 1]);
  assert.ok(await bob.store.incoming(f, 3));
  await bob.serial(() => bob.expectFile(meta, { id: "none", conv }));
  const t = bob.files.get(f);
  assert.deepEqual([...t.have].sort(), [1, 3]);
  assert.equal(await bob.store.incoming(f, 3), undefined);
  assert.equal(t.next, 0); // nothing hashed until part 0 is here
  // A chunk that does not decrypt is dropped; the right one still counts.
  const bad = p.unpack(await chunk(0));
  bad.c = p.b64(p.random(100));
  await relay(p.pack(bad));
  assert.ok(!t.have.has(0));
  const got = waitFor(bob, "file", (d) => d.f === f);
  await relay(await chunk(0));
  assert.equal(t.next, 2);
  await relay(await chunk(2));
  await got;
  assert.ok(await bob.store.hasFile(f));
  assert.deepEqual(await bob.store.file(f), data);
  assert.equal(bob.files.has(f), false);

  // A file whose hash does not match is deleted, parts included.
  const f2 = p.b64(p.random(16));
  const k2 = await p.newFileKey();
  await bob.serial(() => bob.expectFile({ ...meta, f: f2, key: p.b64(k2), n: 1, size: 10, sha256: p.b64(p.random(32)) }, { id: "none", conv }));
  await relay(await p.encryptChunk(k2, f2, 0, 1, p.random(10)));
  assert.equal(await bob.store.hasFile(f2), false);
  assert.equal(await bob.store.part(f2, 0), undefined);

  // Chunks without a file message: at most 16 MiB from one account, then they are refused (and not acknowledged).
  const f3 = p.b64(p.random(16));
  const big = (i) => p.pack({ k: "chunk", f: f3, i, n: 4096, c: p.b64(noise(p.CHUNK + 16)) });
  for (let i = 0; i < 360; i++) await relay(big(i));
  const t3 = bob.files.get(f3);
  assert.ok(t3.early.size < 360 && t3.earlyBytes <= 16 * 1024 * 1024, `${t3.early.size} chunks kept`);
  // Forgotten after a while, from IndexedDB too.
  t3.updated = 0;
  bob.sweepFiles();
  assert.equal(bob.files.has(f3), false);
  await until(async () => (await bob.store.incoming(f3, 0)) === undefined);

  // Files stored by an earlier version (one record) are still read.
  const old = noise(70_000);
  const k = await bob.store.tag("file", "old-file");
  const v = await p.encryptLocal(bob.store.key, old, `file:${k}`);
  const tx = bob.store.db.transaction("files", "readwrite");
  tx.objectStore("files").put({ k, v });
  await new Promise((r) => (tx.oncomplete = r));
  assert.deepEqual(await bob.store.file("old-file"), old);
  assert.deepEqual(await bob.store.fileHead("old-file", 10), old.subarray(0, 10));
  const read = await bob.store.fileReader("old-file");
  assert.equal(read.n, 2);
  assert.deepEqual(await read(1), old.subarray(p.CHUNK));
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
  // Carol's identity lives at the other home; she never registers at the murmo server.
  const carolHandle = await register("Carol", PW, otherApi);
  // Before she connects, the murmo server does not know her: no lookup by identifier.
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
  assert.deepEqual(tables, ["changes", "device_lists", "identities", "mailbox", "prekeys", "push_subs", "rate_limits", "relay_queue", "remote_ids", "settings", "sqlite_sequence"]);
});

function db2count(table) {
  const db = new DatabaseSync(DB, { readOnly: true });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  db.close();
  return n;
}
