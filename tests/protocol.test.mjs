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

test("fixture for the Rust verifier", { skip: !process.env.MURMO_WRITE_FIXTURE }, async () => {
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

test("file names and types from other devices are made safe", () => {
  assert.equal(p.safeFileName("photo\u202Egpj.exe"), "photogpj.exe");
  assert.equal(p.safeFileName("a\u2067b\u200Fc\u0007.txt"), "abc.txt");
  assert.equal(p.safeFileName("../../etc/passwd"), "_.._etc_passwd");
  assert.equal(p.safeFileName("C:\\x\\y.doc"), "C:_x_y.doc");
  assert.equal(p.safeFileName(".hidden"), "hidden");
  assert.equal(p.safeFileName(""), "fil");
  assert.equal(p.safeFileName(undefined), "fil");
  assert.equal(p.safeFileName("x".repeat(500)).length, 200);
  assert.equal(p.safeMime("IMAGE/PNG"), "image/png");
  assert.equal(p.safeMime("text/html; charset=utf-8"), "application/octet-stream");
  assert.equal(p.safeMime("image/svg+xml"), "image/svg+xml");
  assert.ok(!p.inlineImage(p.safeMime("image/svg+xml"), 10));
  assert.equal(p.safeMime(42), "application/octet-stream");
});

test("incremental SHA-256 matches WebCrypto at every split", async () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 65536]) {
    const data = p.random(n);
    const want = await p.sha256(data);
    for (const step of [1, 7, 64, 1000]) {
      const h = new p.Sha256();
      for (let o = 0; o < n; o += step) h.update(data.subarray(o, o + step));
      assert.deepEqual(h.digest(), want, `length ${n}, step ${step}`);
    }
  }
});

test("image dimensions come from the header, without decoding", () => {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 100_000);
  new DataView(png.buffer).setUint32(20, 100_000);
  assert.deepEqual(p.imageSize(png), { width: 100_000, height: 100_000 });
  assert.ok(!p.imageFits(p.imageSize(png))); // ten gigapixels from 33 bytes

  // GIF: a small logical screen, but a frame that claims to be far larger
  const gif = new Uint8Array([
    ...p.utf8("GIF89a"), 10, 0, 10, 0, 0, 0, 0,
    0x21, 0xf9, 4, 0, 0, 0, 0, 0,
    0x2c, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 2, 2, 0x44, 0x01, 0, 0x3b,
  ]);
  assert.deepEqual(p.imageSize(gif), { width: 65535, height: 65535 });
  assert.ok(!p.imageFits(p.imageSize(gif)));
  assert.ok(p.imageFits(p.imageSize(gif.slice(0, 13)))); // only the screen: 10 × 10

  // JPEG: an APP0 segment, then the frame header (SOF2)
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8, 0x0b, 0xb8, 0x0f, 0xa0, 3]);
  assert.deepEqual(p.imageSize(jpeg), { width: 4000, height: 3000 });
  assert.ok(p.imageFits(p.imageSize(jpeg)));
  assert.equal(p.imageSize(jpeg.slice(0, 10)), null); // frame header not in the bytes read: not shown inline

  const webp = (kind, body) => new Uint8Array([...p.utf8("RIFF"), 0, 0, 0, 0, ...p.utf8("WEBP"), ...p.utf8(kind), 0, 0, 0, 0, ...body, ...new Uint8Array(10)]);
  assert.deepEqual(p.imageSize(webp("VP8X", [0, 0, 0, 0, 0x3f, 0x1f, 0, 0x3f, 0x1f, 0])), { width: 8000, height: 8000 });
  const l = (8000 - 1) | ((6000 - 1) << 14);
  assert.deepEqual(p.imageSize(webp("VP8L", [0x2f, l & 255, (l >> 8) & 255, (l >> 16) & 255, (l >>> 24) & 255, 0])), { width: 8000, height: 6000 });
  assert.deepEqual(p.imageSize(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x06, 0xb0, 0x04])), { width: 1600, height: 1200 });

  assert.equal(p.imageSize(p.utf8("<svg/>")), null);
  assert.ok(!p.imageFits(null));
});

test("paper key: written form, typing errors, and both the paper and the local secret are needed", async () => {
  const account = "C".repeat(52);
  const secret = rc.systemRandom(32);
  const { paper, seed } = await p.newPaperKey(secret, account);
  const text = await p.formatPaperKey(paper);
  assert.match(text, /^MPK(-[0-9A-HJKMNP-TV-Z]{4}){9}$/);
  // Lower case, spaces instead of dashes, and O/I/L for 0/1 are forgiven.
  const typed = text.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
  assert.deepEqual(await p.parsePaperKey(typed), paper);
  assert.deepEqual(await p.parsePaperKey(text.slice(4)), paper);
  // A wrong character is caught by the checksum.
  const i = 6;
  const wrong = text.slice(0, i) + (text[i] === "2" ? "3" : "2") + text.slice(i + 1);
  await assert.rejects(p.parsePaperKey(wrong), /bad_paper_key/);
  await assert.rejects(p.parsePaperKey("MPK-1234"), /bad_paper_key/);
  // The device key depends on the paper, the vault's local secret and the account.
  const dev = await p.paperDevice(seed);
  assert.equal(dev.label, p.PAPER_LABEL);
  assert.ok(p.isPaper(dev));
  assert.deepEqual(await p.paperDevice(await p.paperSeed(paper, secret, account)), dev);
  assert.notDeepEqual(await p.paperDevice(await p.paperSeed(paper, rc.systemRandom(32), account)), dev);
  assert.notDeepEqual(await p.paperDevice(await p.paperSeed(paper, secret, "D".repeat(52))), dev);
  // It signs device-list entries like any device.
  const ak = await accountKey();
  const d1 = await device("one");
  const d2 = await device("two");
  const e0 = await p.newEntry({ account, accountKey: ak.key, entries: [], op: "add", device: d1.value, signer: { id: "account", key: ak.seed } });
  const e1 = await p.newEntry({ account, accountKey: ak.key, entries: [e0], op: "add", device: dev, signer: { id: d1.id, key: d1.privateKey } });
  const e2 = await p.newEntry({ account, accountKey: ak.key, entries: [e0, e1], op: "add", device: d2.value, signer: { id: dev.id, key: seed } });
  assert.equal((await p.verifyDevices(account, ak.key, [e0, e1, e2])).present.length, 3);
});
