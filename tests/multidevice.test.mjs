// Several devices at once: two accounts with two connected devices each, on one real server (target/debug/murmo-
// server) with the real client engine. Covers messages sent from all devices at the same time reaching every device
// in full, and a picture whose live chunks were lost on the way to every device of the recipient (as to pages whose
// connections had died without the server noticing): the devices ask the sender for it and get it whole.
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

const PORT = 25000 + Math.floor(Math.random() * 1000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "murmo-multi-"));
const api = new Api(ORIGIN);
const running = [];
let server, realms;

before(async () => {
  const bin = new URL("../target/debug/murmo-server", import.meta.url).pathname;
  assert.ok(existsSync(bin), "run `cargo build` first");
  server = spawn(bin, [], {
    env: {
      ...process.env, MURMO_ORIGIN: ORIGIN, MURMO_BIND: `127.0.0.1:${PORT}`, MURMO_DB: join(dir, "m.sqlite"),
      MURMO_HOST_KEY_FILE: join(dir, "m.key"), MURMO_CLIENT_DIR: "", MURMO_LIMIT_SCALE: "10", MURMO_REMOTE_HOMES: "",
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

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const PW = "correct horse battery staple";

async function device(handle, prefix, onLink) {
  const login = await id.login(api, api.base, handle, PW);
  const secret = await id.localSecret(api, login);
  const store = await Store.open(login.state.account, prefix);
  await store.unlock(secret);
  const setup = await setupDevice({ api, store, state: login.state, login, label: prefix });
  if (!setup.ready) {
    await onLink(setup);
    assert.equal(await setup.waitForApproval(), true);
  }
  login.unlocked.contents.accountSeed.fill(0);
  const m = new Messenger({ api, store, account: login.state.account, handle, home: api.base, realms });
  m.test = { secret, prefix, handle };
  running.push(m);
  const online = waitFor(m, "status", (s) => s === "online");
  await m.start();
  await online;
  return m;
}

/** A second device of the account of `first`, approved there. */
function second(first, handle, prefix) {
  return device(handle, prefix, async () => {
    const req = await waitFor(first, "link");
    await first.approveLink(req.request);
  });
}

function noise(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

let a1, a2, b1, b2;

test("two accounts with two connected devices each", async () => {
  const ah = (await (await id.prepareRegistration(api, "Alice", PW)).finish()).handle;
  const bh = (await (await id.prepareRegistration(api, "Bob", PW)).finish()).handle;
  a1 = await device(ah, "a1");
  b1 = await device(bh, "b1");
  a2 = await second(a1, ah, "a2");
  b2 = await second(b1, bh, "b2");
  const incoming = waitFor(b2, "contacts", () => b2.contacts.get(a1.me.account)?.state === "incoming");
  await a1.request(bh, "Hej");
  await incoming;
  await b1.accept(a1.me.account);
  for (const d of [a1, a2]) await until(() => d.contacts.get(b1.me.account)?.state === "accepted");
  for (const d of [b1, b2]) await until(() => d.contacts.get(a1.me.account)?.state === "accepted");
});

test("messages from all devices at once reach every device in full", async () => {
  const sends = [];
  for (const [d, to, name] of [[a1, b1, "a1"], [a2, b1, "a2"], [b1, a1, "b1"], [b2, a1, "b2"]]) {
    for (let i = 0; i < 12; i++) sends.push(d.sendText(to.me.account, `${name}-${i}`));
  }
  await Promise.all(sends);
  const want = (prefix) => Array.from({ length: 12 }, (_, i) => `${prefix}-${i}`);
  const all = [...want("a1"), ...want("a2"), ...want("b1"), ...want("b2")].sort();
  for (const [d, conv] of [[a1, b1.me.account], [a2, b1.me.account], [b1, a1.me.account], [b2, a1.me.account]]) {
    await until(async () => {
      const texts = (await d.messages(conv)).filter((m) => m.kind === "text").map((m) => m.text).filter((t) => /^[ab][12]-/.test(t));
      return JSON.stringify([...new Set(texts)].sort()) === JSON.stringify(all);
    });
    // Each once, and the direction right on every device.
    const ms = (await d.messages(conv)).filter((m) => /^[ab][12]-/.test(m.text ?? ""));
    assert.equal(ms.length, all.length);
    const mine = d.me.account === a1.me.account ? /^a/ : /^b/;
    for (const m of ms) assert.equal(m.dir, mine.test(m.text) ? "out" : "in", `${m.text} on ${d.me.device}`);
  }
});

test("a picture whose live chunks were lost on every device of the recipient is asked for again, from the sender", async () => {
  // Both of Alice's pages drop every chunk, as pages whose connections had died would: the server counts them
  // as delivered, so the sender has nothing to send again on its own.
  const drop = (d) => {
    const real = d.onRelay.bind(d);
    d.onRelay = async (f) => (d.isChunk(f) ? undefined : real(f));
    return () => delete d.onRelay;
  };
  const restore = [drop(a1), drop(a2)];
  const bytes = noise(150_000);
  const r = await b1.sendFile(a1.me.account, new File([bytes], "bild.png", { type: "image/png" }));
  assert.equal(r.live, 2);
  assert.equal(r.waiting, 0);
  for (const d of [a1, a2]) await until(async () => (await d.messages(b1.me.account)).some((m) => m.file?.name === "bild.png"));
  await new Promise((r2) => setTimeout(r2, 300));
  for (const d of [a1, a2]) {
    const m = (await d.messages(b1.me.account)).find((x) => x.file?.name === "bild.png");
    assert.equal(m.file.have, false);
    assert.equal(d.wantedFiles.length, 1);
  }
  restore.forEach((f) => f());
  // Long enough without a part: each device asks (here at once, instead of after FILE_STALL).
  for (const d of [a1, a2]) {
    for (const w of d.wantedFiles) {
      w.since -= 60_000;
      const t = d.files.get(w.f);
      if (t) t.updated -= 60_000;
    }
  }
  assert.equal(await a1.askWanted(), 1);
  assert.equal(await a2.askWanted(), 1);
  for (const d of [a1, a2]) {
    const m = await until(async () => (await d.messages(b1.me.account)).find((x) => x.file?.name === "bild.png" && x.file.have));
    const got = new Uint8Array(await (await d.fileBlob(m.file.f, "image/png")).arrayBuffer());
    assert.deepEqual(got, bytes);
    assert.equal(d.wantedFiles.length, 0);
  }
  // And Bob learns that it arrived.
  await until(async () => (await b1.messages(a1.me.account)).find((x) => x.file?.name === "bild.png")?.delivered > 0);
});

test("the sender streams a file again on request at most once a minute per device", async () => {
  const m = (await b1.messages(a1.me.account)).find((x) => x.file?.name === "bild.png");
  // a1 asks again at once: Bob's device does not stream it a second time so soon.
  let streamed = 0;
  const real = b1.streamFile.bind(b1);
  b1.streamFile = async (...args) => {
    streamed++;
    return real(...args);
  };
  await b1.serveAsked({ account: a1.me.account, from: a1.me.device }, { k: "file-req", f: m.file.f });
  assert.equal(streamed, 0);
  delete b1.streamFile;
});

test("the same device opened in a second tab takes over; the first stops instead of pushing it out", async () => {
  // A second page of a1's browser: the same stored device.
  const store = await Store.open(a1.me.account, a1.test.prefix);
  await store.unlock(a1.test.secret);
  const tab = new Messenger({ api, store, account: a1.me.account, handle: a1.test.handle, home: api.base, realms });
  running.push(tab);
  const replaced = waitFor(a1, "replaced");
  const online = waitFor(tab, "status", (st) => st === "online");
  await tab.start();
  await online;
  await replaced;
  assert.equal(a1.status, "replaced");
  // The first page does not come back (which would push the new one out, and so on).
  a1.wake();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(tab.status, "online");
  assert.equal(a1.ws.ready, false);
  // Messages now reach the tab that has the connection, and the other device as before.
  await b1.sendText(a1.me.account, "till den nya fliken");
  for (const d of [tab, a2]) await until(async () => (await d.messages(b1.me.account)).some((m) => m.text === "till den nya fliken"));
});
