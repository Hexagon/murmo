// Unit tests of client/js/protocol.js in Node 22 (node --test tests/).
import test from "node:test";
import assert from "node:assert/strict";
import * as rc from "../client/vendor/rootcard/src/index.js";
import * as p from "../client/js/protocol.js";

async function device(label) {
  const kp = await p.newKeyPair("Ed25519");
  const id = await p.deviceId(kp.publicRaw);
  return { id, privateKey: kp.privateKey, keyRaw: kp.publicRaw, value: { id, key: rc.formatKey("ed25519", kp.publicRaw), label } };
}

async function accountKey() {
  const seed = rc.systemRandom(32);
  return { seed, key: rc.formatKey("ed25519", await rc.ed25519Public(seed)) };
}

test("device list: genesis by account key, additions only by devices", async () => {
  const ak = await accountKey();
  const account = "A".repeat(52);
  const d1 = await device("one");
  const d2 = await device("two");
  const e0 = await p.newEntry({ account, accountKey: ak.key, entries: [], op: "add", device: d1.value, signer: { id: "account", key: ak.seed } });
  const e1 = await p.newEntry({ account, accountKey: ak.key, entries: [e0], op: "add", device: d2.value, signer: { id: d1.id, key: d1.privateKey } });
  const list = await p.verifyDevices(account, ak.key, [e0, e1]);
  assert.equal(list.present.length, 2);
  assert.ok(await p.extendsPinned(list, await p.entryHash(e0), 1));
  // The account key (a password thief) cannot add a second device.
  const thief = await device("thief");
  const bad = await p.newEntry({ account, accountKey: ak.key, entries: [e0], op: "add", device: thief.value, signer: { id: "account", key: ak.seed } });
  await assert.rejects(p.verifyDevices(account, ak.key, [e0, bad]));
  // A list for another instance is refused.
  const other = await accountKey();
  await assert.rejects(p.verifyDevices(account, other.key, [e0]));
});

test("envelope, signed message and verification", async () => {
  const me = await device("me");
  const you = await device("you");
  const youPk = await p.newPrekey("B".repeat(52), { id: you.id, privateKey: you.privateKey });
  await p.verifyPrekey("B".repeat(52), { id: you.id, keyRaw: you.keyRaw }, youPk.value);
  const msg = await p.signMessage(
    {
      id: p.b64(p.random(16)), kind: "text", time: p.now(),
      from: { account: "A".repeat(52), device: me.id }, to: { account: "B".repeat(52), device: you.id },
      conv: "B".repeat(52), heads: {}, body: { text: "hej" },
    },
    me.privateKey,
  );
  const env = await p.seal(you.id, youPk.value, msg);
  const pkMap = new Map([[youPk.secret.id, { privateKey: youPk.secret.privateKey, publicRaw: rc.parseKey(youPk.value.key, "x25519") }]]);
  const plain = await p.open(you.id, pkMap, env);
  const m = await p.verifyMessage(plain, { account: "B".repeat(52), device: you.id }, async (a, d) => (d === me.id ? me : undefined));
  assert.equal(m.body.text, "hej");
  // The same envelope is useless for another device, and a forwarded message fails the recipient check.
  await assert.rejects(p.open("x", pkMap, env));
  await assert.rejects(p.verifyMessage(plain, { account: "C".repeat(52), device: you.id }, async () => me));
});

test("file chunks and local encryption", async () => {
  const fk = await p.newFileKey();
  const data = p.random(1000);
  const packed = await p.encryptChunk(fk, "f1", 0, 1, data);
  const back = await p.decryptChunk(fk, p.unpack(packed));
  assert.deepEqual(back, data);
  await assert.rejects(p.decryptChunk(fk, { ...p.unpack(packed), i: 1 }));
  const lk = await p.localKey(p.random(32), p.random(16));
  const blob = await p.encryptLocal(lk, data, "msg");
  assert.deepEqual(await p.decryptLocal(lk, blob, "msg"), data);
  await assert.rejects(p.decryptLocal(lk, blob, "other"));
  assert.match(await p.safetyCode({ account: "A", head: "x" }, { account: "B", head: "y" }), /^(\d{4} ){11}\d{4}$/);
});

test("fixture for the Rust verifier", { skip: !process.env.MESG_WRITE_FIXTURE }, async () => {
  const ak = await accountKey();
  const account = "A".repeat(52);
  const d1 = await device("one");
  const d2 = await device("two");
  const e0 = await p.newEntry({ account, accountKey: ak.key, entries: [], op: "add", device: d1.value, signer: { id: "account", key: ak.seed } });
  const e1 = await p.newEntry({ account, accountKey: ak.key, entries: [e0], op: "add", device: d2.value, signer: { id: d1.id, key: d1.privateKey } });
  const pk = await p.newPrekey(account, { id: d2.id, privateKey: d2.privateKey });
  const list = await p.verifyDevices(account, ak.key, [e0, e1]);
  const fixture = { account, account_key: ak.key, entries: [e0, e1], head: list.head, prekey: pk.value, prekey_device: d2.value };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("../server/tests/fixtures/js-device-list.json", import.meta.url), rc.canonicalString(fixture) + "\n");
});
