// Local storage in IndexedDB, encrypted with the device's local key (docs/DESIGN.md §8). Record keys of contacts and
// messages are opaque tags, so the database files reveal neither contacts nor conversations.

import * as p from "./protocol.js";

const VERSION = 2;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb(name, upgrade) {
  const r = indexedDB.open(name, VERSION);
  r.onupgradeneeded = (e) => upgrade(r.result, e.oldVersion);
  return req(r);
}

/** All keys of one file's parts: `<file tag>:<index>`. */
const partsOf = (k) => IDBKeyRange.bound(`${k}:`, `${k}:\uffff`);
const partKey = (k, i) => `${k}:${String(i).padStart(4, "0")}`;
/**
 * How many parts of a file are written or read in one transaction. One transaction per 48 KB part made a large file
 * take long to store (and to read back) on browsers where each commit waits for the disk.
 */
export const PART_BATCH = 32;

// JSON with Uint8Array support, for encrypted records.
function encode(v) {
  return p.utf8(JSON.stringify(v, (_, x) => (x instanceof Uint8Array ? { $b: p.b64(x) } : x)));
}
function decode(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes), (_, x) => (x && typeof x === "object" && typeof x.$b === "string" ? p.unb64(x.$b) : x));
}

/** IndexedDB names keep the project's old name ("mesg") so that data in browsers that used it stays readable. */
const STORAGE_NAME = "mesg";

/** The list of accounts used in this browser (plain: only ids and handles, so the login screen can offer them). */
export const accounts = {
  async db() {
    return openDb(STORAGE_NAME, (db) => {
      if (!db.objectStoreNames.contains("accounts")) db.createObjectStore("accounts", { keyPath: "account" });
    });
  },
  async all() {
    const db = await this.db();
    try {
      return await req(db.transaction("accounts").objectStore("accounts").getAll());
    } finally {
      db.close();
    }
  },
  async put(rec) {
    const db = await this.db();
    try {
      const tx = db.transaction("accounts", "readwrite");
      tx.objectStore("accounts").put(rec);
      await done(tx);
    } finally {
      db.close();
    }
  },
  async remove(account) {
    const db = await this.db();
    try {
      const tx = db.transaction("accounts", "readwrite");
      tx.objectStore("accounts").delete(account);
      await done(tx);
    } finally {
      db.close();
    }
  },
};

export class Store {
  /** `prefix` separates several devices in one browser profile (tests only). */
  static async open(account, prefix = STORAGE_NAME) {
    const db = await openDb(`${prefix}-${account}`, (d, old) => {
      if (old < 1) {
        d.createObjectStore("meta");
        d.createObjectStore("contacts", { keyPath: "k" });
        d.createObjectStore("messages", { keyPath: "k" }).createIndex("c", "c");
        d.createObjectStore("files", { keyPath: "k" });
      }
      if (old < 2) {
        d.createObjectStore("parts", { keyPath: "k" });
        d.createObjectStore("incoming", { keyPath: "k" });
      }
    });
    return new Store(db, account);
  }

  static async destroy(account, prefix = STORAGE_NAME) {
    await req(indexedDB.deleteDatabase(`${prefix}-${account}`));
  }

  constructor(db, account) {
    this.db = db;
    this.account = account;
    this.key = null;
    this.index = null;
  }

  close() {
    this.db.close();
  }

  /** Unlock with the local secret from the vault and this device's salt (created on first use). */
  async unlock(secret) {
    let salt = await this.meta("salt");
    if (!salt) {
      salt = p.random(16);
      await this.setMeta("salt", salt);
    }
    this.key = await p.localKey(secret, salt);
    this.index = await p.localIndexKey(secret, salt);
  }

  /** Unlock with keys remembered on this device (the user's choice). */
  async unlockRemembered() {
    const r = await this.meta("remembered");
    if (!r?.key || !r?.index) return false;
    this.key = r.key;
    this.index = r.index;
    return true;
  }

  async remember(on) {
    if (on) await this.setMeta("remembered", { key: this.key, index: this.index });
    else await this.deleteMeta("remembered");
  }

