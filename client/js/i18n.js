// The interface's language: German, English, Spanish or Swedish, chosen from the browser's languages (or by the user),
// with English for everything else.
//
// Texts are looked up by key (`t("auth.login")`); a key missing in a language falls back to English. Placeholders are
// written `{name}`. A text for a page element with links or other markup in it marks those children `<0>…</0>`,
// `<1>…</1>`, … in order (translatePage); nothing is ever parsed as HTML.
//
// Times are Unix seconds (UTC) everywhere: on the wire, on the server and in the device's store. They are only turned
// into a local date and time here, with the browser's time zone and the chosen language's conventions.

import sv from "./lang/sv.js";
import en from "./lang/en.js";
import de from "./lang/de.js";
import es from "./lang/es.js";

/** The languages offered, each named in itself. */
export const LANGUAGES = [
  ["de", "Deutsch"],
  ["en", "English"],
  ["es", "Español"],
  ["sv", "Svenska"],
];

export const FALLBACK = "en";
const DICTS = { sv, en, de, es };
const KEY = "murmo-lang";

function stored() {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v && v in DICTS ? v : null;
  } catch {
    return null;
  }
}

function browserTags() {
  const nav = globalThis.navigator;
  return (nav?.languages?.length ? nav.languages : [nav?.language ?? ""]).filter(Boolean);
}

/** The first of `tags` (BCP 47, most wanted first) that we have a language for, else English. */
export function choose(tags) {
  for (const tag of tags) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (base in DICTS) return base;
  }
  return FALLBACK;
}

let lang = stored() ?? choose(browserTags());
let loc = localeFor(lang);

/**
 * The locale for dates and numbers: the browser's own tag when it is in the chosen language (so `en-GB` keeps a
 * 24-hour clock and `es-MX` its own conventions), else the language itself.
 */
function localeFor(l) {
  const tag = browserTags().find((x) => String(x).toLowerCase().split("-")[0] === l);
  try {
    return tag ? Intl.getCanonicalLocales(tag)[0] : l;
  } catch {
    return l;
  }
}

/** The language the user picked on this browser, or null when it follows the browser. */
export function chosenLanguage() {
  return stored();
}

export function language() {
  return lang;
}

export function locale() {
  return loc;
}

/** Choose a language (null: follow the browser again). Remembered on this browser. */
export function setLanguage(l) {
  try {
    if (l && l in DICTS) globalThis.localStorage?.setItem(KEY, l);
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // storage may be unavailable; the choice then lasts for this page only
  }
  lang = l && l in DICTS ? l : choose(browserTags());
  loc = localeFor(lang);
  if (globalThis.document) document.documentElement.lang = lang;
}

/** Whether there is a text for `key`. */
export function has(key) {
  return key in DICTS[lang] || key in DICTS[FALLBACK];
}

/** The text for `key` in the chosen language (English if it has none there), with `{name}` filled in from `vars`. */
export function t(key, vars) {
  const s = DICTS[lang][key] ?? DICTS[FALLBACK][key] ?? key;
  return vars ? fill(s, vars) : s;
}

/** `t` for a count: `key.one` or `key.other` by the language's plural rules, with `{n}` set. */
export function tn(key, n, vars = {}) {
  const form = new Intl.PluralRules(lang).select(n) === "one" ? "one" : "other";
  return t(`${key}.${form}`, { n: num(n), ...vars });
}

function fill(s, vars) {
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** A number written the local way. */
export function num(n, opts) {
  return new Intl.NumberFormat(loc, opts).format(n);
}

// ── times: Unix seconds (UTC) in, local text out ────────────────────────────────────────────────────────────────

const date = (t) => new Date(t * 1000);

/** The machine-readable UTC form of a time, for `<time datetime>`. */
export function iso(t) {
  return date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The local time of day, "14:05" or "2:05 PM". */
export function clock(t) {
  return date(t).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
}

/** The local date and time in full, for a tooltip. */
export function dateTime(t) {
  return date(t).toLocaleString(loc, { dateStyle: "full", timeStyle: "short" });
}

/** The local calendar day of a time, as a key ("2026-11-15"): messages are grouped by it. */
export function dayKey(t) {
  const d = date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** How many local calendar days ago `t` was (0: today, 1: yesterday). */
export function daysAgo(t) {
  const d = date(t);
  const now = new Date();
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 864e5);
}

/** "Today", "Yesterday" or a local date ("15 November", with the year when it is not this year). */
export function dayLabel(t) {
  const ago = daysAgo(t);
  if (ago === 0 || ago === 1) {
    const s = new Intl.RelativeTimeFormat(loc, { numeric: "auto" }).format(-ago, "day");
    return s.charAt(0).toLocaleUpperCase(loc) + s.slice(1);
  }
  const d = date(t);
  return d.toLocaleDateString(loc, { day: "numeric", month: "long", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

// ── the static page ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Translate the page's own markup (index.html): `data-i18n="key"` sets an element's text (its element children, such
 * as links, are kept and filled from `<0>…</0>` in the text), `data-i18n-attr="attr:key;attr:key"` sets attributes.
 */
export function translatePage(doc = document) {
  doc.documentElement.lang = lang;
  for (const el of doc.querySelectorAll("[data-i18n]")) {
    const s = t(el.dataset.i18n);
    el.i18nKids ??= [...el.children];
    if (!el.i18nKids.length) {
      el.textContent = s;
      continue;
    }
    const out = [];
    let at = 0;
    for (const m of s.matchAll(/<(\d+)>(.*?)<\/\1>/gs)) {
      if (m.index > at) out.push(s.slice(at, m.index));
      const kid = el.i18nKids[Number(m[1])];
      if (kid) {
        if (!kid.children.length) kid.textContent = m[2];
        out.push(kid);
      } else out.push(m[2]);
      at = m.index + m[0].length;
    }
    if (at < s.length) out.push(s.slice(at));
    el.replaceChildren(...out);
  }
  for (const el of doc.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.dataset.i18nAttr.split(";")) {
      const [attr, key] = pair.split(":").map((x) => x.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  doc.title = t("page.title");
}

if (globalThis.document) document.documentElement.lang = lang;
