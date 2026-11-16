// The interface's translations: every language has every text, with the same placeholders and markup marks, and every
// key the client uses exists. Times stay UTC until they are shown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sv from "../client/js/lang/sv.js";
import en from "../client/js/lang/en.js";
import de from "../client/js/lang/de.js";
import es from "../client/js/lang/es.js";
import * as i18n from "../client/js/i18n.js";
import * as emoji from "../client/js/emoji.js";

const LANGS = { sv, en, de, es };
const read = (f) => readFileSync(new URL(`../client/${f}`, import.meta.url), "utf8");
const marks = (s) => [...s.matchAll(/\{(\w+)\}|<\/?\d+>/g)].map((m) => m[0]).sort();

test("every language has exactly the English keys", () => {
  const keys = Object.keys(en).sort();
  for (const [name, dict] of Object.entries(LANGS)) {
    assert.deepEqual(Object.keys(dict).sort(), keys, `${name} keys`);
  }
});

test("placeholders and markup marks are the same in every language", () => {
  for (const [key, text] of Object.entries(en)) {
    for (const [name, dict] of Object.entries(LANGS)) {
      assert.deepEqual(marks(dict[key]), marks(text), `${name} ${key}`);
      assert.ok(dict[key].trim(), `${name} ${key} is empty`);
    }
  }
});

test("every key the client uses exists", () => {
  const app = read("js/app.js");
  const used = new Set();
  for (const m of app.matchAll(/\btr\(\s*"([\w.]+)"/g)) used.add(m[1]);
  for (const m of app.matchAll(/\btn\(\s*"([\w.]+)"/g)) used.add(`${m[1]}.one`).add(`${m[1]}.other`);
  // Keys chosen at run time: `tr(cond ? "a" : "b")` and the tables.
  for (const m of app.matchAll(/\btr\(([^()]*\?[^()]*)\)/g)) for (const k of m[1].matchAll(/"([\w]+\.[\w.]+)"/g)) used.add(k[1]);
  for (const m of app.matchAll(/\[\s*[\d *]+,\s*"(ret\.\w+)"\]/g)) used.add(m[1]);
  for (const m of app.matchAll(/"(theme\.\w+)"/g)) used.add(m[1]);
  for (const m of app.matchAll(/"(about\.\d)"/g)) used.add(m[1]);
  for (const m of app.matchAll(/\["((?:help|terms)\.\w+)", (\d+)\]/g)) for (let i = 1; i <= Number(m[2]); i++) used.add(`${m[1]}.${i}`);
  for (const c of emoji.CATEGORIES) used.add(`emoji.${c.id}`);
  const page = read("index.html");
  for (const m of page.matchAll(/data-i18n="([\w.]+)"/g)) used.add(m[1]);
  for (const m of page.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(";")) used.add(pair.split(":")[1]);
  used.add("page.title");
  assert.ok(used.size > 250, `found only ${used.size} keys`);
  for (const k of used) assert.ok(k in en, `missing key ${k}`);
});

test("the error codes the client explains have texts", () => {
  // Codes thrown by the server and the client modules (a sample that must never fall back to "Something went wrong").
  for (const code of ["bad_handle", "unknown_account", "weak_password", "bad_signature", "rate_limited", "offline", "too_large", "gifs_full", "too_late"]) {
    assert.ok(`err.${code}` in en, code);
  }
});

test("the language comes from the browser's list, with English as the fallback", () => {
  assert.equal(i18n.choose(["de-AT", "en"]), "de");
  assert.equal(i18n.choose(["fr-FR", "es-419"]), "es");
  assert.equal(i18n.choose(["sv"]), "sv");
  assert.equal(i18n.choose(["fr", "nl"]), "en");
  assert.equal(i18n.choose([]), "en");
});

test("missing texts fall back to English; counts and placeholders are filled in", () => {
  i18n.setLanguage("de");
  assert.equal(i18n.t("auth.login"), "Anmelden");
  assert.equal(i18n.tn("ret.days", 1), "1 Tag");
  assert.equal(i18n.tn("ret.days", 2), "2 Tage");
  assert.equal(i18n.t("notify.message", { who: "Bob#1A2B" }), "Neue Nachricht von Bob#1A2B");
  assert.equal(i18n.t("no.such.key"), "no.such.key");
  i18n.setLanguage("en");
  assert.equal(i18n.tn("ret.days", 1), "1 day");
  assert.equal(i18n.t("err.gifs_full", { max: 200 }), "The collection is full (at most 200 GIFs). Remove one first.");
  i18n.setLanguage(null);
});

test("times are UTC Unix seconds until shown in local time", () => {
  assert.equal(i18n.iso(0), "1970-01-01T00:00:00Z");
  assert.equal(i18n.iso(1763150000), "2025-11-14T19:53:20Z");
  const now = Math.floor(Date.now() / 1000);
  assert.equal(i18n.daysAgo(now), 0);
  assert.equal(i18n.daysAgo(now - 86400 * 3), 3);
  const local = new Date(1763150000 * 1000);
  assert.equal(i18n.dayKey(1763150000), `${local.getFullYear()}-${local.getMonth() + 1}-${local.getDate()}`);
  for (const l of ["sv", "en", "de", "es"]) {
    i18n.setLanguage(l);
    assert.match(i18n.dayLabel(now), /^\p{Lu}/u, `${l}: today, capitalised`);
    assert.match(i18n.clock(now), /\d/);
  }
  i18n.setLanguage("sv");
  assert.equal(i18n.dayLabel(now), "I dag");
  i18n.setLanguage(null);
});
