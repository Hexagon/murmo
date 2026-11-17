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
import { EPHEMERAL_TTLS, EPHEMERAL_WAIT, Messenger, Store, setupDevice } from "../client/js/core.js";
import { PART_BATCH } from "../client/js/store.js";
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

test("a text is stored before it is sent; a send that failed part way keeps it, one that failed at once does not", async () => {
  const real = alice.ws.sendEnvelopes;
  try {
    // Nothing went out: the record goes again, and the error reaches the caller (the text returns to the composer).
    alice.ws.sendEnvelopes = async () => {
      throw new Error("rate_limited");
    };
    await assert.rejects(alice.sendText(bob.me.account, "gick inte iväg", "unsent-none"), (e) => !e.partial);
    assert.equal(await alice.store.message("unsent-none"), undefined);
    // Some devices got it before the rest failed: it stays, marked unsent, and is not sent again under a new id.
    let seen;
    alice.ws.sendEnvelopes = async () => {
      seen = await alice.store.message("unsent-part");
      throw Object.assign(new Error("rate_limited"), { partial: true });
    };
    await assert.rejects(alice.sendText(bob.me.account, "halvvägs", "unsent-part"), (e) => e.partial === true);
    assert.equal(seen?.unsent, true, "stored before it was sent");
    const kept = await alice.store.message("unsent-part");
    assert.equal(kept.text, "halvvägs");
    assert.equal(kept.unsent, true);
  } finally {
    alice.ws.sendEnvelopes = real;
  }
  // A send that goes through leaves no mark.
  await alice.sendText(bob.me.account, "gick fram", "sent-ok");
  const ok = await alice.store.message("sent-ok");
  assert.equal(ok.text, "gick fram");
  assert.equal(ok.unsent, undefined);
  await until(async () => (await bob.messages(alice.me.account)).some((m) => m.text === "gick fram"));
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

test("device nicknames: own devices share them, last writer wins, and a contact cannot set one", async () => {
  // A nickname set on one device reaches the other, trimmed; an empty one clears it again.
  await alice.setDeviceName(alice2.me.device, "  Laptopen  ");
  await until(async () => (await alice2.names())[alice2.me.device]?.name === "Laptopen");
  assert.equal((await alice.names())[alice2.me.device].name, "Laptopen");
  await alice.setDeviceName(alice2.me.device, "");
  await until(async () => (await alice2.names())[alice2.me.device]?.name === "");
  // Last writer wins by time; an older change and a tie are ignored.
  const t = Date.now() + 1_000_000;
  await alice.mergeNames({ set: { [alice2.me.device]: { name: "Först", time: t } } });
  await alice.mergeNames({ set: { [alice2.me.device]: { name: "Äldre", time: t - 100 } } });
  await alice.mergeNames({ set: { [alice2.me.device]: { name: "Samma", time: t } } });
  assert.equal((await alice.names())[alice2.me.device].name, "Först");
  await alice.mergeNames({ set: { [alice2.me.device]: { name: "Senare", time: t + 100 } } });
  assert.equal((await alice.names())[alice2.me.device].name, "Senare");
  // A device that is not in the list, and a name with a control character, are refused.
  await assert.rejects(alice.setDeviceName("x".repeat(22), "Nope"), (x) => x.code === "bad_device");
  await assert.rejects(alice.setDeviceName(alice2.me.device, "\u0007"), (x) => x.code === "bad_name");
  // Bob cannot set a nickname on one of Alice's devices: only an own device is taken.
  await bob.deliver(await bob.peerTargets(alice.me.account), "names", alice.me.account, { set: { [alice.me.device]: { name: "hackad", time: Date.now() + 1_000_000 } } });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await alice.names())[alice.me.device], undefined);
});