  // plain metadata (salt, public device data)
  async meta(k) {
    return req(this.db.transaction("meta").objectStore("meta").get(k));
  }
  async setMeta(k, v) {
    const tx = this.db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(v, k);
    await done(tx);
  }
  async deleteMeta(k) {
    const tx = this.db.transaction("meta", "readwrite");
    tx.objectStore("meta").delete(k);
    await done(tx);
  }

  // encrypted values in meta (private keys)
  async secret(k) {
    const blob = await this.meta(`secret:${k}`);
    return blob ? decode(await p.decryptLocal(this.key, blob, `meta:${k}`)) : undefined;
  }
  async setSecret(k, v) {
    await this.setMeta(`secret:${k}`, await p.encryptLocal(this.key, encode(v), `meta:${k}`));
  }

  async tag(kind, value) {
    return p.indexTag(this.index, `${kind}:${value}`);
  }

  // contacts
  async contacts() {
    const rows = await req(this.db.transaction("contacts").objectStore("contacts").getAll());
    const out = [];
    for (const r of rows) out.push(decode(await p.decryptLocal(this.key, r.v, `contact:${r.k}`)));
    return out;
  }
  async putContact(c) {
    const k = await this.tag("contact", c.account);
    const v = await p.encryptLocal(this.key, encode(c), `contact:${k}`);
    const tx = this.db.transaction("contacts", "readwrite");
    tx.objectStore("contacts").put({ k, v });
    await done(tx);
  }

  // messages
  async messages(conv) {
    const c = await this.tag("conv", conv);
    const rows = await req(this.db.transaction("messages").objectStore("messages").index("c").getAll(c));
    const out = [];
    for (const r of rows) out.push(decode(await p.decryptLocal(this.key, r.v, `message:${r.k}`)));
    return out.sort((a, b) => a.time - b.time || (a.at ?? 0) - (b.at ?? 0) || (a.id < b.id ? -1 : 1));
  }
  /** One message by its id, or undefined. */
  async message(id) {
    const k = await this.tag("message", id);
    const r = await req(this.db.transaction("messages").objectStore("messages").get(k));
    return r ? decode(await p.decryptLocal(this.key, r.v, `message:${k}`)) : undefined;
  }
  async hasMessage(id) {
    const k = await this.tag("message", id);
    return (await req(this.db.transaction("messages").objectStore("messages").count(k))) > 0;
  }
  async putMessage(m) {
    const k = await this.tag("message", m.id);
    const c = await this.tag("conv", m.conv);
    const v = await p.encryptLocal(this.key, encode(m), `message:${k}`);
    const tx = this.db.transaction("messages", "readwrite");
    tx.objectStore("messages").put({ k, c, v });
    await done(tx);
  }
  /** Replace a message by `m` (same id) and delete the file of the message it replaces, in one transaction. */
  async replaceMessage(m, oldFile) {
    const k = await this.tag("message", m.id);
    const c = await this.tag("conv", m.conv);
    const v = await p.encryptLocal(this.key, encode(m), `message:${k}`);
    const fk = typeof oldFile === "string" ? await this.tag("file", oldFile) : null;
    const tx = this.db.transaction(["messages", "files", "parts", "incoming"], "readwrite");
    tx.objectStore("messages").put({ k, c, v });
    if (fk) {
      tx.objectStore("files").delete(fk);
      tx.objectStore("parts").delete(partsOf(fk));
      tx.objectStore("incoming").delete(partsOf(fk));
    }
    await done(tx);
  }
  /** Delete one message record (not its file). */
  async deleteMessage(id) {
    const k = await this.tag("message", id);
    const tx = this.db.transaction("messages", "readwrite");
    tx.objectStore("messages").delete(k);
    await done(tx);
  }
  /** Delete a whole conversation, with the files of its messages. */
  async deleteConversation(conv) {
    await this.pruneConversation(conv, Infinity);
  }
  /**
   * Delete the messages of a conversation sent before `before` (seconds since the epoch), with their files.
   * Returns the number of messages deleted.
   */
  async pruneConversation(conv, before) {
    const c = await this.tag("conv", conv);
    const rows = await req(this.db.transaction("messages").objectStore("messages").index("c").getAll(c));
    const keys = [];
    const files = [];
    for (const r of rows) {
      const m = decode(await p.decryptLocal(this.key, r.v, `message:${r.k}`));
      if (!(m.time < before)) continue;
      keys.push(r.k);
      if (typeof m.file?.f === "string") files.push(await this.tag("file", m.file.f));
    }
    if (!keys.length) return 0;
    // Tags are computed first: a transaction ends at the first await on anything but itself.
    const tx = this.db.transaction(["messages", "files", "parts"], "readwrite");
    for (const k of keys) tx.objectStore("messages").delete(k);
    for (const k of files) {
      tx.objectStore("files").delete(k);
      tx.objectStore("parts").delete(partsOf(k));
    }
    await done(tx);
    return keys.length;
  }

