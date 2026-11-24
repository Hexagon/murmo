// The bridge (DESIGN.md §16) against the real client engine: an owner logs in with a rootcard proof, makes a bot, and
// a program with the bot's API key talks with ordinary Murmo users over HTTP, both ways, with message requests,
// receipts, a new key and deleting the bot. One real server (target/debug/murmo-server) with MURMO_BRIDGE=1.
//
//   cargo build && npm test

import "fake-indexeddb/auto";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "../client/js/api.js";
import * as id from "../client/js/identity.js";
import { Messenger, Store, setupDevice } from "../client/js/core.js";
import * as rc from "../client/vendor/rootcard/src/index.js";

const PORT = 26000 + Math.floor(Math.random() * 1000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BRIDGE = `${ORIGIN}/bridge/api/v1`;
const dir = mkdtempSync(join(tmpdir(), "murmo-bridge-"));
const api = new Api(ORIGIN);
const running = [];
const PW = "correct horse battery staple";
let server, realms;

before(async () => {
  const bin = new URL("../target/debug/murmo-server", import.meta.url).pathname;
  assert.ok(existsSync(bin), "run `cargo build` first");
  server = spawn(bin, [], {
    env: {
      ...process.env, MURMO_ORIGIN: ORIGIN, MURMO_BIND: `127.0.0.1:${PORT}`, MURMO_DB: join(dir, "m.sqlite"),
      MURMO_HOST_KEY_FILE: join(dir, "m.key"), MURMO_CLIENT_DIR: "", MURMO_LIMIT_SCALE: "10", MURMO_REMOTE_HOMES: "",
      MURMO_BRIDGE: "1", MURMO_BRIDGE_BOTS: "2",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  for (let i = 0; i < 100; i++) {
    try {
      await api.rc("GET", "/host");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  realms = (await api.info()).realms;
});

after(() => {
  for (const m of running) m.stop();
  server?.kill();
});

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A call to the bridge's API: `{ status, body }`. */
async function call(method, path, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BRIDGE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function user(name) {
  const handle = (await (await id.prepareRegistration(api, name, PW)).finish()).handle;
  const login = await id.login(api, api.base, handle, PW);
  const secret = await id.localSecret(api, login);
  const store = await Store.open(login.state.account, name);
  await store.unlock(secret);
  const setup = await setupDevice({ api, store, state: login.state, login, label: name });
  assert.equal(setup.ready, true);
  login.unlocked.contents.accountSeed.fill(0);
  const m = new Messenger({ api, store, account: login.state.account, handle, home: api.base, realms });
  m.handle = handle;
  running.push(m);
  const online = new Promise((resolve) => m.addEventListener("status", (e) => e.detail === "online" && resolve()));
  await m.start();
  await online;
  return m;
}

/** Log in to the bridge as `handle`: a rootcard login at its home, then a proof for the bridge's challenge. */
async function ownerLogin(handle, recipient = `${ORIGIN}/bridge`) {
  const login = await id.login(api, api.base, handle, PW);
  const { body: c } = await call("POST", "/challenge", null, {});
  const proof = await rc.prove(login.state, "account", login.unlocked.contents.accountSeed, rc.base64urlDecode(c.nonce), recipient);
  login.unlocked.contents.accountSeed.fill(0);
  return call("POST", "/login", null, { account: login.state.account, home: api.base, nonce: c.nonce, proof });
}

let alice, bob, session, bot, key, secondBot;

test("an owner logs in with a rootcard proof and makes a bot", async () => {
  alice = await user("Alice");
  bob = await user("Bob");
  // A proof for another recipient (the main server's link requests) does not log in.
  assert.equal((await ownerLogin(alice.handle, ORIGIN)).status, 401);
  const r = await ownerLogin(alice.handle);
  assert.equal(r.status, 200);
  assert.equal(r.body.account, alice.me.account);
  session = r.body.token;
  assert.equal((await call("GET", "/bots", "mbs_wrong")).status, 401);
  const made = await call("POST", "/bots", session, { name: "Helper", retention_days: 7 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  bot = made.body.bot;
  key = made.body.api_key;
  assert.match(key, /^mbk_[A-Za-z0-9_-]{43}$/);
  assert.match(bot.handle, /^Helper#[0-9A-Z]{4}$/);
  assert.equal(bot.address, `${bot.handle}@127.0.0.1:${PORT}`);
  assert.match(made.body.card_text, /Helper/);
  assert.equal(bot.retention_days, 7);
  assert.equal((await call("POST", "/bots", session, { name: "Long", retention_days: 31 })).status, 400);
  // The bot is an ordinary account of this server: found by its handle, one device with a prekey.
  const found = await api.lookup(bot.handle);
  assert.equal(found.account, bot.account);
  const devs = await api.devices(bot.account);
  assert.equal(devs.entries.length, 1);
  assert.equal(devs.prekeys.length, 1);
  // The owner sees it, and nobody else can use its key as a session, or a session as its key.
  assert.equal((await call("GET", "/bots", session)).body.bots.length, 1);
  assert.equal((await call("GET", "/me", session)).status, 401);
  assert.equal((await call("GET", "/bots", key)).status, 401);
  const me = await call("GET", "/me", key);
  assert.equal(me.body.account, bot.account);
});

test("a user writes to the bot: a request the program accepts, then texts both ways", async () => {
  await alice.request(bot.handle, "Hej bot");
  const req = await until(async () => {
    const r = await call("GET", "/messages?wait=2", key);
    return r.body.events.find((e) => e.type === "request");
  });
  assert.equal(req.from.account, alice.me.account);
  assert.equal(req.from.handle, alice.handle);
  assert.equal(req.note, "Hej bot");
  assert.equal(req.accepted, false);
  // Not accepted yet: the bot cannot write texts to Alice, and Alice's texts are not taken.
  const contacts = await call("GET", "/contacts", key);
  assert.deepEqual(contacts.body.contacts.map((c) => [c.account, c.state]), [[alice.me.account, "incoming"]]);
  const acc = await call("POST", `/contacts/${alice.me.account}/accept`, key);
  assert.equal(acc.body.state, "accepted");
  await until(() => alice.contacts.get(bot.account)?.state === "accepted");

  const sent = await alice.sendText(bot.account, "Vad är klockan?");
  // Events are read until confirmed: `after` confirms, `next` says how far.
  const first = await until(async () => {
    const r = await call("GET", `/messages?after=${req.seq}&wait=5`, key);
    return r.body.events.some((e) => e.type === "message") && r.body;
  });
  const msg = first.events.find((e) => e.type === "message");
  assert.equal(msg.text, "Vad är klockan?");
  assert.equal(msg.from.account, alice.me.account);
  assert.equal(msg.id, sent.id ?? msg.id);
  const again = await call("GET", `/messages?after=${req.seq}`, key);
  assert.ok(again.body.events.some((e) => e.seq === msg.seq), "not confirmed yet: still there");
  const after = await call("GET", `/messages?after=${first.next}`, key);
  assert.deepEqual(after.body.events, []);
  assert.equal(after.body.next, first.next);
  // The bot's device sent a receipt: Alice's text is marked delivered.
  await until(async () => (await alice.messages(bot.account)).find((m) => m.text === "Vad är klockan?")?.delivered > 0);

  // The program answers, by handle.
  const reply = await call("POST", "/messages", key, { to: alice.handle, text: "Den är **mycket**." });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.kind, "text");
  assert.equal(reply.body.queued, 1);
  assert.deepEqual(reply.body.failed, []);
  const got = await until(async () => (await alice.messages(bot.account)).find((m) => m.text === "Den är **mycket**."));
  assert.equal(got.dir, "in");
  assert.equal(got.id, reply.body.id);
  // Alice's receipt comes back to the program.
  const delivered = await until(async () => {
    const r = await call("GET", `/messages?after=${first.next}&wait=2`, key);
    return r.body.events.find((e) => e.type === "delivered" && e.ids.includes(reply.body.id));
  });
  assert.equal(delivered.from.account, alice.me.account);
  await call("GET", `/messages?after=${delivered.seq}`, key);
});

test("the bot writes to someone new: a message request with the text as note", async () => {
  const r = await call("POST", "/messages", key, { to: bob.me.account, text: "Hej Bob, jag är en bot." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.kind, "request");
  assert.equal(r.body.state, "outgoing");
  await until(() => bob.contacts.get(bot.account)?.state === "incoming");
  assert.equal(bob.contacts.get(bot.account).note, "Hej Bob, jag är en bot.");
  // Until Bob accepts, the bot can only wait.
  assert.equal((await call("POST", "/messages", key, { to: bob.me.account, text: "Hallå?" })).status, 409);
  await bob.accept(bot.account);
  const ev = await until(async () => {
    const x = await call("GET", "/messages?wait=2", key);
    return x.body.events.find((e) => e.type === "accepted" && e.from.account === bob.me.account);
  });
  await call("GET", `/messages?after=${ev.seq}`, key);
  const t = await call("POST", "/messages", key, { to: bob.handle, text: "Tack!" });
  assert.equal(t.body.kind, "text");
  await until(async () => (await bob.messages(bot.account)).some((m) => m.text === "Tack!" && m.dir === "in"));
});

test("bad input and unknown recipients are refused", async () => {
  assert.equal((await call("POST", "/messages", key, { to: "Nobody#ZZZZ", text: "x" })).status, 404);
  assert.equal((await call("POST", "/messages", key, { to: alice.handle, text: "  " })).status, 400);
  assert.equal((await call("POST", "/messages", key, { to: alice.handle, text: "x".repeat(8001) })).status, 400);
  assert.equal((await call("POST", "/messages", key, { to: bot.account, text: "me" })).status, 400);
  assert.equal((await call("GET", "/messages?after=x", key)).status, 400);
  assert.equal((await call("POST", "/messages", "mbk_" + "A".repeat(43), { to: alice.handle, text: "x" })).status, 401);
});

test("blocking drops what the contact sends", async () => {
  await call("POST", `/contacts/${bob.me.account}/block`, key);
  await bob.sendText(bot.account, "Är du där?");
  await new Promise((r) => setTimeout(r, 500));
  const r = await call("GET", "/messages?wait=1", key);
  assert.ok(!r.body.events.some((e) => e.type === "message" && e.from.account === bob.me.account));
});

test("the owner makes a new key, limits bots, and deletes the bot", async () => {
  const old = key;
  const k = await call("POST", `/bots/${bot.account}/key`, session);
  assert.equal(k.status, 200);
  key = k.body.api_key;
  assert.notEqual(key, old);
  assert.equal((await call("GET", "/me", old)).status, 401);
  assert.equal((await call("GET", "/me", key)).status, 200);
  // Another owner sees none of it.
  const other = (await ownerLogin(bob.handle)).body.token;
  assert.deepEqual((await call("GET", "/bots", other)).body.bots, []);
  assert.equal((await call("POST", `/bots/${bot.account}/key`, other)).status, 404);
  assert.equal((await call("DELETE", `/bots/${bot.account}`, other)).status, 404);
  // A bot cannot log in as an owner, and an owner has at most MURMO_BRIDGE_BOTS bots.
  assert.equal((await call("POST", "/bots", session, { name: "bad name!" })).status, 400);
  const second = await call("POST", "/bots", session, { name: "Second" });
  assert.equal(second.status, 201);
  secondBot = second.body;
  assert.equal((await call("POST", "/bots", session, { name: "Third" })).status, 409);

  const del = await call("DELETE", `/bots/${bot.account}`, session);
  assert.equal(del.status, 200);
  assert.equal((await call("GET", "/me", key)).status, 401);
  // Contacts see an account without devices: nothing more is queued for it.
  const devs = await api.devices(bot.account);
  assert.equal(devs.entries.length, 2);
  assert.equal(devs.prekeys.length, 0);
  assert.equal((await alice.list(bot.account, true)).list.present.length, 0);
});

test("a bot with retention 0 (the default) keeps nothing it has handed out", async () => {
  const b = secondBot.bot;
  const k = secondBot.api_key;
  assert.equal(b.retention_days, 0);
  await alice.request(b.handle, "Hej igen");
  const got = await until(async () => {
    const r = await call("GET", "/messages?wait=2", k);
    return r.body.events.find((e) => e.type === "request");
  });
  assert.equal(got.note, "Hej igen");
  assert.ok(Number.isSafeInteger(got.received));
  // Handed out once: the same call again, without confirming anything, finds nothing.
  assert.deepEqual((await call("GET", "/messages", k)).body.events, []);
  // The owner can change it; out of range is refused.
  const ch = await call("POST", `/bots/${b.account}`, session, { retention_days: 3 });
  assert.equal(ch.body.bot.retention_days, 3);
  assert.equal((await call("POST", `/bots/${b.account}`, session, { retention_days: -1 })).status, 400);
  assert.equal((await call("POST", `/bots/${b.account}`, session, {})).status, 400);
});

test("a bot for its owner only takes nobody else", async () => {
  const made = await call("POST", "/bots", session, { name: "Private", owner_only: true });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const p = made.body.bot;
  const k = made.body.api_key;
  assert.equal(p.owner_only, true);
  // Bob writes first: nothing reaches the program, and the bot cannot write to him.
  await bob.request(p.handle, "Släpp in mig");
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual((await call("GET", "/messages?wait=1", k)).body.events, []);
  assert.equal((await call("POST", "/messages", k, { to: bob.handle, text: "Hej" })).status, 403);
  assert.equal((await call("POST", `/contacts/${bob.me.account}/accept`, k)).status, 403);
  // The owner's request is accepted at once.
  await alice.request(p.handle, "Det är jag");
  const ev = await until(async () => (await call("GET", "/messages?wait=2", k)).body.events.find((e) => e.type === "request"));
  assert.equal(ev.from.account, alice.me.account);
  assert.equal(ev.accepted, true);
  await until(() => alice.contacts.get(p.account)?.state === "accepted");
  assert.equal((await call("POST", "/messages", k, { to: alice.handle, text: "Bara för dig" })).body.kind, "text");
  await until(async () => (await alice.messages(p.account)).some((m) => m.text === "Bara för dig"));
  assert.equal(bob.contacts.get(p.account)?.state, "outgoing");
  // It can be turned off again.
  assert.equal((await call("POST", `/bots/${p.account}`, session, { owner_only: false })).body.bot.owner_only, false);
});

test("logging out ends the session", async () => {
  assert.equal((await call("POST", "/logout", session)).status, 200);
  assert.equal((await call("GET", "/bots", session)).status, 401);
});