test("a newly linked device receives the nicknames after the history hand-over", async () => {
  const ninaHandle = await register("Nina", PW);
  const nina1 = await device(ninaHandle, PW, "nina1");
  await nina1.setDeviceName(nina1.me.device, "Skrivbordet");
  assert.equal((await nina1.names())[nina1.me.device].name, "Skrivbordet");
  const nina2 = await device(ninaHandle, PW, "nina2", async (setup) => {
    const req = await waitFor(nina1, "link");
    assert.equal(req.code, setup.code); // both screens show the same code
    await nina1.approveLink(req.request);
  });
  await until(async () => (await nina2.names())[nina1.me.device]?.name === "Skrivbordet");
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

test("taking a message back: only the author's own, within the window, everywhere; late copies stay away", async () => {
  const conv = alice.me.account;
  const find = async (dev, c, text) => (await dev.messages(c)).find((m) => m.text === text);
  bob.lists.clear();
  await bob.sendText(conv, "Fel mottagare");
  for (const dev of [alice, alice2]) await until(() => find(dev, bob.me.account, "Fel mottagare"));
  const sent = await find(bob, conv, "Fel mottagare");
  await alice.react(bob.me.account, sent.id, "👍");
  await until(async () => (await bob.store.message(sent.id)).reactions?.[alice.me.account]);

  // The other party cannot take back Bob's message, neither through the API nor with a forged retract.
  await assert.rejects(alice.retract(bob.me.account, sent.id), (x) => x.code === "no_message");
  await alice.deliver(await alice.peerTargets(bob.me.account), "retract", bob.me.account, { id: sent.id });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await bob.store.message(sent.id)).text, "Fel mottagare");

  // Bob takes it back: a placeholder on all devices of both, text and reactions gone.
  await bob.retract(conv, sent.id);
  for (const [dev, c] of [[bob, conv], [alice, bob.me.account], [alice2, bob.me.account]]) {
    await until(async () => (await dev.store.message(sent.id))?.kind === "retracted");
    const m = await dev.store.message(sent.id);
    assert.equal(m.text, undefined);
    assert.equal(m.reactions, undefined);
    assert.equal(m.by, bob.me.account);
    assert.ok((await dev.messages(c)).some((x) => x.id === sent.id && x.kind === "retracted"));
  }
  // A late copy (a history hand-over) does not bring it back, and it cannot be reacted to.
  await alice.mergeHistory({ messages: [{ ...sent, dir: "in", conv: bob.me.account }] });
  assert.equal((await alice.store.message(sent.id)).kind, "retracted");
  await assert.rejects(alice.react(bob.me.account, sent.id, "👍"), (x) => x.code === "no_message");

  // A retract that comes before its message is kept out of sight, and hides the message when it comes.
  const now = Math.floor(Date.now() / 1000);
  await alice.applyRetract(bob.me.account, "early-1", bob.me.account, now);
  assert.ok(!(await alice.messages(bob.me.account)).some((m) => m.id === "early-1"));
  await alice.mergeHistory({ messages: [{ id: "early-1", conv: bob.me.account, dir: "in", time: now - 10, kind: "text", text: "kom sent" }] });
  assert.equal((await alice.store.message("early-1")).kind, "retracted");
  assert.ok((await alice.messages(bob.me.account)).some((m) => m.id === "early-1" && m.kind === "retracted"));
  // ...but not when it was not the author's: a retract from Bob for an id of Alice's is dropped.
  await alice.applyRetract(bob.me.account, "early-2", bob.me.account, now);
  await alice.mergeHistory({ messages: [{ id: "early-2", conv: bob.me.account, dir: "out", time: now - 10, kind: "text", text: "mitt eget" }] });
  assert.equal((await alice.store.message("early-2")).text, "mitt eget");

  // Only within the window: an older message can no longer be taken back from everyone; a stale retract is ignored.
  const old = { id: "old-own", conv: bob.me.account, dir: "out", time: now - 2 * 86400, at: Date.now(), kind: "text", text: "i förrgår" };
  await alice.store.putMessage(old);
  await assert.rejects(alice.retract(bob.me.account, old.id), (x) => x.code === "too_late");
  await alice.applyRetract(bob.me.account, old.id, alice.me.account, now);
  assert.equal((await alice.store.message(old.id)).text, "i förrgår");

  // "Delete for me": gone on Alice's devices, Bob keeps his copy.
  alice.lists.clear();
  await alice.sendText(bob.me.account, "Bara för mig");
  await until(() => find(bob, conv, "Bara för mig"));
  await until(() => find(alice2, bob.me.account, "Bara för mig"));
  const mine = await find(alice, bob.me.account, "Bara för mig");
  await alice.deleteForMe(bob.me.account, mine.id);
  assert.ok(!(await find(alice, bob.me.account, "Bara för mig")));
  await until(async () => !(await find(alice2, bob.me.account, "Bara för mig")));
  assert.ok(await find(bob, conv, "Bara för mig"));

  // A file taken back is deleted with its content on the other side.
  const bobGot = waitFor(bob, "file");
  await alice.sendFile(bob.me.account, new File([noise(20_000)], "fel.png", { type: "image/png" }));
  const { f } = await bobGot;
  assert.ok(await bob.store.hasFile(f));
  const fm = (await alice.messages(bob.me.account)).find((m) => m.file?.f === f);
  await alice.retract(bob.me.account, fm.id);
  assert.ok(!(await alice.store.hasFile(f)));
  await until(async () => (await bob.store.message(fm.id))?.kind === "retracted");
  assert.ok(!(await bob.store.hasFile(f)));
});

test("editing: only the author's own text, within the window, the latest edit wins, marked on all devices", async () => {
  const conv = alice.me.account;
  bob.lists.clear();
  // A text can be sent under an id chosen beforehand (the interface shows it under that id while it waits).
  const { id } = await bob.sendText(conv, "Vi ses kl 18", "chosen-id-1");
  assert.equal(id, "chosen-id-1");
  for (const dev of [alice, alice2]) await until(async () => (await dev.store.message(id))?.text === "Vi ses kl 18");

  await bob.edit(conv, id, "Vi ses kl 19");
  for (const dev of [bob, alice, alice2]) {
    await until(async () => (await dev.store.message(id))?.text === "Vi ses kl 19");
    assert.ok((await dev.store.message(id)).edited > 0);
  }
  // An older edit that arrives late does not win; a newer one does.
  const m = await alice.store.message(id);
  await alice.applyEdit(bob.me.account, id, bob.me.account, "Vi ses kl 17", m.edited - 1, "older");
  assert.equal((await alice.store.message(id)).text, "Vi ses kl 19");
  await alice.applyEdit(bob.me.account, id, bob.me.account, "Vi ses kl 20", m.edited + 1, "newer");
  assert.equal((await alice.store.message(id)).text, "Vi ses kl 20");

  // Only the author: not through the API, not with a forged edit.
  await assert.rejects(alice.edit(bob.me.account, id, "Hackat"), (x) => x.code === "no_message");
  await alice.deliver(await alice.peerTargets(bob.me.account), "edit", bob.me.account, { id, text: "Hackat" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await bob.store.message(id)).text, "Vi ses kl 19");
  // Not empty (deleting is the way for that), not after the window, not a message that was taken back.
  await assert.rejects(bob.edit(conv, id, "   "), (x) => x.code === "empty_text");
  const now = Math.floor(Date.now() / 1000);
  await bob.store.putMessage({ id: "old-edit", conv, dir: "out", time: now - 2 * 86400, at: Date.now(), kind: "text", text: "gammalt" });
  await assert.rejects(bob.edit(conv, "old-edit", "nytt"), (x) => x.code === "too_late");
  await bob.retract(conv, id);
  await until(async () => (await alice.store.message(id))?.kind === "retracted");
  await alice.applyEdit(bob.me.account, id, bob.me.account, "tillbaka?", now + 5, "late");
  assert.equal((await alice.store.message(id)).kind, "retracted");
  assert.equal((await alice.store.message(id)).text, undefined);
});