  // files
  //
  // A file is stored in parts of p.CHUNK bytes (`parts`, each encrypted on its own) under a header in `files`
  // (`{ k, n, size }`), written last: a file exists once its header does. Files stored before version 2 are one
  // record `{ k, v }` in `files`. Chunks that arrive before their `file` message are kept in `incoming` until it does.

  async fileHeader(f) {
    const k = await this.tag("file", f);
    const r = await req(this.db.transaction("files").objectStore("files").get(k));
    return r ? { k, ...r } : undefined;
  }
  /** A function `(i) => bytes of part i` for a stored file, or undefined. */
  async fileReader(f) {
    const r = await this.fileHeader(f);
    if (!r) return undefined;
    if (r.v) {
      const whole = await p.decryptLocal(this.key, r.v, `file:${r.k}`);
      return Object.assign((i) => whole.subarray(i * p.CHUNK, (i + 1) * p.CHUNK), { n: p.chunkCount(whole.length), size: whole.length });
    }
    // Parts are read PART_BATCH at a time: reading part i also reads the parts after it in the same block.
    let block = null; // { from, parts: Promise<Array<Uint8Array|undefined>> }
    const read = (i) => {
      if (!Number.isSafeInteger(i) || i < 0 || i >= r.n) return Promise.resolve(undefined);
      const from = i - (i % PART_BATCH);
      if (block?.from !== from) {
        const b = { from, parts: this.partsByTag(r.k, from, Math.min(PART_BATCH, r.n - from)) };
        b.parts.catch(() => { if (block === b) block = null; });
        block = b;
      }
      return block.parts.then((xs) => xs[i - from]);
    };
    return Object.assign(read, { n: r.n, size: r.size });
  }
  /** The whole file (tests, small files). */
  async file(f) {
    const parts = await this.fileParts(f);
    if (!parts) return undefined;
    const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
    let o = 0;
    for (const x of parts) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  }
  /** The parts of a file, in order (a `Blob` can be made of them without joining them first). */
  async fileParts(f) {
    const read = await this.fileReader(f);
    if (!read) return undefined;
    const out = [];
    for (let i = 0; i < read.n; i++) {
      const x = await read(i);
      if (!x) return undefined;
      out.push(x);
    }
    return out;
  }
  /** Up to `max` bytes from the start of a file. */
  async fileHead(f, max) {
    const read = await this.fileReader(f);
    if (!read) return undefined;
    const out = [];
    let got = 0;
    for (let i = 0; i < read.n && got < max; i++) {
      const x = await read(i);
      if (!x) break;
      out.push(x);
      got += x.length;
    }
    const b = new Uint8Array(Math.min(got, max));
    let o = 0;
    for (const x of out) {
      b.set(x.subarray(0, b.length - o), o);
      o += Math.min(x.length, b.length - o);
    }
    return b;
  }
  async hasFile(f) {
    const k = await this.tag("file", f);
    return (await req(this.db.transaction("files").objectStore("files").count(k))) > 0;
  }
  /** Store a whole file (in parts). */
  async putFile(f, bytes) {
    const n = p.chunkCount(bytes.length);
    for (let from = 0; from < n; from += PART_BATCH) {
      const parts = [];
      for (let i = from; i < Math.min(n, from + PART_BATCH); i++) parts.push(bytes.subarray(i * p.CHUNK, (i + 1) * p.CHUNK));
      await this.putParts(f, from, parts);
    }
    await this.finishFile(f, n, bytes.length);
  }
  async putPart(f, i, bytes) {
    await this.putParts(f, i, [bytes]);
  }
  /** Store parts `first`, `first + 1`, … of a file in one transaction. */
  async putParts(f, first, parts) {
    const k = await this.tag("file", f);
    const t = Date.now();
    const rows = await Promise.all(
      parts.map(async (bytes, j) => {
        const pk = partKey(k, first + j);
        return { k: pk, t, v: await p.encryptLocal(this.key, bytes, `part:${pk}`) };
      }),
    );
    const tx = this.db.transaction("parts", "readwrite");
    const store = tx.objectStore("parts");
    for (const row of rows) store.put(row);
    await done(tx);
  }
  async part(f, i) {
    return this.partByTag(await this.tag("file", f), i);
  }
  async partByTag(k, i) {
    const pk = partKey(k, i);
    const r = await req(this.db.transaction("parts").objectStore("parts").get(pk));
    return r ? p.decryptLocal(this.key, r.v, `part:${pk}`) : undefined;
  }
  /** Parts `from` … `from + count - 1` of a file (undefined for a missing one), read in one transaction. */
  async partsByTag(k, from, count) {
    const keys = Array.from({ length: count }, (_, j) => partKey(k, from + j));
    const range = IDBKeyRange.bound(keys[0], keys[count - 1]);
    const rows = await req(this.db.transaction("parts").objectStore("parts").getAll(range));
    const byKey = new Map(rows.map((r) => [r.k, r.v]));
    return Promise.all(keys.map((pk) => (byKey.has(pk) ? p.decryptLocal(this.key, byKey.get(pk), `part:${pk}`) : undefined)));
  }
  /** Mark a file complete once all its parts are stored. */
  async finishFile(f, n, size) {
    const k = await this.tag("file", f);
    const tx = this.db.transaction("files", "readwrite");
    tx.objectStore("files").put({ k, n, size });
    await done(tx);
  }
  /** Delete a file: its header, its parts and anything still incoming for it. */
  async deleteFile(f) {
    const k = await this.tag("file", f);
    const tx = this.db.transaction(["files", "parts", "incoming"], "readwrite");
    tx.objectStore("files").delete(k);
    tx.objectStore("parts").delete(partsOf(k));
    tx.objectStore("incoming").delete(partsOf(k));
    await done(tx);
  }

