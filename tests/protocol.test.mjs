// Unit tests of client/js/protocol.js in Node 22 (node --test tests/).
import test from "node:test";
import assert from "node:assert/strict";
import * as rc from "../client/vendor/rootcard/src/index.js";
import * as p from "../client/js/protocol.js";
import * as emoji from "../client/js/emoji.js";
import * as giphy from "../client/js/giphy.js";
import { Messenger, validReaction } from "../client/js/core.js";
import { Socket } from "../client/js/net.js";
import { partKey } from "../client/js/store.js";

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

test("a send split over several frames is marked partial when a later frame fails", async () => {
  const to = Array.from({ length: 30 }, (_, i) => ({ device: `d${i}`, env: "AAAA" }));
  const frames = [];
  const failing = (n) => ({
    call: async (f) => {
      frames.push(f.to.length);
      if (frames.length > n) throw new Error("rate_limited");
      return { t: "sent", failed: [] };
    },
  });
  // The first frame fails: nothing went out.
  await assert.rejects(Socket.prototype.sendEnvelopes.call(failing(0), to), (e) => e.message === "rate_limited" && !e.partial);
  // The second fails after the first was taken: partial.
  frames.length = 0;
  await assert.rejects(Socket.prototype.sendEnvelopes.call(failing(1), to), (e) => e.message === "rate_limited" && e.partial === true);
  assert.deepEqual(frames, [24, 6]);
});

test("prekeys must be fresh, and never older than one seen before", async () => {
  const B = "B".repeat(52);
  const you = await device("you");
  const dev = { id: you.id, keyRaw: you.keyRaw };
  const at = p.now();
  const signed = (time) =>
    p.signObject(p.LABELS.prekey, { v: 1, account: B, device: you.id, id: p.b64(p.random(8)), key: rc.formatKey("x25519", p.random(32)), time }, you.privateKey);
  // Up to rotation + keep old is fine; older is refused as stale; much later than now, or no time, is refused.
  const ok = await signed(at - p.PREKEY_MAX_AGE + 60);
  assert.equal(await p.verifyPrekey(B, dev, ok, at), ok);
  await assert.rejects(p.verifyPrekey(B, dev, await signed(at - p.PREKEY_MAX_AGE - 60), at), /stale_prekey/);
  await assert.rejects(p.verifyPrekey(B, dev, await signed(at + 3 * 24 * 3600), at), /bad_prekey/);
  await assert.rejects(p.verifyPrekey(B, dev, await signed("soon"), at), /bad_prekey/);
  // The same prekey is refused once it has aged past the limit.
  await assert.rejects(p.verifyPrekey(B, dev, ok, at + 120), /stale_prekey/);
  // A server that serves an older prekey than one seen before does not get it used.
  const older = await signed(at - 100);
  const newer = await signed(at - 10);
  assert.equal(p.newerPrekey(older, newer), newer);
  assert.equal(p.newerPrekey(newer, older), newer);
  assert.equal(p.newerPrekey(older, undefined), older);
  assert.equal(p.newerPrekey(undefined, newer), newer);
  assert.equal(p.newerPrekey(undefined, undefined), undefined);
});