test("the server advertises the file queue's limits", () => {
  const MiB = 1024 * 1024;
  assert.equal(info.file_queue, true);
  // The defaults: 150 MiB per device, 50 MiB per sender and device, 300 MiB per sender; one file at most the smallest.
  assert.deepEqual({ ...info.file_queue_limits }, { file: 50 * MiB, device: 150 * MiB, sender: 50 * MiB, account: 300 * MiB });
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
  // Unless it is larger than the server's queue takes: then the server is not even asked, and the file waits.
  alice.queueLimit = () => p.queuedBytes(10_000);
  const big = await alice.sendFile(bob.me.account, new File([noise(20_000)], "stor.bin"));
  assert.deepEqual(big, { live: 0, queued: 0, waiting: 1, tooBig: true });
  alice.queueLimit = () => info.file_queue_limits.file;
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

test("files view: the list of files, and a file removed from one device stays away until asked for", async () => {
  const data = noise(90_000);
  const bobGot = waitFor(bob, "file");
  const a2Got = waitFor(alice2, "file");
  await alice.sendFile(bob.me.account, new File([data], "rapport.pdf", { type: "application/pdf" }));
  const { f } = await bobGot;
  await a2Got;

  // The list: files of every conversation, newest first, not texts, the same on the sending and the other own device.
  const listed = await alice2.fileList();
  assert.equal(listed[0].m.file.f, f);
  assert.equal(listed[0].conv, bob.me.account);
  assert.ok(listed.every((x) => x.m.kind === "file"));
  assert.equal((await alice2.fileList(bob.me.account)).length, listed.length);

  // Removed on Alice's second device only: the message stays, marked, and nothing reaches Bob or Alice's first device.
  const before = (await alice2.messages(bob.me.account)).find((m) => m.file?.f === f);
  assert.equal(await alice2.freeFiles([{ conv: bob.me.account, id: before.id }]), data.length);
  const after = (await alice2.messages(bob.me.account)).find((m) => m.id === before.id);
  assert.equal(after.file.have, false);
  assert.equal(typeof after.file.freed, "number");
  assert.equal(await alice2.store.hasFile(f), false);
  assert.deepEqual(await alice.store.file(f), data);
  assert.deepEqual(await bob.store.file(f), data);

  // Chunks that come unasked (a retry from the sending device) are refused.
  const sent = (await alice.messages(bob.me.account)).find((m) => m.file?.f === f);
  await alice.streamFile(sent.file, await alice.store.fileReader(f), [alice2.me.device]);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await alice2.store.hasFile(f), false);

  // Asked for again: it comes from the own device that has it, and the mark is gone.
  const back = waitFor(alice2, "file", (d) => d.f === f);
  assert.equal(await alice2.fetchFromOwnDevices(bob.me.account, f), 1);
  await back;
  assert.deepEqual(await alice2.store.file(f), data);
  const again = (await alice2.messages(bob.me.account)).find((m) => m.id === before.id);
  assert.equal(again.file.have, true);
  assert.equal(again.file.freed, undefined);
  assert.equal(alice2.freed.has(f), false);
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
  // The device list shows when the other device was last connected; only the account's own devices are reported.
  const seen = await alice.ownSeen();
  assert.equal(seen[alice.me.device], 0);
  assert.ok(Math.abs(seen[alice2.me.device] - Date.now() / 1000) < 10);
  assert.equal(Object.keys(await bob.ownSeen()).includes(alice.me.device), false);
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

  // Parts are written and read in blocks of PART_BATCH: a file over several blocks comes back whole, and a part
  // that is missing reads as missing without moving the parts after it.
  const many = noise(2 * PART_BATCH * p.CHUNK + 5000);
  await bob.store.putFile("many-parts", many);
  assert.deepEqual(await bob.store.file("many-parts"), many);
  const pk = `${await bob.store.tag("file", "many-parts")}:${String(PART_BATCH + 3).padStart(4, "0")}`;
  const del = bob.store.db.transaction("parts", "readwrite");
  del.objectStore("parts").delete(pk);
  await new Promise((r) => (del.oncomplete = r));
  const r2 = await bob.store.fileReader("many-parts");
  assert.equal(r2.n, 2 * PART_BATCH + 1);
  assert.equal(await r2(PART_BATCH + 3), undefined);
  assert.deepEqual(await r2(PART_BATCH + 4), many.subarray((PART_BATCH + 4) * p.CHUNK, (PART_BATCH + 5) * p.CHUNK));
  assert.deepEqual(await r2(2 * PART_BATCH), many.subarray(2 * PART_BATCH * p.CHUNK));
  assert.equal(await r2(2 * PART_BATCH + 1), undefined);
  assert.equal(await bob.store.file("many-parts"), undefined);
});

test("large files: parts past 10 000, chunks of files over 100 MiB, saving part by part, a full disk", async () => {
  // Parts are stored by index past the four digits of earlier versions, and a block that crosses 10 000 reads whole.
  const parts = Array.from({ length: 64 }, (_, j) => p.utf8(`part ${9984 + j}`));
  await bob.store.putParts("past-ten-thousand", 9984, parts);
  await bob.store.finishFile("past-ten-thousand", 10_048, 0);
  const read = await bob.store.fileReader("past-ten-thousand");
  for (const i of [9984, 9999, 10_000, 10_015, 10_016, 10_047]) assert.deepEqual(await read(i), p.utf8(`part ${i}`), `${i}`);
  assert.equal(await read(9983), undefined);
  await bob.store.deleteFile("past-ten-thousand");
  assert.equal(await bob.store.part("past-ten-thousand", 10_000), undefined);

  // A chunk of a file with more parts than the old limit of 4096 is taken (it waits for its file message).
  const conv = alice.me.account;
  const from = { account: alice.me.account, from: alice.me.device };
  const relay = async (bytes) => bob.serial(() => bob.onRelay({ ...from, data: bytes }));
  const fBig = p.b64(p.random(16));
  await relay(p.pack({ k: "chunk", f: fBig, i: 9000, n: p.MAX_PARTS, c: p.b64(noise(100)) }));
  assert.deepEqual([...bob.files.get(fBig).early.keys()], [9000]);
  await relay(p.pack({ k: "chunk", f: fBig, i: 1, n: p.MAX_PARTS + 1, c: p.b64(noise(100)) }));
  assert.deepEqual([...bob.files.get(fBig).early.keys()], [9000]); // more parts than any file has: dropped
  await bob.dropTransfer(fBig, bob.files.get(fBig));

  // A stored file over several batches comes back whole as a Blob and when written to a stream part by part.
  const data = noise(300 * p.CHUNK + 123);
  await bob.store.putFile("to-save", data);
  const blob = await bob.fileBlob("to-save", "application/octet-stream");
  assert.equal(blob.size, data.length);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), data);
  const written = [];
  let closed = false;
  const steps = [];
  await bob.writeFile("to-save", new WritableStream({ write: (x) => written.push(x), close: () => (closed = true) }), (done, total) => steps.push([done, total]));
  assert.ok(closed);
  assert.deepEqual(new Uint8Array(await new Blob(written).arrayBuffer()), data);
  assert.deepEqual(steps.at(-1), [301, 301]);
  // A missing part aborts the stream instead of leaving a short file that looks complete.
  const pk = `${await bob.store.tag("file", "to-save")}:0150`;
  const del = bob.store.db.transaction("parts", "readwrite");
  del.objectStore("parts").delete(pk);
  await new Promise((r) => (del.oncomplete = r));
  let aborted = false;
  await assert.rejects(
    bob.writeFile("to-save", new WritableStream({ write() {}, abort: () => (aborted = true) })),
    (x) => x.code === "no_file",
  );
  assert.ok(aborted);
  assert.equal(await bob.fileBlob("to-save", "application/octet-stream"), null);
  await bob.store.deleteFile("to-save");

  // No room on the sending device: what was stored of the file is deleted at once, and it is said as such.
  const count = async (s) => {
    const r = bob.store.db.transaction(s).objectStore(s).count();
    return new Promise((ok) => (r.onsuccess = () => ok(r.result)));
  };
  const partsBefore = await count("parts");
  const put = bob.store.putParts;
  let calls = 0;
  bob.store.putParts = async (...a) => {
    if (++calls === 2) throw new DOMException("full", "QuotaExceededError");
    return put.apply(bob.store, a);
  };
  try {
    const file = new File([noise(3 * PART_BATCH * p.CHUNK)], "stor.bin");
    await assert.rejects(bob.sendFile(conv, file), (x) => x.code === "storage_full");
  } finally {
    bob.store.putParts = put;
  }
  assert.equal(await count("parts"), partsBefore);

  // No room on the receiving device: the transfer is let go, its parts too.
  const fFull = p.b64(p.random(16));
  const key = await p.newFileKey();
  const two = noise(p.CHUNK + 10);
  const meta = { f: fFull, name: "x.bin", mime: "application/octet-stream", size: two.length, sha256: p.b64(await p.sha256(two)), key: p.b64(key), n: 2 };
  await bob.serial(() => bob.expectFile(meta, { id: "none", conv }));
  await relay(await p.encryptChunk(key, fFull, 0, 2, two.subarray(0, p.CHUNK)));
  assert.ok(await bob.store.part(fFull, 0));
  const putPart = bob.store.putPart;
  bob.store.putPart = async () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  try {
    await assert.rejects(relay(await p.encryptChunk(key, fFull, 1, 2, two.subarray(p.CHUNK))), (x) => x.name === "QuotaExceededError");
  } finally {
    bob.store.putPart = putPart;
  }
  assert.equal(bob.files.has(fFull), false);
  assert.equal(await bob.store.part(fFull, 0), undefined);
  assert.equal(await bob.store.hasFile(fFull), false);
});

