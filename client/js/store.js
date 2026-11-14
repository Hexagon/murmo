// Local storage in IndexedDB, encrypted with the device's local key (docs/DESIGN.md §8). Record keys of contacts and
// messages are opaque tags, so the database files reveal neither contacts nor conversations.

import * as p from "./protocol.js";

const VERSION = 1;

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
  r.onupgradeneeded = () => upgrade(r.result);
  return req(r);
}

// JSON with Uint8Array support, for encrypted records.
function encode(v) {
  return p.utf8(JSON.stringify(v, (_, x) => (x instanceof Uint8Array ? { $b: p.b64(x) } : x)));
}
function decode(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes), (_, x) => (x && typeof x === "object" && typeof x.$b === "string" ? p.unb64(x.$b) : x));
}

/** The list of accounts used in this browser (plain: only ids and handles, so the login screen can offer them). */
export const accounts = {
  async db() {
    return openDb("mesg", (db) => db.createObjectStore("accounts", { keyPath: "account" }));
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
  static async open(account, prefix = "mesg") {
    const db = await openDb(`${prefix}-${account}`, (d) => {
      d.createObjectStore("meta");
      d.createObjectStore("contacts", { keyPath: "k" });
      d.createObjectStore("messages", { keyPath: "k" }).createIndex("c", "c");
      d.createObjectStore("files", { keyPath: "k" });
    });
    return new Store(db, account);
  }

  static async destroy(account, prefix = "mesg") {
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
  async deleteConversation(conv) {
    const c = await this.tag("conv", conv);
    const tx = this.db.transaction("messages", "readwrite");
    const keys = await req(tx.objectStore("messages").index("c").getAllKeys(c));
    for (const k of keys) tx.objectStore("messages").delete(k);
    await done(tx);
  }

  // files
  async file(f) {
    const k = await this.tag("file", f);
    const r = await req(this.db.transaction("files").objectStore("files").get(k));
    return r ? p.decryptLocal(this.key, r.v, `file:${k}`) : undefined;
  }
  async hasFile(f) {
    const k = await this.tag("file", f);
    return (await req(this.db.transaction("files").objectStore("files").count(k))) > 0;
  }
  async putFile(f, bytes) {
    const k = await this.tag("file", f);
    const v = await p.encryptLocal(this.key, bytes, `file:${k}`);
    const tx = this.db.transaction("files", "readwrite");
    tx.objectStore("files").put({ k, v });
    await done(tx);
  }
}