test("a messenger keeps using the newest prekey it has seen for a device, and forgets removed devices", async () => {
  const B = "B".repeat(52);
  const you = await device("you");
  const gone = await device("gone");
  const dev = { id: you.id, keyRaw: you.keyRaw };
  const signed = (d, time) =>
    p.signObject(p.LABELS.prekey, { v: 1, account: B, device: d.id, id: p.b64(p.random(8)), key: rc.formatKey("x25519", p.random(32)), time }, d.privateKey);
  // Only what freshPrekeys needs of a messenger, with a store that remembers what it was given.
  const saved = [];
  const m = Object.assign(Object.create(Messenger.prototype), {
    seenPrekeys: new Map(),
    store: { setSecret: async (k, v) => saved.push([k, v]) },
  });
  const t = p.now();
  const newer = await signed(you, t - 10);
  const older = await signed(you, t - 1000);
  const other = await signed(gone, t - 10);
  let got = await m.freshPrekeys(B, { present: [dev, { id: gone.id, keyRaw: gone.keyRaw }] }, new Map([[you.id, newer], [gone.id, other]]));
  assert.equal(got.get(you.id), newer);
  assert.equal(saved.at(-1)[0], "seenPrekeys");
  // Later the server serves the older one again: the newer one is used.
  got = await m.freshPrekeys(B, { present: [dev] }, new Map([[you.id, older]]));
  assert.equal(got.get(you.id), newer);
  assert.equal(m.seenPrekeys.has(`${B} ${gone.id}`), false);
  // A remembered prekey that has grown too old is not used either.
  const stale = await signed(you, t - p.PREKEY_MAX_AGE + 1);
  m.seenPrekeys.set(`${B} ${you.id}`, stale);
  await new Promise((r) => setTimeout(r, 2100)); // now it is older than PREKEY_MAX_AGE
  got = await m.freshPrekeys(B, { present: [dev] }, new Map());
  assert.equal(got.has(you.id), false);
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

test("GIF signature", () => {
  assert.ok(p.isGif(p.utf8("GIF89a....")));
  assert.ok(p.isGif(p.utf8("GIF87a")));
  assert.ok(!p.isGif(p.utf8("GIF8")));
  assert.ok(!p.isGif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
});

test("emoji: only-emoji messages and the recent list", () => {
  for (const t of ["👍", "😀 😀😀", "🇸🇪", "1️⃣", "👨‍👩‍👧", "🏳️‍🌈", " ❤️\n"]) assert.ok(emoji.emojiOnly(t), t);
  for (const t of ["", "  ", "hej 😀", "😀😀😀😀", "abc", ":)", "1", "😀".repeat(40)]) assert.ok(!emoji.emojiOnly(t), t);
  let r = [];
  for (const e of ["😀", "👍", "😀", "<b>", "❤️"]) r = emoji.remember(r, e);
  assert.deepEqual(r, ["❤️", "😀", "👍"]); // newest first, no duplicates, only emoji from the picker
  for (let i = 0; i < 100; i++) r = emoji.remember(r, emoji.CATEGORIES[0].emoji[i % 90]);
  assert.equal(r.length, emoji.RECENT_MAX);
});

test("reactions are one emoji or empty", () => {
  for (const e of ["", "👍", "❤️", "🏳️‍🌈"]) assert.ok(validReaction(e), e);
  for (const e of ["👍👍", "a", "<b>", null, 1, "👍 ", "😀".repeat(20)]) assert.ok(!validReaction(e), String(e));
});

test("GIPHY: only its media hosts, without tracking parameters, within the size limit", () => {
  assert.equal(giphy.mediaUrl("https://media2.giphy.com/media/abc/giphy.gif?cid=x&rid=y"), "https://media2.giphy.com/media/abc/giphy.gif");
  for (const u of ["http://media2.giphy.com/a.gif", "https://evil.example/a.gif", "https://media2.giphy.com.evil.example/a.gif", "https://media2.giphy.com:8443/a.gif", "javascript:alert(1)", "", null]) {
    assert.equal(giphy.mediaUrl(u), null, String(u));
  }
  const im = (host, size) => ({ url: `https://${host}/media/x/a.gif?cid=1`, size: String(size) });
  const json = {
    data: [
      { id: "a", title: "Katt", images: { fixed_width_small: im("media1.giphy.com", 10), original: im("media1.giphy.com", 20e6), downsized: im("media1.giphy.com", 1e6) } },
      { id: "b", images: { fixed_width_small: im("evil.example", 10), original: im("media1.giphy.com", 10) } },
      { id: "c", images: { fixed_width_small: im("i.giphy.com", 10), original: im("i.giphy.com", 20e6) } },
      "junk",
    ],
  };
  const r = giphy.parseResults(json, 8 * 1024 * 1024);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { id: "a", title: "Katt", preview: "https://media1.giphy.com/media/x/a.gif", full: "https://media1.giphy.com/media/x/a.gif" });
  assert.deepEqual(giphy.parseResults(null, 1), []);
});

test("relay pacing: stays under the server's byte budgets and waits out a refusal", async () => {
  const s = new Socket("ws://unused", async () => ({}));
  const sent = [];
  s.ready = true;
  s.ws = { send: (t) => sent.push(JSON.parse(t)) };
  // As the server announces them in "ready" (bad values fall back to the defaults).
  await s.onFrame(JSON.stringify({ t: "ready", relay: { bytes: 1000, peer: 500, window: 1 } }));
  clearInterval(s.beat);
  // An older server announces only these: no grants, no queue budget (queued chunks count as live), text frames.
  assert.deepEqual(s.relayLimits, { bytes: 1000, peer: 500, granted: 0, store: 0, remote: 0, frames: 3000, slowFrames: 3000, grant: 0, binary: false, window: 1 });
  s.relay(["b", "b"], "x".repeat(400));
  // Another recipient fits at once; the same one waits until the first frame leaves the window.
  let t = Date.now();
  await s.pace(["c"], 400);
  assert.ok(Date.now() - t < 100);
  t = Date.now();
  await s.pace(["b"], 100);
  assert.ok(Date.now() - t >= 900);
  // The total over all recipients counts each recipient.
  s.relayLog = [];
  s.relay(["a", "b"], "x".repeat(300));
  t = Date.now();
  await s.pace(["c", "d"], 200); // 600 + 400 > 900
  assert.ok(Date.now() - t >= 900);
  // A "rate_limited" for a transfer pauses relays and is told to whoever owns the reference.
  s.relayLog = [];
  const errors = [];
  s.addEventListener("frame-error", (e) => errors.push(e.detail));
  await s.onFrame(JSON.stringify({ t: "error", error: "rate_limited", id: "f.r", retry: 1 }));
  assert.deepEqual(errors, [{ id: "f.r", error: "rate_limited", retry: 1 }]);
  t = Date.now();
  await s.pace(["c"], 1);
  assert.ok(Date.now() - t >= 900);
  await s.onFrame(JSON.stringify({ t: "ready", relay: { bytes: -1 } }));
  clearInterval(s.beat);
  assert.equal(s.relayLimits.peer, 96 * 1024 * 1024);
  assert.equal(sent.length, 2);
});

test("queued bytes of a file and the largest file a queue limit takes", () => {
  assert.equal(p.queuedBytes(0), 256);
  assert.equal(p.queuedBytes(p.CHUNK), Math.ceil((p.CHUNK * 16) / 9) + 256);
  assert.equal(p.queuedBytes(p.CHUNK + 1), Math.ceil(((p.CHUNK + 1) * 16) / 9) + 512);
  assert.equal(p.queuedBytes(p.CHUNK, true), p.CHUNK + 96);
  for (const binary of [false, true]) {
    for (const limit of [256, 100_000, 50 * 1024 * 1024, 150 * 1024 * 1024]) {
      const max = p.largestQueued(limit, binary);
      assert.ok(p.queuedBytes(max, binary) <= limit, `${limit}`);
      if (max < p.MAX_FILE) assert.ok(p.queuedBytes(max + 1, binary) > limit, `${limit}`);
    }
    assert.equal(p.largestQueued(0, binary), -1);
    assert.equal(p.largestQueued(1e12, binary), p.MAX_FILE);
  }
  assert.equal(p.largestQueued(255), -1);
  // Binary frames fit 1.7× more file into the same queue.
  assert.ok(p.largestQueued(150 * 1024 * 1024, true) > 1.7 * p.largestQueued(150 * 1024 * 1024));
});

test("queued bytes are an upper bound for what the server really stores, in text and in binary", async () => {
  // The bug this replaces: 1.4× counted, but text chunks are base64url inside base64url (16/9 = 1.78×), so the
  // server's queue could grant room that the file then overran.
  const key = p.random(32);
  const ids = [p.b64(p.random(16)), `gif:${p.b64(p.random(16))}`, "x".repeat(64)];
  for (const size of [0, 1, 1000, p.CHUNK - 1, p.CHUNK, p.CHUNK + 1, 3 * p.CHUNK + 5, 20 * p.CHUNK]) {
    for (const f of ids) {
      const n = p.chunkCount(size);
      let text = 0;
      let bin = 0;
      for (let i = 0; i < n; i++) {
        const part = p.random(Math.min(p.CHUNK, size - i * p.CHUNK));
        // The largest indices a file of this many chunks could have make the JSON longest.
        const c = await p.sealChunk(key, f, i, n, part);
        text += p.packChunk({ ...c, i: p.MAX_PARTS - 1, n: p.MAX_PARTS }).length;
        bin += p.chunkPayload(c).length;
      }
      assert.ok(text <= p.queuedBytes(size), `text ${size} ${f.length}: ${text} > ${p.queuedBytes(size)}`);
      assert.ok(bin <= p.queuedBytes(size, true), `binary ${size} ${f.length}: ${bin} > ${p.queuedBytes(size, true)}`);
      // ... and not far above it.
      assert.ok(p.queuedBytes(size) - text <= 512 * n, `text ${size}`);
    }
  }
});

test("base64url: the fast codec matches rootcard's and is as strict", () => {
  for (let n = 0; n < 70; n++) {
    const b = p.random(n);
    const s = p.b64(b);
    assert.equal(s, rc.base64urlEncode(b));
    assert.deepEqual(p.unb64(s), b);
  }
  const big = new Uint8Array(300_000).map((_, i) => (i * 7919) & 255);
  assert.deepEqual(p.unb64(p.b64(big)), big);
  // Not base64url, padded, a length of 4k + 1, or unused bits set: refused like rootcard refuses them.
  for (const bad of ["a", "ab=", "ab+c", "ab/c", "ab c", "AB==", "AB", "AAB", "abcde", "\u00e9a", 7]) {
    let mine = null;
    let theirs = null;
    try {
      p.unb64(bad);
    } catch (e) {
      mine = e.code ?? e.message;
    }
    try {
      rc.base64urlDecode(bad);
    } catch (e) {
      theirs = e.code ?? e.message;
    }
    assert.equal(mine === null, theirs === null, `${bad}`);
    if (mine !== null) assert.equal(mine, "bad_base64", `${bad}`);
  }
  assert.deepEqual(p.unb64("AA"), new Uint8Array([0]));
  assert.deepEqual(p.unb64("AAA"), new Uint8Array([0, 0]));
});

test("binary relay frames: chunk payload, frame to the server and frame from it", async () => {
  const key = p.random(32);
  const f = p.b64(p.random(16));
  const c = await p.sealChunk(key, f, 3, 9, p.random(1000));
  const payload = p.chunkPayload(c);
  assert.equal(payload.length, 1 + f.length + 8 + 1016);
  const back = p.parseChunkPayload(payload);
  assert.deepEqual({ ...back, ct: [...back.ct] }, { k: "chunk", f, i: 3, n: 9, ct: [...c.ct] });
  assert.equal(await p.decryptChunk(key, back).then((x) => x.length), 1000);
  // The same chunk as text decrypts the same.
  assert.deepEqual(await p.decryptChunk(key, p.unpack(p.packChunk(c))), await p.decryptChunk(key, back));
  // Ids that do not fit the frame go as text; malformed payloads are refused.
  assert.equal(p.chunkPayload({ ...c, f: "é" }), null);
  assert.equal(p.chunkPayload({ ...c, f: "x".repeat(65) }), null);
  for (const bad of [new Uint8Array(0), new Uint8Array([0]), new Uint8Array([65, 1, 2]), payload.subarray(0, 5)]) {
    assert.equal(p.parseChunkPayload(bad), null);
  }
  // To the server: type, flags, k, ids, ref, ttl, payload.
  const d1 = p.random(16);
  const d2 = p.random(16);
  const ref = p.random(8);
  const frame = p.relayFrame([p.b64(d1), p.b64(d2)], payload, { store: true, ttl: 60, ref });
  assert.deepEqual([...frame.subarray(0, 3)], [1, 1, 2]);
  assert.deepEqual(frame.subarray(3, 19), d1);
  assert.deepEqual(frame.subarray(19, 35), d2);
  assert.deepEqual(frame.subarray(35, 43), ref);
  assert.equal(new DataView(frame.buffer).getUint32(43), 60);
  assert.deepEqual(frame.subarray(47), payload);
  assert.equal(p.relayFrame([p.b64(d1)], payload, { ttl: 60, ref })[1], 0);
  assert.equal(new DataView(p.relayFrame([p.b64(d1)], payload, { ttl: 60, ref }).buffer).getUint32(19 + 8), 0, "ttl only with store");
  assert.equal(p.relayFrame(["short"], payload, { ref }), null);
  assert.equal(p.relayFrame([], payload, { ref }), null);
  assert.equal(p.relayFrame([p.b64(d1)], payload, { ref: p.random(4) }), null);
  // From the server: type, sender, account, queue id, payload.
  const from = p.random(16);
  const account = "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJK";
  const msg = new Uint8Array(1 + 16 + 1 + account.length + 8 + payload.length);
  msg[0] = 2;
  msg.set(from, 1);
  msg[17] = account.length;
  msg.set(new TextEncoder().encode(account), 18);
  new DataView(msg.buffer).setBigInt64(18 + account.length, 42n);
  msg.set(payload, 26 + account.length);
  const got = p.parseDelivered(msg.buffer);
  assert.equal(got.from, p.b64(from));
  assert.equal(got.account, account);
  assert.equal(got.id, 42);
  assert.deepEqual(got.payload, payload);
  new DataView(msg.buffer).setBigInt64(18 + account.length, 0n);
  assert.equal(p.parseDelivered(msg).id, undefined, "live: no queue id");
  assert.equal(p.parseDelivered(new Uint8Array([1, 2, 3])), null);
  msg[0] = 1;
  assert.equal(p.parseDelivered(msg), null);
});

test("relay pacing: live, granted and queued chunks each have their own budget", async () => {
  const s = new Socket("ws://unused", async () => ({}));
  const sent = [];
  s.ready = true;
  s.ws = { send: (x) => sent.push(x), bufferedAmount: 0 };
  await s.onFrame(
    JSON.stringify({ t: "ready", relay: { bytes: 1000, peer: 500, granted: 5000, store: 800, frames: 100, slow_frames: 100, grant: 9999, binary: 1, window: 1 } }),
  );
  clearInterval(s.beat);
  assert.equal(s.relayLimits.binary, true);
  const fast = async (to, len, stored) => {
    const t = Date.now();
    await s.pace(to, len, stored);
    return Date.now() - t < 100;
  };
  // Live into b is used up ...
  s.relay(["b"], "x".repeat(450));
  assert.equal(await fast(["b"], 100), false);
  // ... but once b grants more, chunks to it count against the grant and the granted budget.
  await s.onFrame(JSON.stringify({ t: "relay-grant", to: "b", bytes: 3000, ttl: 60 }));
  s.relayLog = [];
  s.relay(["b"], "x".repeat(450));
  assert.equal(await fast(["b"], 2000), true);
  s.relay(["b"], "x".repeat(2000));
  assert.equal(s.grants.get("b").bytes, 550, "the grant is used up as chunks go");
  // What is left of the grant is too little for this chunk: it is live again, and live into b is spent.
  assert.equal(await fast(["b"], 600), false);
  // Queued chunks have a budget of their own (800), independent of live.
  s.relayLog = [];
  s.relay(["c"], "x".repeat(450));
  assert.equal(await fast(["q"], 700, new Set(["q"])), true);
  s.relayLog.push({ at: Date.now(), len: 700, live: [], granted: [], stored: 1 });
  assert.equal(await fast(["q"], 200, new Set(["q"])), false);
  // A grant of 0 takes it back.
  await s.onFrame(JSON.stringify({ t: "relay-grant", to: "b", bytes: 0, ttl: 60 }));
  assert.equal(s.grants.has("b"), false);
});

test("sendChunk: binary to devices that take it, text to those the server said do not", async () => {
  const s = new Socket("ws://unused", async () => ({}));
  const sent = [];
  s.ready = true;
  s.ws = { send: (x) => sent.push(x), bufferedAmount: 0 };
  await s.onFrame(JSON.stringify({ t: "ready", relay: { bytes: 1e8, peer: 1e8, binary: 1, window: 60 } }));
  clearInterval(s.beat);
  const c = await p.sealChunk(p.random(32), p.b64(p.random(16)), 0, 1, p.random(100));
  const [a, b] = [p.b64(p.random(16)), p.b64(p.random(16))];
  const ref = p.b64(p.random(8));
  assert.equal(await s.sendChunk([a, b], c, { ref }), true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof Uint8Array && sent[0][2] === 2);
  const missed = [];
  s.addEventListener("relay-missed", (e) => missed.push(e.detail));
  await s.onFrame(JSON.stringify({ t: "relay-missed", devices: [b], text: [b], ref }));
  assert.equal(missed.length, 1);
  sent.length = 0;
  await s.sendChunk([a, b], c, { ref });
  assert.equal(sent.length, 2);
  assert.ok(sent[0] instanceof Uint8Array && sent[0][2] === 1);
  const text = JSON.parse(sent[1]);
  assert.deepEqual(text.to, [b]);
  assert.equal(p.unpack(text.data).k, "chunk");
  // On a server without binary frames everything is text.
  await s.onFrame(JSON.stringify({ t: "ready", relay: { bytes: 1e8, peer: 1e8, window: 60 } }));
  clearInterval(s.beat);
  sent.length = 0;
  await s.sendChunk([a, b], c, { ref });
  assert.equal(sent.length, 1);
  assert.equal(typeof sent[0], "string");
  // A stop asked for before a frame sends nothing.
  sent.length = 0;
  assert.equal(await s.sendChunk([a], c, { ref, stop: () => true }), false);
  assert.equal(sent.length, 0);
});

test("live files go up to 1 GiB; only files up to 100 MiB are put together in memory to be shown", () => {
  const MiB = 1024 * 1024;
  assert.equal(p.MAX_FILE, 1024 * MiB);
  assert.equal(p.MAX_PARTS, p.chunkCount(p.MAX_FILE));
  assert.ok(p.MAX_PARTS > 10_000); // past the four digits part keys had
  // The file queue still takes what the server says: its largest file is far below the live limit by default.
  assert.ok(p.largestQueued(50 * MiB) < 50 * MiB);
  assert.equal(p.inlineVideo("video/mp4", 100 * MiB), true);
  assert.equal(p.inlineVideo("video/mp4", 100 * MiB + 1), false);
  assert.equal(p.inlineVideo("application/pdf", 1), false);
  assert.equal(p.inlineImage("image/png", 26 * MiB), false);
});

test("part keys sort in part order, and keys of parts stored before stay the same", () => {
  assert.equal(partKey("t", 0), "t:0000");
  assert.equal(partKey("t", 9999), "t:9999");
  assert.equal(partKey("t", 10_000), "t:~00010000");
  const keys = [];
  for (let i = 0; i < p.MAX_PARTS; i += 7) keys.push(partKey("t", i));
  keys.push(partKey("t", p.MAX_PARTS - 1));
  const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(sorted, keys);
  // All within the range a file's parts are deleted by (`t:` … `t:\uffff`), and not in another tag's.
  for (const k of keys) assert.ok(k > "t:" && k < "t:\uffff");
});

test("socket: a login refused for good is not retried at once; a failing auth does not throw; reconnects are jittered", async () => {
  const s = new Socket("ws://unused", async () => {
    throw new Error("no key");
  });
  const delays = [];
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms) => {
    delays.push(ms);
    return 0;
  };
  try {
    const ws = { send() {}, close() {} };
    // A refusal for good: told once, and the next try waits minutes, not a second.
    const refused = [];
    s.addEventListener("refused", (e) => refused.push(e.detail));
    s.ws = ws;
    await s.onFrame(JSON.stringify({ t: "error", error: "unknown_device" }));
    assert.deepEqual(refused, ["unknown_device"]);
    assert.equal(s.refused, "unknown_device");
    assert.ok(delays.at(-1) >= 150_000 && delays.at(-1) <= 300_000);
    // Focus and visibility do not bring it back; the person asking does.
    s.wake();
    assert.equal(s.ws, null);
    s.connect = () => (s.ws = ws);
    s.wake(true);
    assert.equal(s.ws, ws);
    // A temporary refusal (rate limit, the server's own error) is retried with the normal backoff.
    s.refused = null;
    s.retry = null;
    s.backoff = 1000;
    await s.onFrame(JSON.stringify({ t: "error", error: "internal" }));
    assert.equal(s.refused, null);
    assert.ok(delays.at(-1) >= 500 && delays.at(-1) <= 1000);
    // An auth that throws rejects onFrame (caught by the socket's message handler), it never sends a half login.
    s.ws = ws;
    await assert.rejects(s.onFrame(JSON.stringify({ t: "challenge", nonce: "n" })), /no key/);
  } finally {
    globalThis.setTimeout = realTimeout;
  }
});