test("a large file waits for the recipient, who takes it on the device of their choice", async () => {
  const conv = bob.me.account;
  alice.askAbove = () => 100_000;
  const data = noise(300_000);
  let r;
  try {
    r = await alice.sendFile(conv, new File([data], "film.mp4", { type: "video/mp4" }));
  } finally {
    alice.askAbove = () => p.ASK_ABOVE;
  }
  assert.deepEqual(r, { live: 0, queued: 0, waiting: 0, ask: true });
  const sent = (await alice.messages(conv)).find((m) => m.file?.name === "film.mp4");
  assert.equal(sent.file.ask, true);
  assert.deepEqual(sent.file.missed, []); // not offered again by itself either
  assert.equal(Messenger.undelivered(sent), false);
  const f = sent.file.f;

  // Nothing is pushed: Bob's device and Alice's second device know the file, and have none of it.
  const seen = await until(async () => (await bob.messages(alice.me.account)).find((m) => m.file?.f === f));
  assert.equal(seen.file.ask, true);
  assert.equal(seen.file.have, false);
  await until(async () => (await alice2.messages(conv)).find((m) => m.file?.f === f));
  await new Promise((ok) => setTimeout(ok, 500));
  assert.equal(await bob.store.hasFile(f), false);
  assert.equal(await bob.store.part(f, 0), undefined);
  assert.equal(await alice2.store.part(f, 0), undefined);
  const db = new DatabaseSync(DB, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM relay_queue").get().n, 0); // never through the file queue
  db.close();

  // Only the device that sent it is asked; when it is not connected, nothing happens and Bob can try later.
  const presence = bob.ws.presence;
  bob.ws.presence = async () => [];
  try {
    assert.equal(await bob.acceptFile(alice.me.account, f), false);
  } finally {
    bob.ws.presence = presence;
  }

  // Alice's device streams it only to a verified device of the contact it was sent to.
  let streamed = 0;
  const stream = alice.streamFile;
  alice.streamFile = async (...a) => {
    streamed++;
    return stream.apply(alice, a);
  };
  try {
    await alice.serveAsked({ account: bob.me.account, from: "not-a-device" }, { k: "file-req", f });
    await alice.serveAsked({ account: "B".repeat(52), from: bob.me.device }, { k: "file-req", f });
    assert.equal(streamed, 0);
    // A pushed file is streamed again too when that device asks (its live chunks may have been lost, DESIGN.md §9
    // step 6), but not twice within a minute.
    const small = (await alice.messages(conv)).find((m) => m.file && !m.file.ask && m.file.have);
    await alice.serveAsked({ account: bob.me.account, from: bob.me.device }, { k: "file-req", f: small.file.f });
    await alice.serveAsked({ account: bob.me.account, from: bob.me.device }, { k: "file-req", f: small.file.f });
    assert.equal(streamed, 1);
    streamed = 0;

    // Bob takes it here: it comes live from Alice's device, and Alice sees it delivered.
    const got = waitFor(bob, "file", (d) => d.f === f, 20000);
    const progress = [];
    const onProgress = (e) => e.detail.f === f && progress.push(e.detail.done);
    bob.addEventListener("fileProgress", onProgress);
    assert.equal(await bob.acceptFile(alice.me.account, f), true);
    await got;
    bob.removeEventListener("fileProgress", onProgress);
    assert.equal(streamed, 1);
    // Bob let Alice's device stream it beyond the live budgets: her device heard of the grant and used it up as it
    // sent (DESIGN.md §10.2).
    const grant = alice.ws.grants.get(bob.me.device);
    assert.ok(grant, "Alice's device was told of Bob's grant");
    assert.ok(grant.bytes < p.queuedBytes(data.length) - data.length, `used: ${grant.bytes}`);
    assert.equal(progress.at(-1), p.chunkCount(data.length));
    assert.deepEqual(await bob.store.file(f), data);
    await until(async () => (await alice.messages(conv)).find((m) => m.file?.f === f)?.delivered > 0);
  } finally {
    alice.streamFile = stream;
  }
  // Alice's second device still has none of it (Bob chose his device), and can fetch it from her own devices.
  assert.equal(await alice2.store.hasFile(f), false);
  // Only the recipient takes a file: the sender's own devices fetch it from each other as before.
  await assert.rejects(alice.acceptFile(conv, f), (x) => x.code === "no_file");
});

test("binary chunks: a device that does not take them still gets the file, as text", async () => {
  const conv = bob.me.account;
  // Bob's device connects like an older client, without `caps`: the server sends it no binary frames.
  bob.ws.caps = [];
  let back = waitFor(bob, "status", (s) => s === "online");
  bob.ws.dropped(bob.ws.ws);
  await back;
  try {
    assert.equal(alice.ws.relayLimits.binary, true);
    const data = noise(3 * p.CHUNK + 10);
    const r = await alice.sendFile(conv, new File([data], "old.bin", { type: "application/octet-stream" }));
    // The first chunks went as binary frames; the server said Bob's device takes text only, so it missed some.
    assert.ok(alice.ws.textOnly.has(bob.me.device));
    assert.equal(r.waiting, 1);
    const sent = (await alice.messages(conv)).find((m) => m.file?.name === "old.bin");
    // Offered again, it goes as text and arrives whole.
    const got = waitFor(bob, "file", (d) => d.f === sent.file.f, 20000);
    assert.ok((await alice.flushFiles()) >= 1);
    await got;
    assert.deepEqual(await bob.store.file(sent.file.f), data);
  } finally {
    bob.ws.caps = ["bin"];
    back = waitFor(bob, "status", (s) => s === "online");
    bob.ws.dropped(bob.ws.ws);
    await back;
  }
  // Back to a binary connection, the next file goes binary again.
  assert.equal(alice.ws.textOnly.has(bob.me.device), true, "until Alice's device reconnects");
  alice.ws.textOnly.clear();
  const data = noise(2 * p.CHUNK);
  const got = waitFor(bob, "file", undefined, 20000);
  assert.deepEqual(await alice.sendFile(conv, new File([data], "new.bin")), { live: 1, queued: 0, waiting: 0 });
  assert.deepEqual(await bob.store.file((await got).f), data);
});

test("a file id already here or under way cannot be taken over from another conversation", async () => {
  const conv = alice.me.account;
  const other = "someone-else"; // a contact who learned the id (the server sees it in relayed chunks)
  const data = noise(5000);
  const sha256 = p.b64(await p.sha256(data));
  const f = p.b64(p.random(16));
  await bob.store.putFile(f, data);
  const forged = (id, body) => ({ id, time: Date.now(), from: { account: other, device: "d" }, body: { f, name: "evil.png", mime: "image/png", size: data.length, n: 1, key: p.b64(p.random(32)), ...body } });

  // Another hash for the same id: refused, nothing recorded.
  await bob.onFileMeta(forged("forged-1", { sha256: p.b64(p.random(32)) }), other, "in");
  assert.equal(await bob.store.message("forged-1"), undefined);
  // Without a hash at all: refused.
  await bob.onFileMeta(forged("forged-2", {}), other, "in");
  assert.equal(await bob.store.message("forged-2"), undefined);
  // The same content: harmless, the sender has it anyway.
  await bob.onFileMeta(forged("same-1", { sha256 }), other, "in");
  assert.equal((await bob.store.message("same-1"))?.file?.have, true);

  // A file stored before the hash was kept is hashed once, and the hash is saved.
  const old = noise(70_000);
  const k = await bob.store.tag("file", "old-file-2");
  const v = await p.encryptLocal(bob.store.key, old, `file:${k}`);
  const tx = bob.store.db.transaction("files", "readwrite");
  tx.objectStore("files").put({ k, v });
  await new Promise((r) => (tx.oncomplete = r));
  assert.deepEqual(await bob.store.fileDigest("old-file-2"), { size: old.length, sha256: p.b64(await p.sha256(old)) });
  assert.equal((await bob.store.fileHeader("old-file-2")).sha256, p.b64(await p.sha256(old)));
  assert.deepEqual(await bob.store.file("old-file-2"), old);

  // A transfer under way keeps its file message when another conversation names the same id.
  const f2 = p.b64(p.random(16));
  const meta = { f: f2, name: "x.bin", mime: "application/octet-stream", size: 10, n: 1, sha256: p.b64(p.random(32)), key: p.b64(p.random(32)) };
  await bob.serial(() => bob.expectFile(meta, { id: "first", conv }));
  await bob.serial(() => bob.expectFile({ ...meta, key: p.b64(p.random(32)) }, { id: "takeover", conv: other }));
  assert.equal(bob.files.get(f2).message.id, "first");
  assert.equal(bob.files.get(f2).meta.key, meta.key);
  // In the same conversation a newer file message still starts it again.
  const newer = { ...meta, key: p.b64(p.random(32)) };
  await bob.serial(() => bob.expectFile(newer, { id: "again", conv }));
  assert.equal(bob.files.get(f2).meta.key, newer.key);
  await bob.dropTransfer(f2, bob.files.get(f2), true);
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

test("a paper key brings back an account whose only device is lost", async () => {
  const doraHandle = await register("Dora", PW);
  const dora1 = await device(doraHandle, PW, "dora1");
  const account = dora1.me.account;
  bob.lists.clear();
  await dora1.request(bobHandle, "Hej Bob");
  await until(async () => bob.contacts.get(account)?.state === "incoming");
  await bob.accept(account);
  await until(async () => dora1.contacts.get(bob.me.account)?.state === "accepted");

  // The paper key needs the password again: a wrong one unlocks nothing.
  await assert.rejects(id.unlockLocalSecret(api, api.base, account, "wrong password here"), ApiError);
  const secret = await id.unlockLocalSecret(api, api.base, account, PW);
  const prepared = await dora1.preparePaperKey(secret);
  assert.match(prepared.text, /^MPK(-[0-9A-HJKMNP-TV-Z]{4}){9}$/);
  assert.equal((await dora1.paperKeys(true)).length, 0); // nothing changes before the user saved it
  await prepared.commit();
  const [paperDev] = await dora1.paperKeys(true);
  assert.ok(paperDev);
  // A new key replaces the old one in the same change.
  const second = await dora1.preparePaperKey(secret);
  await second.commit();
  const keys = await dora1.paperKeys(true);
  assert.equal(keys.length, 1);
  assert.notEqual(keys[0].id, paperDev.id);
  // A paper key has no prekey: nobody encrypts to it, so the server keeps nothing for it.
  bob.lists.clear();
  assert.deepEqual((await bob.peerTargets(account)).map((t) => t.device), [dora1.me.device]);

  // The only browser is lost. A new one logs in: nobody is left to approve the link request.
  dora1.stop();
  const login = await id.login(api, api.base, doraHandle, PW);
  const secret2 = await id.localSecret(api, login);
  const store = await Store.open(account, "dora2");
  await store.unlock(secret2);
  const setup = await setupDevice({ api, store, state: login.state, login, label: "dora2", secret: secret2 });
  assert.equal(setup.ready, false);
  login.unlocked.contents.accountSeed.fill(0);
  await assert.rejects(setup.approveWithPaperKey("MPK-not-a-key"), (e) => e.code === "bad_paper_key");
  await assert.rejects(setup.approveWithPaperKey(prepared.text), (e) => e.code === "wrong_paper_key"); // replaced
  // The paper alone is not enough: without the vault's local secret it is another key.
  const guess = await p.paperDevice(await p.paperSeed(await p.parsePaperKey(second.text), p.random(32), account));
  assert.ok(!(await dora1.paperKeys(true)).some((d) => d.id === guess.id));
  assert.equal(await setup.approveWithPaperKey(second.text), true);
  assert.equal(await setup.waitForApproval(), true);
  secret.fill(0);
  secret2.fill(0);
  const dora2 = new Messenger({ api, store, account, handle: doraHandle, home: api.base, realms: info.realms });
  running.push(dora2);
  const online = waitFor(dora2, "status", (s) => s === "online");
  await dora2.start();
  await online;

  // Same account, same list: Bob sees a new device, not a reset, and no fork.
  bob.lists.clear();
  assert.equal((await bob.list(account, true)).list.present.length, 3);
  assert.ok(!bob.contacts.get(account).fork);
  // The contacts were only on the lost device. Asking Bob again connects at once, since Bob accepted Dora before.
  await dora2.request(bobHandle);
  await until(async () => dora2.contacts.get(bob.me.account)?.state === "accepted");
  await bob.sendText(account, "Välkommen tillbaka");
  await until(async () => (await dora2.messages(bob.me.account)).some((m) => m.text === "Välkommen tillbaka"));
  // The lost device is removed; the server forgets what waited for it.
  await dora2.removeDevice(dora1.me.device);
  assert.equal((await dora2.ownList(true)).present.length, 2);
  assert.equal(db2count("mailbox"), 0);
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
  assert.deepEqual(tables, ["changes", "device_lists", "device_seen", "identities", "mailbox", "prekeys", "push_subs", "rate_limits", "relay_queue", "remote_ids", "settings", "sqlite_sequence"]);
});

test("disappearing messages: a shorter countdown on the recipient and the sender's devices", async () => {
  const conv = bob.me.account;
  const peer = alice.me.account;
  const text = "Borta om en kvart";
  await alice.sendEphemeral(conv, text, 15);
  // Bob stores it as an ephemeral message; its countdown has not started (it has not been shown yet).
  const id = await until(async () => {
    const m = (await bob.messages(peer)).find((x) => x.text === text);
    return m && m.kind === "ephemeral" && m.ttl === 15 ? m.id : null;
  });
  const b = await bob.store.message(id);
  assert.equal(b.kind, "ephemeral");
  assert.equal(b.ttl, 15);
  assert.equal(b.text, text);
  assert.equal(b.expires, undefined); // no countdown until Bob's device shows it
  // Alice's other device keeps its own copy of the same message.
  await until(async () => {
    const m = (await alice2.messages(conv)).find((x) => x.text === text);
    return m && m.kind === "ephemeral" && m.ttl === 15;
  });
  // Bob's receipt arrives: the sender's copies get a countdown ...
  await until(async () => (await alice.store.message(id))?.expires);
  assert.ok(Math.abs((await alice.store.message(id)).expires - (Date.now() + 15000)) < 5000);
  await until(async () => (await alice2.store.message(id))?.expires);
  // ... and showing it on Bob's device starts his too.
  await bob.markSeen(peer, [id]);
  assert.ok(Math.abs((await bob.store.message(id)).expires - (Date.now() + 15000)) < 5000);
  assert.ok((await bob.messages(peer)).some((m) => m.id === id));
});

test("a disappearing message that is due becomes gone and cannot come back", async () => {
  const conv = bob.me.account;
  const peer = alice.me.account;
  const text = "Försvinner snart";
  await alice.sendEphemeral(conv, text, 3600);
  const id = await until(async () => (await bob.messages(peer)).find((m) => m.text === text)?.id);
  const before = await bob.store.message(id);
  assert.equal(before.kind, "ephemeral");
  const wire = {
    id, kind: "ephemeral", time: before.time, conv: peer, heads: {},
    from: { account: alice.me.account, device: alice.me.device },
    to: { account: bob.me.account, device: bob.me.device },
    body: { text: before.text, ttl: before.ttl, wait: before.wait },
  };
  // Do not wait an hour: wind the stored deadline into the past, tell the sweeper, and sweep.
  const due = { ...before, expires: Date.now() - 1000 };
  await bob.store.putMessage(due);
  await bob.track(due);
  await bob.sweepTimed();
  assert.ok(!(await bob.messages(peer)).some((m) => m.id === id));
  const gone = await bob.store.message(id);
  assert.equal(gone.kind, "gone");
  assert.equal(gone.text, undefined);
  // The same envelope arriving again (a resend, a second mailbox read) does not bring it back.
  await bob.handleMessage(wire);
  await bob.sweepTimed();
  assert.ok(!(await bob.messages(peer)).some((m) => m.id === id));
  assert.equal((await bob.store.message(id)).kind, "gone");
});

test("history to a newly linked device leaves disappearing messages behind", async () => {
  const conv = alice.me.account;
  // Bob has disappearing messages (or what is left of them) from the tests before: they must not be handed over.
  assert.ok((await bob.store.messages(conv)).some((m) => m.kind === "ephemeral" || m.kind === "gone"));
  const bob2 = await device(bobHandle, PW, "bob2", async (setup) => {
    const req = await waitFor(bob, "link");
    assert.equal(req.code, setup.code);
    await bob.approveLink(req.request);
  });
  await until(async () => bob2.contacts.get(conv)?.state === "accepted");
  const msgs = await until(async () => {
    const all = await bob2.messages(conv);
    return all.some((m) => m.text === "Hemligt meddelande") ? all : null;
  });
  assert.ok(!msgs.some((m) => m.kind === "ephemeral" || m.kind === "gone"));
});

test("a disappearing message can be taken back from everyone like a text", async () => {
  const conv = bob.me.account;
  const peer = alice.me.account;
  const { id } = await alice.sendEphemeral(conv, "Ångrar mig", 3600);
  await until(async () => (await bob.store.message(id))?.kind === "ephemeral");
  await alice.retract(conv, id);
  // Both sides keep the usual placeholder instead of the text; no countdown brings anything back.
  await until(async () => (await bob.store.message(id))?.kind === "retracted");
  assert.equal((await bob.store.message(id)).text, undefined);
  assert.equal((await alice.store.message(id)).kind, "retracted");
  await bob.sweepTimed();
  assert.ok((await bob.messages(peer)).some((m) => m.id === id && m.kind === "retracted"));
});

test("a disappearing picture counts down like a text and is gone with its file on every device", async () => {
  const conv = bob.me.account;
  const peer = alice.me.account;
  const data = noise(40_000);
  const bobGot = waitFor(bob, "file");
  const alice2Got = waitFor(alice2, "file");
  await alice.sendFile(conv, new File([data], "snap.png", { type: "image/png" }), null, 15);
  const { f } = await bobGot;
  await alice2Got;
  // Bob keeps it as a disappearing message with the picture; no countdown until it has been on his screen.
  const id = await until(async () => (await bob.messages(peer)).find((m) => m.file?.f === f && m.file.have)?.id);
  const b = await bob.store.message(id);
  assert.equal(b.kind, "ephemeral");
  assert.equal(b.ttl, 15);
  assert.equal(b.file.name, "snap.png");
  assert.equal(b.expires, undefined);
  assert.deepEqual(await bob.store.file(f), data);
  // The receipt (sent once the picture is here) starts the countdown on the sender's devices.
  await until(async () => (await alice.store.message(id))?.expires);
  await until(async () => (await alice2.store.message(id))?.expires);
  assert.equal((await alice2.store.message(id)).kind, "ephemeral");
  await bob.markSeen(peer, [id]);
  assert.ok(Math.abs((await bob.store.message(id)).expires - (Date.now() + 15000)) < 5000);
  // Time is up everywhere: the message is gone, and so is the picture.
  for (const [who, conv2] of [[bob, peer], [alice, conv], [alice2, conv]]) {
    const due = { ...(await who.store.message(id)), expires: Date.now() - 1000 };
    await who.store.putMessage(due);
    await who.track(due);
    await who.sweepTimed();
    assert.equal((await who.store.message(id)).kind, "gone");
    assert.ok(!(await who.messages(conv2)).some((m) => m.id === id));
    assert.equal(await who.store.hasFile(f), false);
  }
  // The same envelope again does not bring the message back, nor start taking in the picture again.
  const wire = {
    id, kind: "ephemeral", time: b.time, conv: peer, heads: {},
    from: { account: alice.me.account, device: alice.me.device },
    to: { account: bob.me.account, device: bob.me.device },
    body: { file: { ...b.file, have: undefined }, ttl: b.ttl, wait: b.wait },
  };
  await bob.handleMessage(wire);
  assert.equal((await bob.store.message(id)).kind, "gone");
  assert.ok(!bob.files.has(f));
});

test("only pictures can be sent disappearing", async () => {
  const conv = bob.me.account;
  const peer = alice.me.account;
  await assert.rejects(
    alice.sendFile(conv, new File([noise(1000)], "avtal.pdf", { type: "application/pdf" }), null, 15),
    (e) => e.message === "ephemeral_files",
  );
  await assert.rejects(alice.sendFile(conv, new File([noise(1000)], "x.png", { type: "image/png" }), null, 7), (e) => e.message === "bad_ttl");
  // A disappearing message that carries another kind of file is dropped by the recipient.
  const id = "pdf-ephemeral-test";
  await bob.handleMessage({
    id, kind: "ephemeral", time: Math.floor(Date.now() / 1000), conv: peer, heads: {},
    from: { account: alice.me.account, device: alice.me.device },
    to: { account: bob.me.account, device: bob.me.device },
    body: { file: { f: "pdf-file-test", name: "avtal.pdf", mime: "application/pdf", size: 1000, sha256: "x", key: "x", n: 1 }, ttl: 15, wait: 3600 },
  });
  assert.equal(await bob.store.message(id), undefined);
  assert.ok(!bob.files.has("pdf-file-test"));
});

test("the server keeps an ephemeral envelope for the shorter wait", async () => {
  const conv = bob.me.account;
  bob.ws.close(); // Bob's first device is away: the envelope waits in the mailbox
  await new Promise((r) => setTimeout(r, 300));
  const before = Math.floor(Date.now() / 1000);
  await alice.sendEphemeral(conv, "Bara sju dagar", 60);
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare("SELECT expires FROM mailbox WHERE device = ? ORDER BY id DESC LIMIT 1").get(bob.me.device);
  db.close();
  assert.ok(row, "the envelope waits on the server");
  // `to[].ttl` is the unread wait (7 days), not the 14-day mailbox default.
  assert.ok(Math.abs(row.expires - (before + EPHEMERAL_WAIT)) < 120, `expires ${row.expires} vs ${before + EPHEMERAL_WAIT}`);
  assert.ok(row.expires < before + 14 * 24 * 3600, "not the 14-day default");
});

test("a timer outside the offered ones is refused", async () => {
  for (const bad of [0, 7, EPHEMERAL_WAIT, "15", null]) {
    await assert.rejects(alice.sendEphemeral(bob.me.account, "x", bad), (e) => e.code === "bad_ttl");
  }
  assert.ok(EPHEMERAL_TTLS.includes(15));
});

function db2count(table) {
  const db = new DatabaseSync(DB, { readOnly: true });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  db.close();
  return n;
}
