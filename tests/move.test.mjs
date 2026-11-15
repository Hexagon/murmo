// End to end: the server moves to a new domain (MURMO_ORIGIN) and keeps answering on the old one
// (MURMO_OLD_ORIGINS). Identities made on the old domain keep working, their devices there keep connecting, and a
// device on the new domain is linked by one of them and gets the history handed over.
//
//   cargo build && npm test

import "fake-indexeddb/auto";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api, ApiError } from "../client/js/api.js";
import * as id from "../client/js/identity.js";
import { Messenger, Store, setupDevice } from "../client/js/core.js";
import * as rc from "../client/vendor/rootcard/src/index.js";

const PORT = 21000 + Math.floor(Math.random() * 1000);
const OLD = `http://localhost:${PORT}`; // the domain before the move
const NEW = `http://127.0.0.1:${PORT}`; // the domain after it (the same server)
const dir = mkdtempSync(join(tmpdir(), "murmo-move-"));
const oldApi = new Api(OLD);
const newApi = new Api(NEW);
const running = [];
let server;

function start(env) {
  const bin = new URL("../target/debug/murmo-server", import.meta.url).pathname;
  assert.ok(existsSync(bin), "run `cargo build` first");
  return spawn(bin, [], {
    env: {
      ...process.env, MURMO_BIND: `127.0.0.1:${PORT}`, MURMO_DB: join(dir, "murmo.sqlite"),
      MURMO_HOST_KEY_FILE: join(dir, "murmo.key"), MURMO_CLIENT_DIR: "", MURMO_LIMIT_SCALE: "10",
      MURMO_REMOTE_HOMES: "", ...env,
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

async function stopServer() {
  const gone = new Promise((r) => server.once("exit", r));
  server.kill();
  await gone;
}

after(() => {
  for (const m of running) m.stop();
  server?.kill();
});

function waitFor(target, type, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    target.addEventListener(type, (e) => { clearTimeout(t); resolve(e.detail); }, { once: true });
  });
}

async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A device of `handle` used through `api` (the page's origin), with its home at `home`. */
async function device(api, home, handle, prefix, onLink) {
  const login = await id.login(api, home, handle, PW);
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
  return open(api, store, login.state, home);
}

async function open(api, store, state, home) {
  const info = await api.info();
  const m = new Messenger({ api, store, account: state.account, handle: state.handle, home, realms: info.realms });
  running.push(m);
  const online = waitFor(m, "status");
  await m.start();
  assert.equal(await online, "online");
  return m;
}

const PW = "correct horse battery staple";
let dana, erik, danaHandle, erikHandle;

test("before the move: identities, devices and a conversation on the old domain", async () => {
  server = start({ MURMO_ORIGIN: OLD });
  await up(oldApi);
  for (const name of ["Dana", "Erik"]) {
    const reg = await id.prepareRegistration(oldApi, name, PW);
    const done = await reg.finish();
    if (name === "Dana") danaHandle = done.handle;
    else erikHandle = done.handle;
  }
  dana = await device(oldApi, oldApi.base, danaHandle, "dana-old");
  erik = await device(oldApi, oldApi.base, erikHandle, "erik-old");
  await dana.request(erikHandle, "Hej Erik");
  await until(() => erik.contacts.get(dana.me.account)?.state === "incoming");
  await erik.accept(dana.me.account);
  await until(() => dana.contacts.get(erik.me.account)?.state === "accepted");
  await dana.sendText(erik.me.account, "Före flytten");
  await until(async () => (await erik.messages(dana.me.account)).some((m) => m.text === "Före flytten"));
});

test("after the move: old devices still connect, a new-domain device is linked and gets the history", async () => {
  for (const m of [dana, erik]) m.stop();
  await stopServer();
  server = start({ MURMO_ORIGIN: NEW, MURMO_OLD_ORIGINS: OLD });
  await up(newApi);

  const info = await newApi.info();
  assert.equal(info.origin, NEW);
  assert.deepEqual(info.origins, [NEW, OLD]);
  // Both rootcard base URLs belong to the host; identities keep their home at the old one.
  assert.deepEqual((await newApi.rc("GET", "/host")).urls, [`${NEW}/id`, `${OLD}/id`]);
  assert.equal((await newApi.lookup(danaHandle)).home, `${OLD}/id`);

  // The devices on the old domain open again with what they have stored.
  const reopen = async (m, prefix) => {
    const store = await Store.open(m.me.account, prefix);
    const secret = await id.localSecret(oldApi, await id.login(oldApi, oldApi.base, m.handle, PW));
    await store.unlock(secret);
    return open(oldApi, store, { account: m.me.account, handle: m.handle }, oldApi.base);
  };
  dana = await reopen(dana, "dana-old");
  erik = await reopen(erik, "erik-old");

  // Dana's new device, on the new domain: the home stays at the old address; the old device approves the link.
  const dana2 = await device(newApi, oldApi.base, danaHandle, "dana-new", async () => {
    const req = await waitFor(dana, "link");
    await dana.approveLink(req.request);
  });
  await until(() => dana2.contacts.get(erik.me.account)?.state === "accepted");
  await until(async () => (await dana2.messages(erik.me.account)).some((m) => m.text === "Före flytten"));

  // And the conversation goes on from the new domain.
  erik.lists.clear();
  await dana2.sendText(erik.me.account, "Efter flytten");
  await until(async () => (await erik.messages(dana.me.account)).some((m) => m.text === "Efter flytten"));
});

test("a link proof for an origin that is not this server's is refused", async () => {
  const login = await id.login(newApi, oldApi.base, erikHandle, PW);
  const { nonce } = await newApi.challenge();
  const proof = await rc.prove(login.state, "account", login.unlocked.contents.accountSeed, rc.base64urlDecode(nonce), "https://elsewhere.example");
  login.unlocked.contents.accountSeed.fill(0);
  await assert.rejects(
    newApi.link(login.state.account, {}, proof, nonce),
    (e) => e instanceof ApiError && e.code === "bad_proof",
  );
});
