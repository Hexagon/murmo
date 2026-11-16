// The local store's messages: read back in order, decrypted once and then remembered while their record is unchanged,
// and never a remembered message for a record that was rewritten or deleted.

import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../client/js/store.js";
import * as p from "../client/js/protocol.js";

async function open(name) {
  const store = await Store.open(name, "store-test");
  await store.unlock(p.random(32));
  return store;
}

test("messages come back in order, the same after a second read", async () => {
  const store = await open("order");
  const times = [5, 1, 3, 2, 4];
  for (const [i, time] of times.entries()) await store.putMessage({ id: `m${i}`, conv: "c", time, text: `t${time}`, bytes: p.random(4) });
  await store.putMessage({ id: "other", conv: "d", time: 0, text: "elsewhere" });
  const first = await store.messages("c");
  assert.deepEqual(first.map((m) => m.time), [1, 2, 3, 4, 5]);
  assert.ok(first[0].bytes instanceof Uint8Array);
  assert.equal(store.decrypted.size, 5);
  const second = await store.messages("c");
  assert.deepEqual(second, first);
  // A copy each time: changing what was read changes neither the store nor the next read.
  second[0].text = "changed";
  assert.equal((await store.messages("c"))[0].text, "t1");
  assert.equal((await store.message("m1")).text, "t1");
  store.close();
});

test("a rewritten or deleted message is read anew", async () => {
  const store = await open("rewrite");
  await store.putMessage({ id: "a", conv: "c", time: 1, text: "first" });
  await store.putMessage({ id: "b", conv: "c", time: 2, text: "second" });
  await store.messages("c");
  await store.putMessage({ id: "a", conv: "c", time: 1, text: "edited" });
  assert.deepEqual((await store.messages("c")).map((m) => m.text), ["edited", "second"]);
  await store.deleteMessage("b");
  assert.deepEqual((await store.messages("c")).map((m) => m.id), ["a"]);
  assert.equal(await store.message("b"), undefined);
  assert.equal(await store.pruneConversation("c", 5), 1);
  assert.deepEqual(await store.messages("c"), []);
  assert.equal(store.decrypted.size, 0);
  store.close();
});