  // chunks that came before their `file` message: `{ n, c }` with `c` still encrypted with the file key
  async putIncoming(f, i, chunk) {
    const k = partKey(await this.tag("file", f), i);
    const v = await p.encryptLocal(this.key, encode(chunk), `incoming:${k}`);
    const tx = this.db.transaction("incoming", "readwrite");
    tx.objectStore("incoming").put({ k, t: Date.now(), v });
    await done(tx);
  }
  async incoming(f, i) {
    const k = partKey(await this.tag("file", f), i);
    const r = await req(this.db.transaction("incoming").objectStore("incoming").get(k));
    return r ? decode(await p.decryptLocal(this.key, r.v, `incoming:${k}`)) : undefined;
  }
  async deleteIncoming(f) {
    const k = await this.tag("file", f);
    const tx = this.db.transaction("incoming", "readwrite");
    tx.objectStore("incoming").delete(partsOf(k));
    await done(tx);
  }
  /**
   * Delete what an interrupted transfer left behind: incoming chunks, and parts of files that never got a header,
   * last written before `before` (milliseconds since the epoch).
   */
  async sweepParts(before) {
    const tx = this.db.transaction(["files", "parts", "incoming"], "readwrite");
    const files = tx.objectStore("files");
    const sweep = (store, orphanOnly) =>
      new Promise((resolve, reject) => {
        const r = tx.objectStore(store).openCursor();
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const c = r.result;
          if (!c) return resolve();
          if (c.value.t < before) {
            if (!orphanOnly) c.delete();
            else {
              const head = files.count(c.value.k.slice(0, c.value.k.lastIndexOf(":")));
              head.onsuccess = () => head.result || tx.objectStore(store).delete(c.value.k);
            }
          }
          c.continue();
        };
      });
    await Promise.all([sweep("incoming", false), sweep("parts", true), done(tx)]);
  }
}
