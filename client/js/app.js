// The user interface. Everything is built with DOM nodes and textContent: no HTML strings, no innerHTML.

import * as p from "./protocol.js";
import { Api, ApiError } from "./api.js";
import * as id from "./identity.js";
import { EPHEMERAL_TTLS, GIF_MAX_BYTES, GIF_MAX_COUNT, Messenger, Store, setupDevice, validRetention } from "./core.js";
import * as emoji from "./emoji.js";
import * as giphy from "./giphy.js";
import { accounts } from "./store.js";
import * as notify from "./notify.js";
import "./install.js";
import * as i18n from "./i18n.js";
import { has, t as tr, tn } from "./i18n.js";
import * as rc from "../vendor/rootcard/src/index.js";

const api = new Api(location.origin);
const root = document.getElementById("app");
let messenger = null;
let session = null; // { token, home } while a rootcard session exists
let info = null; // what this server accepts (GET /api/v1/info)
let current = null; // open conversation (account id)
// Search (DESIGN.md §6.9): the query in the sidebar, and a message to show when its conversation opens.
let search = "";
let jumpTo = null;
const objectUrls = new Map();
/**
 * The open conversation's rendered messages, by id: `{ sig, node }`. A message whose `sig` is unchanged keeps its node
 * on the next render, so pictures and GIFs are not loaded again (and do not blink) each time something changes.
 */
const msgNodes = new Map();
/**
 * The open conversation's pictures and the videos being played, by file id: the node is moved into a rebuilt message
 * rather than made again (so a video goes on playing when a reaction comes).
 */
const imgNodes = new Map();
/** The size of pictures seen (file id → { width, height }), to give an <img> its place before it has loaded. */
const imgSizes = new Map();
/** Outgoing files on their way: message id → share sent (0…1). */
const sending = new Map();
// Texts waiting for "Ångra" (DESIGN.md §6.6), by the message id they will be sent with: `{ m, fire, undo }`. They
// are shown in the thread like sent messages. When the page is hidden (another app on a phone, a closed tab) they
// are sent at once rather than lost.
const heldMsgs = new Map();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") for (const e of [...heldMsgs.values()]) e.fire();
});

// ── tiny DOM helpers ────────────────────────────────────────────────────────────────────────────────────────────

/** `el.replaceChildren` without null, undefined or false children. */
function put(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

/**
 * Make `el`'s children `nodes`, touching only what differs: nodes kept in their order are not moved, so a picture or
 * GIF already shown is not taken out of the page and put back (which can make it blink or start over).
 */
function reconcile(el, nodes) {
  const keep = new Set(nodes);
  let at = el.firstChild;
  for (const n of nodes) {
    while (at && !keep.has(at)) {
      const next = at.nextSibling;
      at.remove();
      at = next;
    }
    if (n === at) at = at.nextSibling;
    else el.insertBefore(n, at);
  }
  while (at) {
    const next = at.nextSibling;
    at.remove();
    at = next;
  }
}

/** Properties `h` never sets: they take markup, or run what they are given. */
const NO_PROPS = new Set(["innerhtml", "outerhtml", "srcdoc", "insertadjacenthtml"]);
/** Attributes that load or open a URL; `h` lets them name only this origin, a blob of it or an https page. */
const URL_PROPS = new Set(["href", "src", "action", "formaction", "poster", "data", "xlink:href", "ping", "background", "cite"]);

/** `v` if it is a URL `h` may put in an attribute (see URL_PROPS); throws otherwise (`javascript:`, `data:`, …). */
function safeUrl(k, v) {
  const s = String(v);
  let u;
  try {
    u = new URL(s, location.href);
  } catch {
    throw new TypeError(`h: ${k} is not a URL`);
  }
  const ok =
    u.origin === location.origin && (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "blob:")
      ? true
      : u.protocol === "https:" && k === "href"; // a link to another site (opened with rel=noopener), never a resource
  if (!ok) throw new TypeError(`h: ${k} may not be ${u.protocol} here`);
  return s;
}

/**
 * Make an element. `props` must be written in the code, never taken from data: `on…` keys add listeners, and
 * the rest become attributes or properties. As a second line of defence it refuses markup properties (innerHTML,
 * srcdoc, …), non-function `on…` values, and URL attributes outside this origin's own pages and blobs (only an
 * https `href` may lead elsewhere). Text from others goes in as `text` or as children, which are always text nodes.
 */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    const lk = k.toLowerCase();
    if (NO_PROPS.has(lk)) throw new TypeError(`h: ${k} is not allowed`);
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") el.style.cssText = v; // CSSOM, allowed by the CSP (no style attributes)
    else if (lk.startsWith("on")) {
      if (typeof v !== "function") throw new TypeError(`h: ${k} must be a function`);
      el.addEventListener(lk.slice(2), v);
    } else if (URL_PROPS.has(lk)) el.setAttribute(k, safeUrl(lk, v));
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const ICONS = {
  send: "M4 12l16-8-6 16-2-7-8-1z",
  play: "M8 5v14l11-7z",
  clip: "M16 7l-7.5 7.5a2.5 2.5 0 0 0 3.5 3.5L19.5 10.5a4.5 4.5 0 0 0-6.4-6.4L5.6 11.6a6.5 6.5 0 0 0 9.2 9.2L20 15.6",
  menu: "M4 6h16M4 12h16M4 18h16",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  back: "M15 5l-7 7 7 7",
  plus: "M12 5v14M5 12h14",
  ring: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17z",
  ringCheck: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17zM8 12.4l2.7 2.7L16 9.6",
  close: "M6 6l12 12M18 6L6 18",
  smile: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17zM8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01",
  clock: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17zM12 7.5V12l3 2",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  bellOff: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0M3 3l18 18",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13zM15.5 15.5L20 20",
  timer: "M12 6a7.5 7.5 0 1 0 0 15a7.5 7.5 0 0 0 0-15zM12 9.5v4l2.5 1.5M10 2.5h4M18.5 6.5l1.5-1.5",
};

/** An icon of ICONS; one given a `size` other than the default is decoration (aria-hidden). */
function icon(name, size = 18) {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  if (size !== 18) s.setAttribute("aria-hidden", "true");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.8");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name]);
  s.append(path);
  return s;
}

/** Whether the device has a pointer that hovers: focusing a field there does not open an on-screen keyboard. */
function canHover() {
  return matchMedia("(hover: hover)").matches;
}

/** Disable `btn` and show a spinner with `text` in it; returns a function that puts the button back. */
function busy(btn, text) {
  const label = [...btn.childNodes];
  btn.disabled = true;
  btn.replaceChildren(h("span", { class: "spinner" }), text);
  return () => {
    btn.disabled = false;
    btn.replaceChildren(...label);
  };
}

function copyHandle() {
  return navigator.clipboard?.writeText(messenger.handle).then(() => toast(tr("common.handleCopied")));
}

function say(err) {
  const code = err instanceof ApiError ? err.code : (err?.code ?? err?.message ?? String(err));
  return has(`err.${code}`) ? tr(`err.${code}`, { max: GIF_MAX_COUNT }) : tr("err.unknown", { code });
}

function toast(text) {
  let box = document.querySelector(".toasts");
  if (!box) document.body.append((box = h("div", { class: "toasts" })));
  const t = h("div", { class: "toast", text });
  box.append(t);
  setTimeout(() => t.remove(), 4500);
}

function dialog(...children) {
  const d = h("dialog", {}, ...children);
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

/** Choices for how long a conversation's messages are kept (seconds; 0: until the conversation is deleted). */
const RETENTIONS = [
  [0, "ret.forever"],
  [3600, "ret.hour"],
  [86400, "ret.day"],
  [7 * 86400, "ret.week"],
  [30 * 86400, "ret.30days"],
  [365 * 86400, "ret.year"],
];

function retentionLabel(r) {
  const key = RETENTIONS.find(([s]) => s === r)?.[1];
  return key ? tr(key) : tn("ret.days", Math.round(r / 86400));
}

function splitHandle(handle) {
  const i = handle.lastIndexOf("#");
  return i < 0 ? [handle, ""] : [handle.slice(0, i), handle.slice(i)];
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const b = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : tr("common.browser");
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? tr("common.deviceOn", { browser: b, os }) : b;
}

/** The server's limit on one queued file, in queued bytes (`/api/v1/info`), or null when it gives none. */
function queueLimit() {
  const l = info?.file_queue_limits?.file;
  return info?.file_queue && Number.isSafeInteger(l) && l >= 0 ? l : null;
}

/** The largest file the server's queue takes (null: no known limit), and -1 if none. */
function queueMaxFile() {
  const l = queueLimit();
  return l === null ? null : p.largestQueued(l);
}

function bytes(n) {
  if (n < 1024) return `${i18n.num(n)} B`;
  if (n < 1024 * 1024) return `${i18n.num(n / 1024, { maximumFractionDigits: 0 })} kB`;
  return `${i18n.num(n / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

// Times are Unix seconds (UTC) everywhere; they become local time only when shown (i18n.js).
const clock = i18n.clock;
const dayLabel = i18n.dayLabel;

/** A message's time: local text, with the UTC time for machines and the full local date and time on hover. */
function timeView(t) {
  return h("time", { datetime: i18n.iso(t), title: i18n.dateTime(t), text: clock(t) });
}

/** When a device was last connected, for the device list (`undefined`: not known). */
function lastSeen(t) {
  if (t === undefined) return tr("seen.unknown");
  if (t === 0) return tr("seen.now");
  const ago = i18n.daysAgo(t);
  const s = ago === 0 ? tr("seen.today", { time: clock(t) }) : ago === 1 ? tr("seen.yesterday", { time: clock(t) }) : tr("seen.date", { date: dayLabel(t) });
  const days = Math.floor((Date.now() / 1000 - t) / 86400);
  return days >= 2 ? `${s} (${tn("seen.ago", days)})` : s;
}

// ── settings of this browser, per account ───────────────────────────────────────────────────────────────────────

// notify: on unless the user turns it off (the browser still asks for its permission, see askNotifications).
// undoSend: a text waits UNDO_SEND ms before it is encrypted and sent, and can be taken back in that time.
const DEFAULTS = { notify: true, fileQueue: true, notifyPrompted: false, undoSend: true };
const UNDO_SEND = 5000;

function settings() {
  try {
    // `mesg-…`: the key under the project's old name, read until the setting is saved again.
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(`murmo-settings:${messenger?.me.account}`) ?? localStorage.getItem(`mesg-settings:${messenger?.me.account}`) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function setSetting(k, v) {
  try {
    localStorage.setItem(`murmo-settings:${messenger.me.account}`, JSON.stringify({ ...settings(), [k]: v }));
  } catch {
    // storage may be unavailable; the setting then keeps its default
  }
}

// ── theme: auto (system), light or dark ─────────────────────────────────────────────────────────────────────────

const THEMES = [["auto", "theme.auto"], ["light", "theme.light"], ["dark", "theme.dark"]];

function theme() {
  try {
    // `mesg-theme`: the key under the project's old name.
    return localStorage.getItem("murmo-theme") || localStorage.getItem("mesg-theme") || "auto";
  } catch {
    return "auto";
  }
}

function setTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem("murmo-theme", t);
  } catch {
    // storage may be unavailable; the choice then lasts for this page only
  }
}

function themePicker() {
  const box = h("div", { class: "theme", role: "radiogroup", "aria-label": tr("theme.label") });
  const render = () =>
    put(
      box,
      THEMES.map(([v, label]) =>
        h("button", { class: theme() === v ? "on" : "", role: "radio", "aria-checked": String(theme() === v), text: tr(label), onclick: () => { setTheme(v); render(); } }),
      ),
    );
  render();
  return box;
}

setTheme(theme());

// ── language ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A share (0…1) as a local percentage. */
function percent(share) {
  return i18n.num(share, { style: "percent", maximumFractionDigits: 0 });
}

/** The language of the interface ("Auto": the browser's); `redraw` shows the current screen again in the new one. */
function languagePicker(redraw) {
  const chosen = i18n.chosenLanguage() ?? "";
  const select = h(
    "select",
    {
      class: "input lang",
      "aria-label": tr("common.language"),
      onchange: () => {
        i18n.setLanguage(select.value || null);
        i18n.translatePage();
        redraw();
      },
    },
    h("option", { value: "", text: "Auto", selected: !chosen }),
    i18n.LANGUAGES.map(([code, name]) => h("option", { value: code, lang: code, text: name, selected: chosen === code })),
  );
  return select;
}

/** The host of a rootcard home, for showing; "" for this server's own home. */
function homeLabel(home) {
  return !home || home === api.base ? "" : hostOf(home);
}

// ── how it works ────────────────────────────────────────────────────────────────────────────────────────────────

const FACTS = ["about.1", "about.2", "about.3", "about.4", "about.5"];

/** The short version, for the empty conversation list and the settings. */
function about() {
  return h(
    "div",
    { class: "about" },
    h("ul", {}, FACTS.map((k) => h("li", { text: tr(k) }))),
    h("button", { class: "link", type: "button", text: tr("about.more"), onclick: showHelp }),
  );
}

/** The sections of the help: a title key and how many points it has (`help.crypto.1`, `help.crypto.2`, …). */
const HELP = [
  ["help.crypto", 3],
  ["help.identity", 5],
  ["help.server", 4],
  ["help.undo", 4],
  ["help.files", 4],
  ["help.notify", 3],
  ["help.device", 3],
  ["help.limits", 3],
];

/** "Version 0.1.0 · commit 1a2b3c4d5e6f", linking to the source of that commit; null if the server does not say. */
function versionLine() {
  if (typeof info?.version !== "string") return null;
  const commit = /^[0-9a-f]{7,40}$/.test(info.commit ?? "") ? info.commit : null;
  const source = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(info.source ?? "") ? info.source : null;
  const short = commit?.slice(0, 12);
  return h(
    "p",
    { class: "hint version" },
    tr("help.version", { version: info.version }),
    commit ? " · commit " : null,
    commit && source ? h("a", { href: `${source}/commit/${commit}`, target: "_blank", rel: "noopener noreferrer", text: short }) : short,
  );
}

function showHelp() {
  const d = dialog(
    h("h2", { text: tr("help.title") }),
    h(
      "div",
      { class: "help" },
      HELP.map(([title, n]) => h("section", {}, h("h3", { text: tr(title) }), h("ul", {}, Array.from({ length: n }, (_, i) => h("li", { text: tr(`${title}.${i + 1}`) }))))),
    ),
    versionLine(),
    h("div", { class: "actions" }, h("button", { class: "btn", text: tr("common.close"), onclick: () => d.close() })),
  );
  d.classList.add("wide");
  d.scrollTop = 0;
}

/**
 * The page is a product page with the login card in it (index.html); once the user is past the login, the app takes
 * the whole window and the page around it is hidden.
 */
function inApp(on) {
  if (document.body.classList.contains("in-app") === on) return;
  document.body.classList.toggle("in-app", on);
  document.body.classList.toggle("landing", !on);
  window.scrollTo(0, 0);
}

// ── start ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function boot() {
  i18n.translatePage();
  try {
    await rc.checkSupport(); // throws unsupported_browser
  } catch {
    root.replaceChildren(h("div", { class: "center" }, h("div", { class: "auth card", text: tr("err.unsupported_browser") })));
    return;
  }
  info = await api.info();
  const origins = info.origins ?? (info.origin ? [info.origin] : []);
  if (origins.length && !origins.includes(location.origin)) {
    // The server signs and checks everything for its configured origin (MURMO_ORIGIN): proofs to it and the
    // WebSocket would fail here in confusing ways, so say what is wrong instead.
    root.replaceChildren(h("div", { class: "center" }, h("div", { class: "auth card" },
      h("p", { text: tr("boot.wrongOrigin", { origin: info.origin, here: location.origin }) }),
      h("p", { class: "hint", text: tr("boot.wrongOriginHint") }),
    )));
    return;
  }
  // A device remembered by the user's choice opens without the password.
  for (const a of await accounts.all()) {
    if (!a.remembered) continue;
    try {
      const store = await Store.open(a.account);
      if (await store.unlockRemembered()) {
        await enter({ store, account: a.account, handle: a.handle, home: a.home ?? api.base });
        return;
      }
      store.close();
    } catch {
      // fall through to the login screen
    }
  }
  showAuth();
}

// ── authentication screens ──────────────────────────────────────────────────────────────────────────────────────

function showAuth(tab = "login", prefill = "") {
  const err = h("div", { class: "error" });
  const body = h("div");
  const tabs = h(
    "div",
    { class: "tabs", role: "tablist" },
    h("button", { class: tab === "login" ? "on" : "", text: tr("auth.login"), onclick: () => showAuth("login") }),
    h("button", { class: tab === "register" ? "on" : "", text: tr("auth.register"), onclick: () => showAuth("register") }),
  );
  inApp(false);
  root.replaceChildren(
    h(
      "div",
      { class: "auth" },
      h("div", { class: "card" }, tabs, body, err),
      h(
        "div",
        { class: "auth-foot" },
        h("button", { class: "link", type: "button", text: tr("about.more"), onclick: showHelp }),
        themePicker(),
        languagePicker(() => showAuth(tab)),
      ),
    ),
  );
  if (tab === "login") loginForm(body, err, prefill);
  else registerForm(body, err);
}

function allowedHomes() {
  const homes = info?.homes ?? [];
  if (homes.includes("*")) return tr("auth.anyHome");
  return homes.map((h) => homeLabel(h) || h).join(", ");
}

async function loginForm(body, err, prefill) {
  const known = await accounts.all();
  const remote = h("input", { class: "input", placeholder: "rootcard.org", spellcheck: "false", autocomplete: "off" });
  let where = "local";
  const remoteField = h("div", { class: "field hidden" }, h("label", { text: tr("auth.remoteLabel") }), remote, h("div", { class: "hint", text: tr("auth.remoteHint", { homes: allowedHomes() || tr("auth.noOtherHome") }) }));
  const seg = h("div", { class: "seg" });
  const setWhere = (w) => {
    where = w;
    remoteField.classList.toggle("hidden", w !== "remote");
    put(
      seg,
      h("button", { type: "button", class: w === "local" ? "on" : "", text: tr("auth.thisServer"), onclick: () => setWhere("local") }),
      (info?.homes ?? []).length ? h("button", { type: "button", class: w === "remote" ? "on" : "", text: tr("auth.otherServer"), onclick: () => { setWhere("remote"); remote.focus(); } }) : null,
    );
  };
  setWhere("local");
  const handle = h("input", { class: "input", autocomplete: "username", placeholder: tr("common.handlePlaceholder"), value: prefill, spellcheck: "false" });
  const pw = h("input", { class: "input", type: "password", autocomplete: "current-password" });
  const remember = h("input", { type: "checkbox" });
  const btn = h("button", { class: "btn primary", type: "submit", text: tr("auth.login") });
  const chips = known.length
    ? h(
        "div",
        { class: "accounts" },
        known.map((a) =>
          h("button", {
            class: "chip",
            type: "button",
            text: a.handle + (homeLabel(a.home) ? ` · ${homeLabel(a.home)}` : ""),
            onclick: () => {
              handle.value = a.handle;
              if (homeLabel(a.home)) {
                remote.value = a.home;
                setWhere("remote");
              } else setWhere("local");
              pw.focus();
            },
          }),
        ),
      )
    : null;
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const restore = busy(btn, tr("common.unlocking"));
        try {
          await loginAndEnter(where === "remote" ? remote.value : "", handle.value.trim(), pw.value, remember.checked);
        } catch (x) {
          err.textContent = say(x);
          restore();
        }
      },
    },
    chips,
    h("div", { class: "field" }, h("label", { text: tr("auth.where") }), seg),
    remoteField,
    h("div", { class: "field" }, h("label", { text: tr("common.handle") }), handle),
    h("div", { class: "field" }, h("label", { text: tr("common.password") }), pw),
    h(
      "label",
      { class: "check" },
      remember,
      h(
        "span",
        {},
        tr("auth.remember"),
        h("span", { class: "hint", style: "display:block", text: tr("auth.rememberHint") }),
      ),
    ),
    btn,
  );
  body.replaceChildren(form);
  // Not on touch (it would open the keyboard), and without scrolling the start page down to the form.
  if (canHover()) (prefill ? pw : handle).focus({ preventScroll: true });
}

function registerForm(body, err) {
  const user = h("input", { class: "input", autocomplete: "username", placeholder: tr("auth.userPlaceholder"), spellcheck: "false" });
  const pw = h("input", { class: "input", type: "password", autocomplete: "new-password" });
  const pw2 = h("input", { class: "input", type: "password", autocomplete: "new-password" });
  const btn = h("button", { class: "btn primary", type: "submit", text: tr("common.continue") });
  body.replaceChildren(
    h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = "";
          if (pw.value !== pw2.value) return (err.textContent = tr("auth.mismatch"));
          const restore = busy(btn, tr("auth.makingKeys"));
          try {
            const reg = await id.prepareRegistration(api, user.value.trim(), pw.value);
            showCard(reg, pw.value);
          } catch (x) {
            err.textContent = say(x);
            restore();
          }
        },
      },
      h("div", { class: "field" }, h("label", { text: tr("auth.username") }), user),
      h("div", { class: "field" }, h("label", { text: tr("auth.passwordMin") }), pw),
      h("div", { class: "field" }, h("label", { text: tr("auth.repeat") }), pw2),
      h("p", { class: "hint", text: tr("auth.handleHint") }),
      (info?.homes ?? []).length ? h("p", { class: "hint", text: tr("auth.haveIdentity", { homes: allowedHomes() }) }) : null,
      btn,
    ),
  );
  if (canHover()) user.focus({ preventScroll: true });
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function showCard(reg, password) {
  const err = h("div", { class: "error" });
  const saved = h("input", { type: "checkbox" });
  const go = h("button", { class: "btn primary", text: tr("auth.register"), disabled: true });
  saved.addEventListener("change", () => (go.disabled = !saved.checked));
  const base = `${reg.card.username}-${reg.account.slice(0, 4)}`;
  go.addEventListener("click", async () => {
    const restore = busy(go, tr("card.creating"));
    try {
      const done = await reg.finish();
      await loginAndEnter("", done.handle, password, false);
    } catch (x) {
      err.textContent = say(x);
      restore();
    }
  });
  inApp(true);
  root.replaceChildren(
    h(
      "div",
      { class: "center" },
      h(
        "div",
        { class: "auth", style: "width:min(560px,100%)" },
        h("h1", { class: "brand", text: tr("card.title") }),
        h(
          "div",
          { class: "card" },
          h("p", { text: tr("card.intro") }),
          h("pre", { class: "cardtext", text: reg.cardText }),
          h(
            "div",
            { style: "display:flex;gap:8px;flex-wrap:wrap" },
            h("button", { class: "btn", text: tr("card.downloadFile"), onclick: () => download(`${base}.rootcard-card.json`, new Blob([rc.canonicalString(reg.card)], { type: "application/json" })) }),
            h("button", { class: "btn", text: tr("common.downloadText"), onclick: () => download(`${base}.rootcard-card.txt`, new Blob([reg.cardText], { type: "text/plain" })) }),
            h("button", { class: "btn ghost", text: tr("common.print"), onclick: () => print() }),
          ),
          h("label", { class: "check" }, saved, h("span", { text: tr("card.saved") })),
          go,
          err,
        ),
      ),
    ),
  );
}

async function loginAndEnter(homeInput, handle, password, remember) {
  let home = await id.resolveHome(api, homeInput);
  let login;
  try {
    login = await id.login(api, home, handle, password);
  } catch (x) {
    // An identity made on this server before it moved to a new domain has its home at the old address.
    const old = (info.origins ?? []).filter((o) => o !== location.origin).map((o) => `${o}/id`);
    if (homeInput.trim() || x?.code !== "not_home" || !old.length) throw x;
    login = await loginAtOldHome(old, handle, password, x);
    home = login.home;
  }
  let secret;
  try {
    const account = login.state.account;
    if (home !== api.base) await api.connect(account, home); // the server fetches and verifies the log at that home
    secret = await id.localSecret(api, login);
    const store = await Store.open(account);
    await store.unlock(secret);
    let setup;
    try {
      // The secret stays until the device is set up: a paper key needs it (docs/DESIGN.md §4.5).
      setup = await setupDevice({ api, store, state: login.state, login, label: deviceLabel(), secret });
    } catch (x) {
      store.close();
      throw x;
    }
    session = { token: login.token, home };
    let how = "linked";
    if (!setup.ready) {
      how = await showLinkWait(setup, login.state.handle, home);
      if (!how) {
        store.close();
        showAuth("login", login.state.handle);
        return;
      }
    }
    // Only a device that is part of the account is remembered: a failed or cancelled link must not leave a device
    // that opens without the password but can never connect.
    await store.remember(remember);
    await accounts.put({ account, handle: login.state.handle, home, remembered: remember });
    await enter({ store, account, handle: login.state.handle, home });
    if (how === "paper") showAfterPaperKey();
  } finally {
    secret?.fill(0);
    login.unlocked.contents.accountSeed.fill(0);
    login.unlocked.vaultKey?.fill?.(0);
  }
}

async function loginAtOldHome(homes, handle, password, first) {
  for (const h of homes) {
    try {
      return await id.login(api, h, handle, password);
    } catch (x) {
      if (x?.code !== "not_home" && x?.code !== "unknown_account") throw x;
    }
  }
  throw first;
}

/**
 * The link screen. Resolves to "linked" once another device approved, "paper" when the user's paper key added the
 * device, or false when cancelled.
 */
function showLinkWait(setup, handle, home) {
  return new Promise((resolve) => {
    const ctl = new AbortController();
    const done = (how) => {
      ctl.abort();
      resolve(how);
    };
    const help = h("div", { class: "recover", hidden: true }, paperKeyForm(setup, done), ...recoveryHelp(home, handle));
    const toggle = h("button", {
      class: "link",
      type: "button",
      text: tr("link.noOther"),
      onclick: () => { help.hidden = !help.hidden; },
    });
    const card = h(
      "div",
      { class: "card" },
      h("p", { text: tr("link.inUse", { handle }) }),
      h("div", { class: "code", text: setup.code }),
      h("p", { class: "hint" }, h("span", { class: "spinner" }), tr("link.waiting")),
      h("button", { class: "btn ghost", text: tr("common.cancel"), onclick: () => done(false) }),
      toggle,
      help,
    );
    inApp(true);
    root.replaceChildren(h("div", { class: "center" }, h("div", { class: "auth" }, h("h1", { class: "brand", text: tr("link.title") }), card)));
    setup.waitForApproval(ctl.signal).then(
      (ok) => {
        if (ctl.signal.aborted) return;
        if (ok) return resolve("linked");
        // Nobody approved in time: most likely no other device is left. Say what can be done instead.
        card.replaceChildren(
          h("p", { text: tr("link.expired") }),
          h("p", { class: "hint", text: tr("link.expiredHint") }),
          h("div", { class: "recover" }, paperKeyForm(setup, done), ...recoveryHelp(home, handle)),
          h("button", { class: "btn primary", text: tr("link.back"), onclick: () => done(false) }),
        );
      },
      () => resolve(false),
    );
  });
}

/** A field for the account's paper key on the link screen: it adds this device instead of another device (§4.5). */
function paperKeyForm(setup, done) {
  const input = h("input", { type: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: false, placeholder: "MPK-XXXX-XXXX-…" });
  const err = h("div", { class: "error" });
  const go = h("button", { class: "btn primary", type: "submit", text: tr("paper.use") });
  const form = h(
    "form",
    {
      class: "paper",
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const restore = busy(go, tr("paper.checking"));
        try {
          await setup.approveWithPaperKey(input.value);
          input.value = "";
          done("paper");
        } catch (x) {
          err.textContent = say(x);
          restore();
        }
      },
    },
    h("p", {}, h("strong", { text: tr("paper.have") }), tr("paper.haveText")),
    h("div", { class: "field" }, h("label", { text: tr("paper.label") }), input),
    go,
    err,
    h("p", { class: "hint", text: tr("paper.none") }),
  );
  return form;
}

/** After a paper key brought the account back: what is (and is not) on this device now. */
function showAfterPaperKey() {
  const d = dialog(
    h("h2", { text: tr("welcomeBack.title") }),
    h("p", { text: tr("welcomeBack.1") }),
    h("p", { class: "hint", text: tr("welcomeBack.2") }),
    h("p", { class: "hint", text: tr("welcomeBack.3") }),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", text: tr("common.close"), onclick: () => d.close() }),
      h("button", { class: "btn primary", text: tr("welcomeBack.devices"), onclick: () => { d.close(); showDevices(); } }),
    ),
  );
}

/** Whether an identity's home is this server, also under a domain the server had before a move. */
function homeIsHere(home) {
  return home === api.base || (info.origins ?? []).some((o) => home === `${o}/id`);
}

function hostOf(home) {
  try {
    return new URL(home).host;
  } catch {
    return home;
  }
}

/**
 * What to do when no device of the account is left (docs/DESIGN.md §4.1): only the recovery card can start a new
 * device list, by making a new rootcard instance. That is done outside Murmo, in rootcard's key tool or at the home.
 */
function recoveryHelp(home, handle) {
  const host = hostOf(home);
  const [user] = splitHandle(handle);
  const intro = [
    h("p", { text: tr("recover.intro") }),
    h("p", { class: "hint", text: tr("recover.hint") }),
  ];
  if (!homeIsHere(home)) {
    return [
      ...intro,
      h("p", { text: tr("recover.elsewhere", { host }) }),
    ];
  }
  return [
    ...intro,
    h(
      "ol",
      {},
      h("li", {}, tr("recover.step1"), h("a", { href: "vendor/rootcard/keytool.html", download: "rootcard-keytool.html", text: tr("recover.step1Link") })),
      h("li", { text: tr("recover.step2", { user, host }) }),
      h("li", { text: tr("recover.step3") }),
      h("li", { text: tr("recover.step4") }),
    ),
  ];
}

// ── the main view ───────────────────────────────────────────────────────────────────────────────────────────────

async function enter({ store, account, handle, home }) {
  messenger = new Messenger({ api, store, account, handle, home, realms: info.realms, fileQueue: () => settings().fileQueue, queueLimit: () => queueLimit() ?? Infinity });
  messenger.addEventListener("contacts", () => { renderSidebar(); refreshConversation(); });
  messenger.addEventListener("messages", (e) => {
    searchCache.delete(e.detail.conv);
    if (e.detail.conv === current) renderThread();
    renderSidebar();
  });
  messenger.addEventListener("gifs", () => refreshGifHashes().then(renderThread).catch(() => {}));
  messenger.addEventListener("status", (e) => {
    renderSidebar();
    if (e.detail !== "online") return;
    syncPush().catch((x) => console.warn("push", x?.message ?? x));
    checkVersion(); // the server may have been restarted with a new client
  });
  messenger.addEventListener("incoming", (e) => onIncoming(e.detail));
  messenger.addEventListener("link", (e) => showLinkRequest(e.detail));
  messenger.addEventListener("error", (e) => console.warn(e.detail.message));
  messenger.addEventListener("removed", async () => {
    toast(tr("main.removed"));
    await logout(true);
  });
  await messenger.start();
  await refreshGifHashes().catch(() => {});
  renderShell();
  askNotifications();
}

// A page that was in the background comes back with a dead connection: check it at once.
function wake() {
  if (document.visibilityState !== "visible") return;
  messenger?.wake();
  notify.clear().catch(() => {});
  updateBell();
  checkVersion();
}
document.addEventListener("visibilitychange", wake);
addEventListener("pageshow", wake);
addEventListener("focus", wake);
addEventListener("online", wake);

// ── notifications ───────────────────────────────────────────────────────────────────────────────────────────────

const unread = new Set(); // conversations with something new since the page was last looked at

function onIncoming({ conv, kind }) {
  const looking = document.visibilityState === "visible" && document.hasFocus();
  if (looking && conv === current) return;
  unread.add(conv);
  renderSidebar();
  if (looking || !settings().notify) return;
  const who = messenger.contacts.get(conv)?.handle ?? tr("common.someone");
  const key = { request: "notify.request", file: "notify.file", ephemeral: "notify.ephemeral" }[kind] ?? "notify.message";
  const text = tr(key, { who });
  notify.show(text).catch(() => {});
}

/** Keep the server's push endpoint for this device in step with the setting. */
async function syncPush() {
  if (!messenger || !settings().notify || notify.permission() !== "granted") return;
  const endpoint = await notify.pushEndpoint(info.push_key);
  if (endpoint) await messenger.setPushEndpoint(endpoint);
}

/**
 * Notifications are on by default, but the browser's permission must be asked for from a user gesture: ask at the
 * first click after login, once per device. If that question is dismissed, the start page offers it again, and the setting always can.
 */
function askNotifications() {
  const due = () => messenger && settings().notify && !settings().notifyPrompted && notify.support() === "ok" && notify.permission() === "default";
  if (!due()) return;
  document.addEventListener(
    "click",
    async (e) => {
      if (!due() || ui.bell?.contains(e.target)) return; // the bell asks itself
      setSetting("notifyPrompted", true);
      const text = await setNotifications(true).catch(() => null);
      if (text && notify.permission() === "granted") toast(text);
    },
    { once: true, capture: true },
  );
}

// ── a new version ───────────────────────────────────────────────────────────────────────────────────────────────

let versionChecked = Date.now();
let versionOffered = false;

/** Ask the server which client it serves now; offer a reload when it is not the one this page was loaded from. */
async function checkVersion() {
  if (versionOffered || !info?.build || Date.now() - versionChecked < 60_000) return;
  versionChecked = Date.now();
  try {
    const now = await api.info();
    if (!now.build || now.build === info.build || versionOffered) return;
  } catch {
    return; // offline: the next check will tell
  }
  versionOffered = true;
  const bar = h(
    "div",
    { class: "update", role: "status" },
    h("span", { text: tr("update.available") }),
    h("button", { class: "btn small primary", text: tr("update.reload"), onclick: () => location.reload() }),
    h("button", { class: "btn small ghost", text: tr("update.later"), onclick: () => bar.remove() }),
  );
  document.body.append(bar);
}
setInterval(checkVersion, 15 * 60_000);

/**
 * Why this device cannot show notifications although the setting is on (null: it can, or the user turned them off).
 * The header shows a struck-through bell for it.
 */
function notifyProblem() {
  if (!messenger || !settings().notify) return null;
  const s = notify.support();
  if (s === "ios-install") return tr("notify.ios");
  if (s !== "ok") return tr("notify.unsupported");
  const p = notify.permission();
  if (p === "granted") return null;
  return tr(p === "denied" ? "notify.blocked" : "notify.askHint");
}

function updateBell() {
  if (!ui.bell) return;
  const problem = notifyProblem();
  ui.bell.hidden = !problem;
  if (!problem) return;
  const text = `${tr("notify.cannot")} ${problem}`;
  ui.bell.title = text;
  ui.bell.setAttribute("aria-label", text);
}

// The permission can change in the browser's settings while the page is open.
navigator.permissions?.query({ name: "notifications" }).then((s) => s.addEventListener("change", updateBell)).catch(() => {});

/** Turn notifications on (from a click) or off. Returns a text for the user. */
async function setNotifications(on) {
  try {
    return await switchNotifications(on);
  } finally {
    updateBell();
  }
}

async function switchNotifications(on) {
  if (!on) {
    setSetting("notify", false);
    await notify.unsubscribe().catch(() => {});
    await messenger.setPushEndpoint(null).catch(() => {});
    return tr("notify.off");
  }
  const s = notify.support();
  if (s === "ios-install") return tr("notify.ios");
  if (s !== "ok") return tr("notify.unsupported");
  const r = await notify.request();
  if (r !== "granted") return tr(r === "denied" ? "notify.blocked" : "notify.notOn");
  setSetting("notify", true);
  setSetting("notifyPrompted", true);
  try {
    const endpoint = await notify.pushEndpoint(info.push_key);
    if (!endpoint) return tr("notify.noPush");
    await messenger.setPushEndpoint(endpoint);
    return tr("notify.on");
  } catch (x) {
    console.warn("push", x?.message ?? x);
    return tr("notify.pushFailed");
  }
}

const ui = {};

function renderShell() {
  ui.sideList = h("nav", { class: "side-list", "aria-label": tr("side.conversations") });
  ui.search = h("input", {
    class: "input", type: "search", placeholder: tr("search.placeholder"), "aria-label": tr("search.label"),
    spellcheck: "false", autocomplete: "off", autocapitalize: "off", enterkeyhint: "search",
  });
  ui.search.value = search;
  let wait = 0;
  ui.search.addEventListener("input", () => {
    clearTimeout(wait);
    wait = setTimeout(() => setSearch(ui.search.value), 150);
  });
  // Esc empties the field, and an empty field closes; so does leaving it empty.
  ui.search.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (!ui.search.value) return showSearch(false);
    clearTimeout(wait);
    ui.search.value = "";
    setSearch("");
  });
  ui.search.addEventListener("blur", () => { if (!ui.search.value) showSearch(false); });
  ui.searchRow = h("div", { class: `side-search${search ? "" : " hidden"}`, role: "search" }, ui.search);
  ui.searchBtn = h("button", {
    class: "icon-btn search-btn", "aria-label": tr("search.label"), title: `${tr("search.label")} (${shortcut})`,
    "aria-expanded": String(!!search), onclick: () => showSearch(ui.searchRow.classList.contains("hidden")),
    onmousedown: (e) => e.preventDefault(), // the field keeps the focus, so it is not closed by its blur first
  }, icon("search"));
  ui.foot = h("div", { class: "side-foot" });
  ui.main = h("main", { class: "main" });
  ui.bell = h("button", { class: "icon-btn bell-off", hidden: true, onclick: async () => toast(await setNotifications(true).catch((x) => say(x))) }, icon("bellOff"));
  ui.shell = h(
    "div",
    { class: "shell" },
    h(
      "aside",
      { class: "sidebar" },
      h(
        "div",
        { class: "side-top" },
        h("div", { class: "logo" }, h("img", { src: "icon.svg", alt: "" }), "Murmo"),
        h(
          "div",
          { class: "side-actions" },
          ui.bell,
          ui.searchBtn,
          h("button", { class: "icon-btn new-btn", "aria-label": tr("side.newConversation"), title: tr("side.newConversation"), onclick: () => openConversation(null, true) }, icon("plus")),
        ),
      ),
      ui.searchRow,
      ui.sideList,
      ui.foot,
    ),
    ui.main,
  );
  inApp(true);
  root.replaceChildren(ui.shell);
  renderSidebar();
  openConversation(current);
}

/** A conversation in the sidebar. */
function convItem(c) {
  const [name, tag] = splitHandle(c.handle);
  return h(
    "button",
    { class: `conv${c.account === current ? " on" : ""}`, onclick: () => openConversation(c.account) },
    h("span", { class: "avatar small", text: name.slice(0, 1).toUpperCase() }),
    h("span", { class: "name" }, name, h("span", { class: "tag", text: tag })),
    c.state === "incoming" ? h("span", { class: "badge", text: tr("side.badgeNew") }) : null,
    c.state === "outgoing" ? h("span", { class: "badge muted", text: tr("side.badgeWaiting") }) : null,
    c.state === "accepted" && unread.has(c.account) ? h("span", { class: "unread", "aria-label": tr("side.unread") }) : null,
    c.fork ? h("span", { class: "badge", text: "!" }) : null,
  );
}

function renderSidebar() {
  if (!ui.sideList || !messenger) return;
  updateBell();
  renderFoot();
  if (search) return renderSearch();
  const all = messenger.contactList().sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  const incoming = all.filter((c) => c.state === "incoming");
  const convs = all.filter((c) => c.state === "accepted" || c.state === "outgoing");
  const blocked = all.filter((c) => c.state === "blocked");
  const item = convItem;
  put(ui.sideList,
    incoming.length ? h("div", { class: "side-head", text: tr("side.requests") }) : null,
    ...incoming.map(item),
    h("div", { class: "side-head", text: tr("side.conversations") }),
    ...(convs.length
      ? convs.map(item)
      : [h("div", { class: "empty" }, h("p", { class: "hint", text: tr("side.none") }), h("button", { class: "btn primary", text: tr("side.newConversation"), onclick: () => openConversation(null, true) }), about())]),
    blocked.length ? h("div", { class: "side-head", text: tr("side.blocked") }) : null,
    ...blocked.map(item),
  );
}

// ── search (DESIGN.md §6.9) ──────────────────────────────────────────────────────────────────────────────────────
// Messages are stored encrypted on the device and the server never sees them, so the search runs here: over the
// decrypted texts and file names of every conversation, while a query is typed. Disappearing messages are not
// searched. What has been decrypted for it is kept per conversation while the search is open (dropped when a
// conversation changes) and forgotten when the field is emptied.

const SEARCH_MAX = 100;
/** conversation → its searchable messages, newest first: `{ id, time, dir, text, folded }`. */
const searchCache = new Map();
let searchSeq = 0;

const fold = (s) => s.replace(/\s+/g, " ").toLocaleLowerCase();

const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl+K";

/** Open the search field (and put the cursor in it), or close it and empty it. */
function showSearch(on) {
  if (!ui.searchRow) return;
  ui.searchRow.classList.toggle("hidden", !on);
  ui.searchBtn.setAttribute("aria-expanded", String(on));
  if (on) {
    // On a narrow screen the list is behind an open conversation: back to it.
    if (current && matchMedia("(max-width: 760px)").matches) closeConversation();
    ui.search.focus();
    ui.search.select();
  } else {
    ui.search.value = "";
    setSearch("");
  }
}
addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "k" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || !ui.searchRow?.isConnected) return;
  if (document.querySelector("dialog[open]")) return;
  e.preventDefault();
  showSearch(true);
});

function setSearch(q) {
  const next = q.trim().replace(/\s+/g, " ");
  if (next === search) return;
  search = next;
  if (!search) searchCache.clear();
  renderSidebar();
}

/** The messages of a conversation that a search looks in. */
async function searchable(conv) {
  let list = searchCache.get(conv);
  if (list) return list;
  list = [];
  for (const m of await messenger.messages(conv)) {
    const text = m.kind === "text" ? m.text : m.kind === "file" ? m.file?.name : null;
    if (!text) continue;
    const one = text.replace(/\s+/g, " ").trim();
    list.push({ id: m.id, time: m.time, dir: m.dir, text: one, folded: fold(one) });
  }
  list.reverse();
  searchCache.set(conv, list);
  return list;
}

/** A line of a found text: some words before the match, the match marked, what follows (cut off by the list). */
function snippet(text, q) {
  const at = fold(text).indexOf(q);
  // Lower case can change the length of a few letters; then the place is not known and the text is shown unmarked.
  if (at < 0 || fold(text).length !== text.length) return [text];
  let from = Math.max(0, at - 28);
  if (from > 0) {
    const space = text.indexOf(" ", from);
    from = space >= 0 && space < at ? space + 1 : from;
  }
  return [from > 0 ? `…${text.slice(from, at)}` : text.slice(0, at), h("mark", { text: text.slice(at, at + q.length) }), text.slice(at + q.length)];
}

async function renderSearch() {
  const seq = ++searchSeq;
  const q = fold(search);
  const all = messenger.contactList().filter((c) => c.state !== "declined").sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  const people = all.filter((c) => fold(c.handle).includes(q));
  const hits = [];
  for (const c of all) {
    const list = await searchable(c.account);
    if (seq !== searchSeq) return;
    for (const m of list) if (m.folded.includes(q)) hits.push({ c, m });
  }
  if (seq !== searchSeq || !ui.sideList) return;
  hits.sort((a, b) => b.m.time - a.m.time);
  const hit = ({ c, m }) => {
    const [name, tag] = splitHandle(c.handle);
    return h(
      "button",
      { class: "conv hit", onclick: () => { jumpTo = m.id; openConversation(c.account); } },
      h("span", { class: "avatar small", text: name.slice(0, 1).toUpperCase() }),
      h(
        "span",
        { class: "hit-body" },
        h("span", { class: "hit-top" },
          h("span", { class: "name" }, name, h("span", { class: "tag", text: tag })),
          h("time", { datetime: i18n.iso(m.time), title: i18n.dateTime(m.time), text: i18n.daysAgo(m.time) === 0 ? clock(m.time) : dayLabel(m.time) })),
        h("span", { class: "snippet", dir: "auto" }, m.dir === "out" ? h("span", { class: "you", text: tr("search.you") }) : null, ...snippet(m.text, q)),
      ),
    );
  };
  put(ui.sideList,
    people.length ? h("div", { class: "side-head", text: tr("side.conversations") }) : null,
    ...people.map(convItem),
    hits.length ? h("div", { class: "side-head", text: tr("search.messages") }) : null,
    ...hits.slice(0, SEARCH_MAX).map(hit),
    hits.length > SEARCH_MAX ? h("p", { class: "hint search-more", text: tr("search.more", { n: i18n.num(SEARCH_MAX) }) }) : null,
    !people.length && !hits.length ? h("p", { class: "hint search-none", text: tr("search.none") }) : null,
  );
}

function renderFoot() {
  const [name] = splitHandle(messenger.handle);
  put(ui.foot,
    h("div", { class: "avatar", text: name.slice(0, 1).toUpperCase() }),
    h(
      "div",
      { class: "me" },
      h("div", { class: "h", text: messenger.handle, title: tr("side.copyHint"), onclick: copyHandle }),
      h("div", { class: "s" }, h("span", { class: `dot${messenger.status === "online" ? " on" : ""}` }), tr(messenger.status === "online" ? "side.online" : "side.connecting"), homeLabel(messenger.home) ? ` · ${homeLabel(messenger.home)}` : ""),
    ),
    h("button", { class: "icon-btn", "aria-label": tr("side.account"), title: tr("side.account"), onclick: showAccountMenu }, icon("more")),
  );
}

// On a narrow screen the list of conversations is the start page and a conversation covers it; the browser's back
// button (and the arrow) lead back to the list.
let pushed = false;
function closeConversation() {
  if (pushed) history.back();
  else openConversation(null);
}
addEventListener("popstate", () => {
  // Back with a dialog open (a picture, a menu) closes the dialog and stays where it was.
  const open = document.querySelector("dialog[open]");
  if (open) {
    open.close();
    if (ui.shell?.classList.contains("chat")) history.pushState({ murmo: 1 }, "");
    return;
  }
  pushed = false;
  if (messenger && ui.shell) openConversation(null);
});

function topbar(...children) {
  return h(
    "div",
    { class: "topbar" },
    h("button", { class: "icon-btn back-btn", "aria-label": tr("side.back"), onclick: closeConversation }, icon("back")),
    ...children,
  );
}

/** What of a contact decides how its conversation is drawn (besides the messages). */
function shape(c) {
  return c ? `${c.account}|${c.state}|${!!c.fork}|${c.devicesChanged ?? 0}|${c.retention ?? 0}` : "";
}

/** The open contact changed (a request was accepted, a block, new devices): draw the conversation again. */
function refreshConversation() {
  if (!current || !ui.main) return;
  const c = messenger.contacts.get(current);
  if (shape(c) === ui.shape) return;
  const draft = ui.main.querySelector(".composer textarea")?.value ?? "";
  openConversation(c && c.state !== "declined" ? current : null);
  const ta = ui.main.querySelector(".composer textarea");
  if (ta && draft) {
    ta.value = draft;
    ta.dispatchEvent(new Event("input"));
  }
}

/** Open a conversation, or with `null` the start (`form`: the new-conversation form, also on a narrow screen). */
function openConversation(account, form = false) {
  current = account && messenger.contacts.has(account) ? account : null;
  for (const u of objectUrls.values()) URL.revokeObjectURL(u);
  objectUrls.clear();
  msgNodes.clear();
  imgNodes.clear();
  const covering = !!current || form;
  ui.shell.classList.toggle("chat", covering);
  if (covering && !pushed) {
    history.pushState({ murmo: 1 }, "");
    pushed = true;
  }
  if (current) unread.delete(current);
  renderSidebar();
  const c = current && messenger.contacts.get(current);
  ui.shape = shape(c);
  if (!c) return renderWelcome();
  const [name, tag] = splitHandle(c.handle);
  ui.thread = h("div", { class: "thread" });
  ui.scroll = h("div", { class: "scroll" }, ui.thread);
  const head = topbar(
    h("div", { class: "title" }, name, h("span", { class: "tag", text: tag }), homeLabel(c.home) ? h("span", { class: "home", text: ` · ${homeLabel(c.home)}` }) : null, c.retention ? h("span", { class: "home", title: tr("conv.retentionTitle"), text: tr("conv.retention", { time: retentionLabel(c.retention) }) }) : null),
    c.state === "accepted" ? h("button", { class: "btn ghost small", onclick: () => showSafety(c) }, icon("shield"), h("span", { class: "wide", text: tr("conv.safety") })) : null,
    h("button", { class: "icon-btn", "aria-label": tr("conv.more"), onclick: () => showContactMenu(c) }, icon("more")),
  );
  const parts = [head];
  if (c.fork) parts.push(h("div", { class: "banner warn", text: tr("err.fork") }));
  else if (c.devicesChanged && c.state === "accepted") {
    parts.push(h("div", { class: "banner", text: tr("conv.devicesChanged", { handle: c.handle }) }));
  }
  parts.push(ui.scroll);
  if (c.state === "incoming") parts.push(requestBox(c));
  else if (c.state === "outgoing") parts.push(h("div", { class: "request-box", text: tr("conv.requested", { handle: c.handle }) }));
  else if (c.state === "blocked") parts.push(h("div", { class: "request-box" }, h("span", { text: tr("conv.blocked") }), h("button", { class: "btn small", text: tr("conv.unblock"), onclick: () => messenger.setState(c.account, "accepted").then(() => openConversation(c.account)) })));
  else parts.push(composer(c));
  put(ui.main,...parts);
  renderSeq = 0;
  renderThread();
}

function requestBox(c) {
  return h(
    "div",
    { class: "request-box" },
    h("strong", { text: c.handle }),
    h("span", { text: tr("conv.wantsToWrite") }),
    h("p", { class: "hint", text: tr("conv.untilAccepted") }),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn primary", text: tr("conv.accept"), onclick: () => messenger.accept(c.account).then(() => openConversation(c.account), (x) => toast(say(x))) }),
      h("button", { class: "btn", text: tr("conv.decline"), onclick: () => messenger.setState(c.account, "declined").then(() => openConversation(null)) }),
      h("button", { class: "btn danger", text: tr("conv.block"), onclick: () => messenger.setState(c.account, "blocked").then(() => openConversation(null)) }),
    ),
  );
}

/** The start of the main pane: add a conversation by exact identifier. */
function renderWelcome() {
  ui.thread = null;
  const input = h("input", { class: "input", id: "new-handle", placeholder: tr("common.handlePlaceholder"), spellcheck: "false", autocomplete: "off", autocapitalize: "off", enterkeyhint: "next" });
  const note = h("input", { class: "input", id: "new-note", placeholder: tr("new.notePlaceholder"), maxlength: 500, enterkeyhint: "send" });
  const err = h("div", { class: "error" });
  const send = h("button", { class: "btn primary", type: "submit", text: tr("new.send") });
  const form = h(
    "form",
    {
      class: "card newconv",
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        if (!input.value.trim()) return input.focus();
        send.disabled = true;
        try {
          const c = await messenger.request(input.value.trim(), note.value.trim());
          openConversation(c.account);
        } catch (x) {
          err.textContent = say(x);
          send.disabled = false;
        }
      },
    },
    h("p", { class: "hint", text: tr("new.hint") }),
    h("div", { class: "field" }, h("label", { for: "new-handle", text: tr("common.handle") }), input),
    h("div", { class: "field" }, h("label", { for: "new-note", text: tr("new.note") }), note),
    err,
    send,
  );
  // Wanted (the default) but the browser's question was dismissed: offer it again here.
  const offered = settings().notify && settings().notifyPrompted && notify.support() === "ok" && notify.permission() === "default";
  const offer = !offered
    ? null
    : h(
        "div",
        { class: "card offer" },
        h("div", {}, h("strong", { text: tr("new.notifyTitle") }), h("div", { class: "hint", text: tr("new.notifyText") })),
        h("button", { class: "btn small", text: tr("common.notNow"), onclick: () => { setSetting("notify", false); offer.remove(); } }),
        h("button", { class: "btn small primary", text: tr("new.notifyOn"), onclick: async () => { offer.remove(); toast(await setNotifications(true)); } }),
      );
  put(ui.main,
    topbar(h("h1", { class: "title", text: tr("side.newConversation") })),
    h(
      "div",
      { class: "welcome" },
      h(
        "div",
        { class: "welcome-inner" },
        form,
        h("div", { class: "card mine" }, h("div", {}, h("div", { class: "hint", text: tr("new.mine") }), h("strong", { text: messenger.handle })), h("button", { class: "btn small", text: tr("common.copy"), onclick: copyHandle })),
        offer,
        singleDeviceReminder(),
        about(),
      ),
    ),
  );
  if (matchMedia("(min-width: 761px)").matches || ui.shell.classList.contains("chat")) input.focus();
}

/**
 * A reminder while the account has only this device: if its browser data is lost, nobody can approve a new device,
 * and only the recovery card (with the history lost) gets the account back. Filled in once the list is known.
 */
function singleDeviceReminder() {
  const slot = h("div", { hidden: true });
  if (settings().singleDeviceSeen) return slot;
  messenger.ownList().then(
    (own) => {
      // A paper key can approve a new device, so the account is not lost with this one (§4.5).
      if (own.present.length !== 1) return;
      slot.hidden = false;
      slot.replaceChildren(
        h(
          "div",
          { class: "card offer" },
          h(
            "div",
            {},
            h("strong", { text: tr("lone.title") }),
            h("div", { class: "hint", text: tr("lone.text") }),
          ),
          h(
            "div",
            { class: "btns" },
            h("button", { class: "btn small primary", text: tr("lone.make"), onclick: () => showPaperKey(() => slot.remove()) }),
            h("button", { class: "btn small", text: tr("common.notNow"), onclick: () => { setSetting("singleDeviceSeen", true); slot.remove(); } }),
          ),
        ),
      );
    },
    () => {},
  );
  return slot;
}

/** How a disappearing message's timer is said: "15 s", "1 min", "1 tim". */
function ttlLabel(t) {
  return t < 60 ? tr("ttl.s", { n: i18n.num(t) }) : t < 3600 ? tr("ttl.min", { n: i18n.num(t / 60) }) : tr("ttl.h", { n: i18n.num(t / 3600) });
}

/** What is left of a countdown, short: "14 s", "4:59", "59 min". */
function remainingLabel(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return tr("ttl.s", { n: s });
  if (s < 600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return s < 3600 ? tr("ttl.min", { n: Math.ceil(s / 60) }) : tr("ttl.h", { n: Math.ceil(s / 3600) });
}

function composer(c) {
  const name = splitHandle(c.handle)[0];
  const ta = h("textarea", { rows: 1 });
  // The timer stays on for this conversation until it is turned off (kept on this device only).
  let ttl = messenger.timer(c.account);
  const file = h("input", { type: "file", class: "hidden", multiple: true });
  const send = h("button", { class: "send", "aria-label": tr("compose.send"), disabled: true }, icon("send"));
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
    send.disabled = !ta.value.trim();
  };
  const sendNow = async (text, id, t = ttl) => {
    try {
      if (t) await messenger.sendEphemeral(c.account, text, t, id);
      else await messenger.sendText(c.account, text, id);
    } catch (x) {
      if (!ta.value.trim()) {
        ta.value = text;
        grow();
      }
      toast(say(x));
    }
  };
  const submit = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    grow();
    if (settings().undoSend) holdForUndo(text);
    else await sendNow(text);
  };
  // "Ångra": the text is shown in the thread like a sent message, with an undo button where the menu would be, and
  // is encrypted and sent only after UNDO_SEND ms. It is sent under the id it is shown with, so the node stays.
  const holdForUndo = (text) => {
    const id = p.b64(p.random(16));
    const t = ttl; // the timer as it was when the message was written
    const e = {
      m: { id, conv: c.account, dir: "out", time: p.now(), kind: t ? "ephemeral" : "text", text, held: true, ...(t ? { ttl: t } : {}) },
      fire: async () => {
        if (e.m.firing) return;
        clearTimeout(timer);
        e.m = { ...e.m, firing: true }; // shown without the undo button from now on
        renderThread();
        await sendNow(text, id, t);
        heldMsgs.delete(id);
        renderThread();
      },
      undo: () => {
        if (e.m.firing) return;
        clearTimeout(timer);
        heldMsgs.delete(id);
        renderThread();
        // Taken back before it was sent: nothing left this device. The text returns to an empty composer.
        if (!ta.value.trim()) {
          ta.value = text;
          grow();
          ta.focus();
        } else toast(tr("compose.notSent"));
      },
    };
    const timer = setTimeout(e.fire, UNDO_SEND);
    heldMsgs.set(id, e);
    renderThread();
  };
  // Files on their way, one row each above the composer: name, how far it has come, then how it went.
  const uploads = h("div", { class: "uploads", role: "status", "aria-live": "polite" });
  // `note`: told before the file is sent (that the server cannot keep it).
  const upload = async (name, run, note = null) => {
    const bar = h("progress", { max: 1, value: 0 });
    const state = h("span", { class: "state", text: tr("compose.preparing") });
    const label = h("span", { class: "name", dir: "auto", text: name });
    const row = h("div", { class: "upload" }, h("span", { class: "spinner" }), label, state, note ? h("span", { class: "note", text: note }) : null, bar);
    uploads.append(row);
    let id = null;
    const finish = (kind, text, ms) => {
      const close = h("button", { type: "button", class: "close-up", "aria-label": tr("common.close"), title: tr("common.close"), onclick: () => row.remove() }, icon("close"));
      row.className = `upload ${kind}`;
      put(row, h("span", { class: "mark", "aria-hidden": "true", text: kind === "fail" ? "!" : kind === "ok" ? "✓" : "…" }), label, h("span", { class: "state", text }), close);
      setTimeout(() => row.remove(), ms);
    };
    try {
      const r = await run(({ phase, done, total, id: mid }) => {
        const share = total ? done / total : 1;
        if (phase === "read") {
          state.textContent = tr("compose.preparing");
          bar.value = 0.15 * share;
          return;
        }
        if (!id) {
          id = mid;
          sending.set(id, share);
          if (current === c.account) renderThread();
        }
        sending.set(id, share);
        state.textContent = tr("compose.sending", { pct: percent(share) });
        bar.value = 0.15 + 0.85 * share;
        showSending(id);
      });
      if (r.live) finish("ok", tr("compose.sent"), 2500);
      else if (r.queued) finish("wait", tr("compose.queued"), 7000);
      else if (r.tooBig) finish("wait", tr("compose.laterTooBig", { size: bytes(Math.max(0, queueMaxFile() ?? 0)) }), 12000);
      else finish("wait", tr("compose.later"), 7000);
    } catch (x) {
      finish("fail", say(x), 12000);
    } finally {
      if (id) {
        sending.delete(id);
        if (current === c.account) renderThread();
      }
    }
  };
  const sendFiles = async (files) => {
    if (ttl) return toast(tr("err.ephemeral_files"));
    // Whether the server could keep a file for devices that are away is known before it is sent: said in its row.
    const max = settings().fileQueue ? queueMaxFile() : null;
    for (const f of files) {
      const note = max !== null && f.size > max && f.size <= p.MAX_FILE ? tr("compose.tooBigToQueue", { size: bytes(Math.max(0, max)) }) : null;
      await upload(f.name, (progress) => messenger.sendFile(c.account, f, progress), note);
    }
  };
  /** Put text where the cursor is (or over the selection), and keep the cursor after it. */
  const insert = (text) => {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    ta.setRangeText(text, start, end, "end");
    grow();
    if (canHover()) ta.focus();
  };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  ta.addEventListener("paste", (e) => {
    const fs = [...(e.clipboardData?.files ?? [])];
    if (fs.length) { e.preventDefault(); sendFiles(fs); }
  });
  send.addEventListener("click", submit);
  file.addEventListener("change", () => { sendFiles([...file.files]); file.value = ""; });

  // One panel above the composer at a time: the emoji or the user's GIFs.
  const panel = h("div", { class: "picker hidden", role: "region", "aria-label": tr("compose.panel") });
  let open = null;
  let seq = 0;
  let urls = []; // object URLs of the GIFs shown, revoked when the panel closes
  const emojiBtn = h("button", { class: "icon-btn", type: "button", "aria-label": tr("compose.emoji"), title: tr("compose.emoji"), "aria-expanded": "false" }, icon("smile"));
  const gifBtn = h("button", { class: "icon-btn gif-btn", type: "button", "aria-label": "GIF", title: tr("compose.yourGifs"), "aria-expanded": "false", text: "GIF" });
  const closePanel = () => {
    open = null;
    panel.classList.add("hidden");
    panel.replaceChildren();
    emojiBtn.setAttribute("aria-expanded", "false");
    gifBtn.setAttribute("aria-expanded", "false");
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  };
  const toggle = (which) => {
    if (open === which) return closePanel();
    closePanel();
    open = which;
    const mine = ++seq;
    const alive = () => open === which && seq === mine && wrap.isConnected;
    panel.classList.remove("hidden");
    (which === "emoji" ? emojiBtn : gifBtn).setAttribute("aria-expanded", "true");
    const fail = (x) => { if (alive()) put(panel, h("p", { class: "hint", text: say(x) })); };
    if (which === "emoji") emojiPanel(panel, (e) => insert(e), alive).catch(fail);
    else gifPanel(panel, c, { upload, close: closePanel, alive, track: (u) => urls.push(u) }).catch(fail);
  };
  // The timer: a small menu of choices; while one is on, the button and the composer say so, and files wait.
  const timerBtn = h("button", { class: "icon-btn timer-btn", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" });
  const clipBtn = h("button", { class: "icon-btn", "aria-label": tr("compose.attach"), title: tr("compose.sendFile"), onclick: () => file.click() }, icon("clip"));
  const showTimer = () => {
    put(timerBtn, icon("timer"), ttl ? h("span", { class: "ttl", text: ttlLabel(ttl) }) : null);
    timerBtn.classList.toggle("on", !!ttl);
    const what = ttl ? tr("timer.on", { time: ttlLabel(ttl) }) : tr("timer.off");
    timerBtn.setAttribute("aria-label", what);
    timerBtn.title = what;
    ta.placeholder = ttl ? tr("compose.placeholderEphemeral", { name, time: ttlLabel(ttl) }) : tr("compose.placeholder", { name });
    box?.classList.toggle("ephemeral", !!ttl);
    for (const b of [clipBtn, gifBtn]) {
      b.disabled = !!ttl;
      b.title = ttl ? tr("err.ephemeral_files") : tr(b === clipBtn ? "compose.sendFile" : "compose.yourGifs");
    }
    if (ttl && open === "gif") closePanel();
  };
  const setTtl = (t) => {
    ttl = t;
    showTimer();
    messenger.setTimer(c.account, t).catch(() => {});
  };
  timerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    timerMenu(timerBtn, ttl, (t) => { setTtl(t); if (canHover()) ta.focus(); });
  });
  emojiBtn.addEventListener("click", () => toggle("emoji"));
  gifBtn.addEventListener("click", () => toggle("gif"));
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closePanel(); ta.focus(); } });
  ta.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) closePanel(); });

  const box = h(
    "div",
    { class: "composer" },
    ta,
    h(
      "div",
      { class: "row" },
      clipBtn,
      emojiBtn,
      gifBtn,
      timerBtn,
      h("span", { class: "grow" }),
      send,
    ),
    file,
  );
  showTimer();
  const wrap = h("div", { class: "composer-wrap" }, panel, uploads, box, h("div", { class: "foot-note", text: tr("compose.foot") }));
  // A click outside the panel and its buttons closes it.
  const outside = (e) => {
    if (!wrap.isConnected) return document.removeEventListener("pointerdown", outside);
    if (!open) return;
    if (!panel.contains(e.target) && !emojiBtn.contains(e.target) && !gifBtn.contains(e.target)) closePanel();
  };
  document.addEventListener("pointerdown", outside);
  wrap.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("drop"); });
  wrap.addEventListener("dragleave", () => box.classList.remove("drop"));
  wrap.addEventListener("drop", (e) => { e.preventDefault(); box.classList.remove("drop"); sendFiles([...e.dataTransfer.files]); });
  if (canHover()) setTimeout(() => ta.focus()); // not on touch: it would open the keyboard
  return wrap;
}

/** The timer choices by the composer's timer button: Off and EPHEMERAL_TTLS; `pick(seconds)` (0: off). */
function timerMenu(anchor, now, pick) {
  const open = document.querySelector(".timer-menu");
  open?.remove();
  if (open) return; // the button again closes it
  const close = () => {
    menu.remove();
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", esc, true);
  };
  const outside = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); anchor.focus(); } };
  const item = (t) => h("button", {
    type: "button",
    role: "menuitemradio",
    "aria-checked": String(t === now),
    class: t === now ? "on" : "",
    text: t ? ttlLabel(t) : tr("timer.offShort"),
    onclick: () => { close(); pick(t); },
  });
  const menu = h(
    "div",
    { class: "timer-menu", role: "menu", "aria-label": tr("timer.label") },
    h("div", { class: "picker-title", text: tr("timer.title") }),
    h("div", { class: "choices" }, [0, ...EPHEMERAL_TTLS].map(item)),
  );
  anchor.closest(".composer").append(menu);
  anchor.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", esc, true);
  (menu.querySelector(".on") ?? menu.querySelector("button"))?.focus({ preventScroll: true });
}

/** The emoji picker: recently used first, then the categories (emoji.js); `pick(e)` inserts one. */
async function emojiPanel(panel, pick, alive) {
  let recent = [];
  try {
    recent = (await messenger.recentEmoji()).filter(emoji.known);
  } catch {
    // the list is a convenience; without it the picker starts at the first category
  }
  if (!alive()) return;
  const cats = [...(recent.length ? [{ label: tr("emoji.recent"), icon: null, emoji: recent }] : []), ...emoji.CATEGORIES.map((c) => ({ ...c, label: tr(`emoji.${c.id}`) }))];
  const grid = h("div", { class: "emoji-grid", role: "listbox", "aria-label": tr("compose.emoji") });
  const tabs = h("div", { class: "picker-tabs", role: "tablist" });
  const show = (i) => {
    put(tabs, cats.map((cat, j) =>
      h("button", { type: "button", role: "tab", class: i === j ? "on" : "", "aria-selected": String(i === j), title: cat.label, "aria-label": cat.label, onclick: () => show(j) },
        cat.icon ?? icon("clock")),
    ));
    put(grid, cats[i].emoji.map((e) =>
      h("button", {
        type: "button",
        class: "emoji",
        text: e,
        onclick: () => {
          pick(e);
          recent = emoji.remember(recent, e);
          messenger.setRecentEmoji(recent).catch(() => {});
        },
      }),
    ));
    grid.scrollTop = 0;
  };
  put(panel, tabs, h("div", { class: "picker-title", text: tr("compose.emoji") }), grid);
  show(0);
}

/**
 * The GIF panel: "Mina" (the user's collection, one tap sends one) and, when the server has a GIPHY key, "Sök" (one
 * tap saves a result in the collection). The collection is encrypted on the device and shared with the account's
 * other devices (docs/DESIGN.md §9.2–9.3).
 */
async function gifPanel(panel, c, { upload, close, alive, track }) {
  const body = h("div", { class: "gif-body" });
  const search = info?.giphy?.key ? info.giphy : null;
  const tabs = h("div", { class: "seg gif-tabs", role: "tablist" });
  const show = (which) => {
    put(tabs,
      h("button", { type: "button", role: "tab", class: which === "mine" ? "on" : "", "aria-selected": String(which === "mine"), text: tr("gif.mine"), onclick: () => show("mine") }),
      search ? h("button", { type: "button", role: "tab", class: which === "search" ? "on" : "", "aria-selected": String(which === "search"), text: tr("gif.searchTab"), onclick: () => show("search") }) : null,
    );
    const still = () => alive() && tabs.dataset.on === which;
    tabs.dataset.on = which;
    (which === "mine" ? gifMine(body, c, { upload, close, alive: still, track }) : gifSearch(body, search, { alive: still, track }))
      .catch((x) => { if (still()) put(body, h("p", { class: "hint", text: say(x) })); });
  };
  put(panel, tabs, body);
  show("mine");
}

/** The user's collection: one tap sends a GIF, the cross removes it (on all own devices). */
async function gifMine(box, c, { upload, close, alive, track }) {
  const pickFile = h("input", { type: "file", class: "hidden", accept: "image/gif" });
  const grid = h("div", { class: "gif-grid" });
  let shown = []; // object URLs of this view, replaced on each render
  const render = async () => {
    const list = await messenger.gifs();
    if (!alive()) return;
    if (!list.length) {
      put(grid, h("p", { class: "hint", text: info?.giphy?.key
        ? tr("gif.emptyGiphy")
        : tr("gif.empty") }));
      return;
    }
    const items = [];
    const made = [];
    for (const g of list) {
      const blob = await messenger.gifBlob(g.id);
      const remove = h("button", {
        type: "button",
        class: "gif-remove",
        "aria-label": tr("gif.remove"),
        title: tr("gif.remove"),
        onclick: () => messenger.removeGif(g.id).catch((x) => toast(say(x))),
      }, icon("close"));
      if (!blob) {
        // Saved on another device; the bytes are on their way (or come when that device is connected).
        items.push(h("div", { class: "gif" }, h("div", { class: "gif-send wait", text: tr("gif.fetching"), title: tr("gif.elsewhere") }), remove));
        continue;
      }
      const url = URL.createObjectURL(blob);
      made.push(url);
      items.push(h(
        "div",
        { class: "gif" },
        h("button", {
          type: "button",
          class: "gif-send",
          title: tr("compose.send"),
          onclick: async () => {
            close();
            await upload("GIF", (progress) => messenger.sendGif(c.account, g.id, progress));
          },
        }, h("img", { src: url, alt: tr("gif.saved"), width: String(g.width), height: String(g.height) })),
        remove,
      ));
    }
    if (!alive()) {
      for (const u of made) URL.revokeObjectURL(u);
      return;
    }
    put(grid, items);
    for (const u of shown) URL.revokeObjectURL(u);
    shown = made;
    made.forEach(track);
  };
  // Saved, removed or arrived on another device while the panel is open.
  const onGifs = () => (alive() ? render().catch(() => {}) : messenger.removeEventListener("gifs", onGifs));
  messenger.addEventListener("gifs", onGifs);
  pickFile.addEventListener("change", async () => {
    const files = [...pickFile.files];
    pickFile.value = "";
    for (const f of files) {
      try {
        await messenger.saveGif(f);
      } catch (x) {
        toast(say(x));
        continue;
      }
      await upload(f.name, (progress) => messenger.sendFile(c.account, f, progress));
    }
  });
  put(
    box,
    h(
      "div",
      { class: "picker-head" },
      h("span", { class: "hint", text: tr("gif.tapToSend") }),
      h("button", { type: "button", class: "btn small", text: tr("gif.fromFile"), title: tr("gif.pickFile"), onclick: () => pickFile.click() }),
    ),
    grid,
    pickFile,
  );
  await render();
}

/**
 * Search at GIPHY, straight from the browser. Nothing is asked before the user types; a tap saves a result in the
 * collection. The warning says what GIPHY gets to see.
 */
async function gifSearch(box, config, { alive, track }) {
  const input = h("input", { class: "input", type: "search", placeholder: tr("gif.searchPlaceholder"), enterkeyhint: "search", spellcheck: "false", autocomplete: "off", "aria-label": tr("gif.searchLabel") });
  const grid = h("div", { class: "gif-grid" });
  const status = h("span", { class: "hint", text: tr("gif.minChars") });
  let ctl = null;
  let timer = 0;
  let shown = [];
  const run = async (q) => {
    ctl?.abort();
    ctl = new AbortController();
    const signal = ctl.signal;
    status.textContent = tr("gif.searching");
    let results;
    try {
      results = await giphy.search(config, q, { maxBytes: GIF_MAX_BYTES, signal, lang: i18n.language() });
    } catch (x) {
      if (x?.name === "AbortError" || !alive()) return;
      status.textContent = say(x);
      return;
    }
    if (!alive() || signal.aborted) return;
    status.textContent = tr(results.length ? "gif.tapToSave" : "gif.noHits");
    for (const u of shown) URL.revokeObjectURL(u);
    shown = [];
    put(grid, results.map((r) => {
      const img = h("img", { alt: r.title || tr("gif.fromGiphy") });
      const tile = h("button", {
        type: "button",
        class: "gif-send",
        title: r.title ? tr("gif.saveNamed", { title: r.title }) : tr("gif.saveMine"),
        onclick: async () => {
          if (tile.classList.contains("busy") || tile.classList.contains("saved")) return;
          tile.classList.add("busy");
          try {
            await saveToCollection(await giphy.fetchGif(r.full, GIF_MAX_BYTES));
            tile.classList.add("saved");
          } catch (x) {
            toast(say(x));
          } finally {
            tile.classList.remove("busy");
          }
        },
      }, img, h("span", { class: "gif-ok", "aria-hidden": "true", text: "✓" }));
      // Previews as blobs (fetch, no cookies or referrer): no <img> points at GIPHY.
      giphy.fetchGif(r.preview, GIF_MAX_BYTES, signal).then((b) => {
        if (!alive() || signal.aborted) return;
        const u = URL.createObjectURL(b);
        shown.push(u);
        track(u);
        img.src = u;
      }, () => {});
      return tile;
    }));
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      ctl?.abort();
      status.textContent = tr("gif.minChars");
      put(grid);
      return;
    }
    timer = setTimeout(() => run(q), 450); // not a request per keystroke
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length >= 2) run(q);
    if (!canHover()) input.blur(); // on a phone: the keyboard goes, the results get the room
  });
  put(
    box,
    // Always there, but one short line: the details open on a tap (a phone has little room with the keyboard up).
    h(
      "details",
      { class: "warn-note", role: "note" },
      h("summary", {}, h("strong", { text: tr("gif.warnTitle") }), tr("gif.warnShort")),
      h("p", { text: tr("gif.warnLong") }),
    ),
    input,
    h("div", { class: "gif-status" }, status, h("span", { class: "giphy-mark", text: "Powered by GIPHY" })),
    grid,
  );
  if (canHover()) input.focus();
}

let renderSeq = 0;
async function renderThread() {
  if (!ui.thread || !current) return;
  const seq = ++renderSeq;
  const conv = current;
  const stored = await messenger.messages(conv);
  if (seq !== renderSeq || conv !== current) return;
  // Texts waiting for "Ångra" come last, until the sent message (same id) is stored.
  const ids = new Set(stored.map((m) => m.id));
  const msgs = [...stored, ...[...heldMsgs.values()].map((e) => e.m).filter((m) => m.conv === conv && !ids.has(m.id))];
  const nearBottom = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 80;
  const out = [];
  const seen = new Set();
  let lastDay = "";
  for (const m of msgs) {
    // Grouped by the local calendar day; the label is made when the group first shows ("Today" stays so until the
    // conversation is opened again).
    const d = i18n.dayKey(m.time);
    if (d !== lastDay) {
      let day = msgNodes.get(`day:${d}`)?.node;
      if (!day) msgNodes.set(`day:${d}`, { node: (day = h("div", { class: "day", text: dayLabel(m.time) })) });
      seen.add(`day:${d}`);
      out.push(day);
      lastDay = d;
    }
    const sig = messageSig(m);
    let entry = msgNodes.get(m.id);
    if (entry?.sig !== sig) msgNodes.set(m.id, (entry = { sig, node: message(m) }));
    seen.add(m.id);
    out.push(entry.node);
  }
  for (const id of msgNodes.keys()) if (!seen.has(id)) msgNodes.delete(id);
  if (!msgs.length) out.push(h("div", { class: "day", text: tr("conv.empty") }));
  reconcile(ui.thread, out);
  if (nearBottom || seq === 1) ui.scroll.scrollTop = ui.scroll.scrollHeight;
  // Opened from a search hit: the message in the middle, marked for a moment.
  if (jumpTo) {
    const node = msgNodes.get(jumpTo)?.node;
    jumpTo = null;
    if (node) {
      node.scrollIntoView({ block: "center" });
      node.classList.add("found");
      setTimeout(() => node.classList.remove("found"), 2500);
    }
  }
  watchUnseen();
  tickFuses();
}

// ── disappearing messages: when they are seen, and their countdown ──────────────────────────────────────────────

/** How long before the end a disappearing message fades and folds away (ms; the same as the CSS animation). */
const DISSOLVE = 3000;
let seenObserver = null;
const inView = new Set(); // received disappearing messages on the screen whose countdown has not started

/** Watch the received disappearing messages of the thread that have not been seen yet. */
function watchUnseen() {
  if (seenObserver?.root !== ui.scroll) {
    seenObserver?.disconnect();
    inView.clear();
    seenObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = e.target.dataset.unseen;
        if (!e.target.isConnected) seenObserver.unobserve(e.target); // replaced by a newer drawing of the message
        if (e.isIntersecting && e.target.isConnected) inView.add(id);
        else inView.delete(id);
      }
      markSeen();
    }, { root: ui.scroll, threshold: 0.6 });
  }
  for (const el of ui.thread.querySelectorAll(".msg[data-unseen]")) seenObserver.observe(el);
}

/** Start the countdown of what is on the screen, while the page is visible. */
function markSeen() {
  if (!inView.size || !current || document.visibilityState !== "visible") return;
  const ids = [...inView];
  inView.clear();
  messenger.markSeen(current, ids).catch(() => {});
}
document.addEventListener("visibilitychange", markSeen);

/** Update the countdowns in the thread; the last DISSOLVE ms fade the message out and fold its row away. */
function tickFuses() {
  if (!ui.thread) return;
  const now = Date.now();
  for (const el of ui.thread.querySelectorAll(".fuse[data-end]")) {
    const left = Number(el.dataset.end) - now;
    el.textContent = remainingLabel(left);
    const msg = el.closest(".msg");
    if (left <= DISSOLVE && msg && !msg.classList.contains("dissolve")) {
      msg.style.setProperty("--h", `${msg.offsetHeight}px`);
      msg.style.animationDelay = `${Math.min(0, left - DISSOLVE)}ms`; // opened late: join the animation where it is
      msg.classList.add("dissolve");
    }
  }
}
setInterval(tickFuses, 250);

/** The timer under a disappearing message: the countdown once it runs, before that what it will be. */
function fuseView(m) {
  const s = icon("timer", 12);
  if (m.expires) {
    const end = messenger.deadline(m);
    return h("span", { class: "fuse-wrap", title: tr("timer.running") }, s, h("span", { class: "fuse", "data-end": String(end), text: remainingLabel(end - Date.now()) }));
  }
  const waiting = tr(m.dir === "out" ? "timer.afterDelivery" : "timer.afterReading", { time: ttlLabel(m.ttl) });
  return h("span", { class: "fuse-wrap waiting", title: waiting }, s, h("span", { text: ttlLabel(m.ttl) }));
}

/** Everything `message(m)` shows: when it is the same, the node made before is still right. */
function messageSig(m) {
  const f = m.file;
  return JSON.stringify([
    m.kind, m.text, m.time, m.dir, m.delivered, m.reactions ?? null, m.edited ?? 0, m.held ? (m.firing ? 2 : 1) : 0, m.ttl ?? null, m.expires ?? null,
    f ? [f.f, f.have, f.missed ?? null, f.peers ?? null, f.mime === "image/gif" && gifHashes.has(f.sha256)] : null,
    messenger.contacts.get(m.conv)?.state, sending.has(m.id),
  ]);
}

/** "Skickar … %" under an outgoing file on its way, updated in place (no new render for each part). */
function sendingNote(id) {
  const share = sending.get(id);
  return h("span", { class: "pending sending", "data-id": id, text: tr("msg.sending", { pct: percent(share ?? 0) }) });
}

function showSending(id) {
  for (const el of ui.thread?.querySelectorAll(".sending") ?? []) {
    if (el.dataset.id === id) el.textContent = tr("msg.sending", { pct: percent(sending.get(id) ?? 0) });
  }
}

/** The menu under a message: edit (own text, recent), delete for everyone (own, recent) or for me. */
function moreButton(m) {
  const btn = h("button", { type: "button", class: "react-btn more-btn", "aria-label": tr("msg.moreLabel"), title: tr("msg.moreTitle"), "aria-haspopup": "dialog" }, icon("more"));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    messageMenu(m);
  });
  return btn;
}

/** The undo button of a text waiting to be sent, where the menu of a sent message is. */
function undoButton(m) {
  return h("button", {
    type: "button", class: "undo-btn", "aria-label": tr("compose.undoLabel"), title: tr("compose.undoTitle"),
    onclick: (ev) => { ev.stopPropagation(); heldMsgs.get(m.id)?.undo(); },
  }, icon("undo"));
}

/** Change the text of an own message for everyone. */
function editDialog(m) {
  const ta = h("textarea", { rows: 4, dir: "auto", maxlength: 8000, "aria-label": tr("edit.textLabel") });
  ta.value = m.text ?? "";
  const save = async () => {
    const text = ta.value.trim();
    if (!text) return toast(say({ code: "empty_text" }));
    d.close();
    try {
      await messenger.edit(m.conv, m.id, text);
    } catch (x) {
      toast(say(x));
    }
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
  const d = dialog(
    h("h2", { text: tr("edit.title") }),
    h("div", { class: "field" }, ta),
    h("p", { class: "hint", text: tr("edit.hint", { name: personName(m.conv) }) }),
    h("div", { class: "actions" }, h("button", { class: "btn", text: tr("common.cancel"), onclick: () => d.close() }), h("button", { class: "btn primary", text: tr("common.save"), onclick: save })),
  );
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function messageMenu(m) {
  const forAll = m.kind !== "retracted" && messenger.canRetract(m);
  const canEdit = messenger.canEdit(m);
  const run = async (fn, done) => {
    d.close();
    try {
      await fn();
      toast(done);
    } catch (x) {
      toast(say(x));
    }
  };
  const d = dialog(
    h("h2", { text: tr(m.kind === "retracted" ? "msg.deleteTombstone" : canEdit ? "msg.editOrDelete" : "msg.deleteQuestion") }),
    forAll ? h("p", { class: "hint", text: tr("msg.forAllHint", { name: personName(m.conv) }) }) : null,
    !forAll && m.dir === "out" && m.kind !== "retracted" ? h("p", { class: "hint", text: tr("msg.tooLateHint") }) : null,
    h("p", { class: "hint", text: tr("msg.forMeHint", { name: personName(m.conv) }) }),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", text: tr("common.cancel"), onclick: () => d.close() }),
      canEdit ? h("button", { class: "btn", text: tr("msg.edit"), onclick: () => { d.close(); editDialog(m); } }) : null,
      h("button", { class: "btn danger", text: tr("msg.forMe"), onclick: () => run(() => messenger.deleteForMe(m.conv, m.id), tr("msg.removedForMe")) }),
      forAll ? h("button", { class: "btn danger", text: tr("msg.forAll"), onclick: () => run(() => messenger.retract(m.conv, m.id), tr("msg.removedForAll")) }) : null,
    ),
  );
}

function retractedView(m) {
  const text = m.dir === "out" ? tr("msg.youRemoved") : tr("msg.theyRemoved", { name: personName(m.conv) });
  const meta = h("div", { class: "meta" }, timeView(m.time), moreButton(m));
  return h("div", { class: `msg ${m.dir} retracted` }, h("div", { class: "body", text }), meta);
}

function message(m) {
  if (m.kind === "retracted") return retractedView(m);
  const body = m.kind === "file" ? fileView(m) : h("div", { class: emoji.emojiOnly(m.text) ? "body jumbo" : "body", dir: "auto", text: m.text ?? "" });
  const media = m.kind === "file" ? " media" : "";
  const meta = h("div", { class: "meta" }, timeView(m.time));
  if (m.kind === "ephemeral") meta.append(fuseView(m));
  if (m.edited) meta.append(h("span", { class: "edited", text: tr("msg.edited"), title: tr("msg.editedAt", { when: i18n.dateTime(m.edited) }) }));
  if (m.held) {
    // Waiting for "Ångra": looks like a sent message; not on the server yet, so no delivery mark.
    if (!m.firing) meta.append(undoButton(m));
    return h("div", { class: `msg out held${m.kind === "ephemeral" ? " ephemeral" : ""}` }, body, meta);
  }
  if (sending.has(m.id)) meta.append(sendingNote(m.id));
  else if (Messenger.undelivered(m)) {
    meta.append(
      h("span", { class: "pending", text: tr("msg.notYet") }),
      h("button", {
        class: "link",
        text: tr("msg.tryNow"),
        onclick: async () => {
          try {
            toast(tr((await messenger.flushFiles()) ? "msg.sentToast" : "msg.peerAway"));
          } catch (x) {
            toast(say(x));
          }
        },
      }),
    );
  }
  else if (m.dir === "out" && m.delivered !== undefined) meta.append(deliveryMark(m));
  if (m.kind === "file" && m.file?.have && m.file.mime === "image/gif") meta.append(saveGifButton(m));
  const canReact = messenger.canReact(m);
  if (canReact) meta.append(reactButton(m));
  meta.append(moreButton(m));
  // A picture carries its time on itself; text ends with it on the last line, as long as it fits there.
  const shown = media ? h("div", { class: "frame" }, body, meta) : [body, meta];
  const node = h("div", { class: `msg ${m.dir}${media}${m.kind === "ephemeral" ? " ephemeral" : ""}` }, shown, reactionsView(m, canReact));
  if (m.kind === "ephemeral" && m.dir === "in" && !m.expires) node.dataset.unseen = m.id;
  return node;
}

// ── saving GIFs from a conversation ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 of the GIFs in the collection, to show which GIFs of a conversation are already saved. */
let gifHashes = new Set();
async function refreshGifHashes() {
  gifHashes = new Set((await messenger.gifs()).map((g) => g.sha256));
}

/** Save a GIF (a Blob) in the collection and say how it went; throws what Messenger.saveGif throws. */
async function saveToCollection(blob) {
  const r = await messenger.saveGif(blob);
  toast(tr(r === "exists" ? "gif.exists" : "gif.savedToast"));
}

/** "Spara GIF" under a GIF in the thread (also in the viewer): into the collection, on all own devices. */
function saveGifButton(m) {
  const saved = gifHashes.has(m.file.sha256);
  return h("button", {
    type: "button",
    class: saved ? "save-gif-inline saved" : "save-gif-inline",
    text: tr(saved ? "gif.savedMark" : "gif.saveButton"),
    title: tr(saved ? "gif.inMine" : "gif.saveMine"),
    disabled: saved,
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await saveToCollection(await messenger.fileBlob(m.file.f, "image/gif"));
      } catch (x) {
        btn.disabled = false;
        toast(say(x));
      }
    },
  });
}

// ── reactions ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The reactions offered with one tap; the rest of the emoji are one more tap away. */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

async function react(m, e) {
  try {
    await messenger.react(m.conv, m.id, e);
  } catch (x) {
    toast(say(x));
  }
}

function personName(account) {
  if (account === messenger.me.account) return tr("common.you");
  return splitHandle(messenger.contacts.get(account)?.handle ?? "")[0] || tr("common.someoneName");
}

/** The reactions under a message: one chip per emoji; tapping one's own takes it back, another's adds the same. */
function reactionsView(m, canReact) {
  const by = new Map();
  for (const [who, r] of Object.entries(m.reactions ?? {})) {
    if (!r?.e) continue;
    if (!by.has(r.e)) by.set(r.e, []);
    by.get(r.e).push(who);
  }
  if (!by.size) return null;
  return h("div", { class: "reactions" }, [...by].map(([e, who]) => {
    const mine = who.includes(messenger.me.account);
    const names = who.map(personName).join(", ");
    return h("button", {
      type: "button",
      class: mine ? "reaction mine" : "reaction",
      title: mine ? tr("react.tapToRemove", { names }) : names,
      "aria-label": tr("react.from", { e, names }),
      disabled: !canReact,
      onclick: () => react(m, mine ? "" : e),
    }, h("span", { text: e }), who.length > 1 ? h("span", { class: "n", text: String(who.length) }) : null);
  }));
}

function reactButton(m) {
  const btn = h("button", { type: "button", class: "react-btn", "aria-label": tr("react.label"), title: tr("react.label"), "aria-haspopup": "menu" }, icon("smile"));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    reactMenu(btn, m);
  });
  return btn;
}

/** A small row of quick reactions by the message, and "more" for the whole emoji picker. */
function reactMenu(anchor, m) {
  const open = document.querySelector(".react-menu");
  open?.remove();
  if (open?.dataset.id === m.id) return; // the same button again closes it
  const mine = m.reactions?.[messenger.me.account]?.e;
  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", esc, true);
  };
  const outside = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); anchor.focus(); } };
  const menu = h(
    "div",
    { class: "react-menu", role: "menu", "aria-label": tr("react.label") },
    QUICK_REACTIONS.map((e) => h("button", {
      type: "button",
      role: "menuitem",
      class: e === mine ? "on" : "",
      text: e,
      title: e === mine ? tr("react.removeMine") : tr("react.with", { e }),
      onclick: () => { close(); react(m, e === mine ? "" : e); },
    })),
    h("button", { type: "button", role: "menuitem", class: "more", "aria-label": tr("react.more"), title: tr("react.more"), onclick: () => { close(); reactDialog(m); } }, icon("plus")),
  );
  menu.dataset.id = m.id;
  anchor.closest(".msg").append(menu);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", esc, true);
  menu.querySelector("button")?.focus({ preventScroll: true });
}

function reactDialog(m) {
  const panel = h("div", { class: "picker in-dialog" });
  const d = dialog(
    h("h2", { text: tr("react.label") }),
    panel,
    h("div", { class: "actions" }, h("button", { class: "btn", text: tr("common.cancel"), onclick: () => d.close() })),
  );
  emojiPanel(panel, (e) => { d.close(); react(m, e); }, () => d.open).catch(() => {});
}

/** A ring while the server holds the message for the recipient, a ring with a check once a device of theirs has it. */
function deliveryMark(m) {
  const done = !!m.delivered;
  const label = tr(done ? "msg.delivered" : "msg.queued");
  const s = icon(done ? "ringCheck" : "ring", 14);
  return h("span", { class: `delivery${done ? " ok" : ""}`, role: "img", "aria-label": label, title: label }, s);
}

/** A picture full size: closed by the cross, a tap anywhere, Escape or the back button. */
function showImage(url, name, gif = null) {
  const save = gif
    ? h("button", {
        class: "btn small save-gif",
        text: tr("gif.saveInMine"),
        onclick: async (e) => {
          e.stopPropagation(); // a click anywhere else closes the viewer
          try {
            await saveToCollection(await gif());
            d.close();
          } catch (x) {
            toast(say(x));
          }
        },
      })
    : null;
  const d = dialog(
    h("button", { class: "close", "aria-label": tr("common.close"), title: tr("common.close"), onclick: () => d.close() }, icon("close")),
    h("img", { src: url, alt: name }),
    save,
  );
  d.classList.add("viewer");
  d.addEventListener("click", () => d.close());
}

/** Give a picture its shown size before it has loaded, so the thread does not jump when it comes. */
function placeImage(img, { width, height }) {
  if (!(width > 0 && height > 0)) return;
  const scale = Math.min(1, 420 / width, 420 / height);
  img.style.width = `${Math.round(width * scale)}px`;
  img.style.aspectRatio = `${width} / ${height}`;
}

function fileView(m) {
  const f = m.file;
  if (f.have && p.inlineVideo(f.mime)) return imgNodes.get(f.f) ?? fileCard(m, null, true);
  if (f.have && p.inlineImage(f.mime, f.size)) {
    const made = imgNodes.get(f.f);
    if (made) return made;
    // The dimensions are read from the header first: a small file can decode to gigabytes and freeze the tab.
    const img = h("img", { class: "inline", alt: f.name });
    imgNodes.set(f.f, img);
    const known = imgSizes.get(f.f);
    if (known) placeImage(img, known);
    messenger.imageSize(f.f).then(async (size) => {
      if (!p.imageFits(size)) {
        const why = size ? tr("msg.tooBig", { w: i18n.num(size.width), h: i18n.num(size.height) }) : tr("msg.cannotShow");
        const card = fileCard(m, why);
        imgNodes.set(f.f, card);
        img.replaceWith(card);
        return;
      }
      imgSizes.set(f.f, { width: size.width, height: size.height });
      placeImage(img, size);
      const b = await messenger.fileBlob(f.f, f.mime);
      if (!b) return;
      const url = objectUrls.get(f.f) ?? URL.createObjectURL(b);
      objectUrls.set(f.f, url);
      img.addEventListener("load", () => {
        if (ui.scroll && ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < img.height + 160) ui.scroll.scrollTop = ui.scroll.scrollHeight;
      });
      img.src = url;
      const gif = f.mime === "image/gif" ? () => messenger.fileBlob(f.f, "image/gif") : null;
      img.addEventListener("click", () => showImage(url, f.name, gif));
    }).catch(() => {
      const card = fileCard(m);
      imgNodes.set(f.f, card);
      img.replaceWith(card);
    });
    return img;
  }
  return fileCard(m);
}

/**
 * Play a video in the conversation in place of its card: the file is put together from its stored parts only now,
 * when asked for. A video the browser cannot decode goes back to a card that says so.
 */
async function playVideo(m, card) {
  const f = m.file;
  const b = await messenger.fileBlob(f.f, f.mime);
  if (!b || !card.isConnected) return;
  const url = objectUrls.get(f.f) ?? URL.createObjectURL(b);
  objectUrls.set(f.f, url);
  const video = h("video", { class: "inline", controls: true, autoplay: true, playsinline: true, preload: "metadata" });
  const box = h("div", { class: "videobox" }, video, fileCard(m));
  video.addEventListener("error", () => {
    const c = fileCard(m, tr("msg.cannotPlay"));
    imgNodes.set(f.f, c);
    box.replaceWith(c);
  });
  // Playing it from the bottom of the thread: the thread stays at the bottom as the video takes its height.
  const atBottom = () => ui.scroll && ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < box.offsetHeight + 160;
  video.addEventListener("loadedmetadata", () => { if (atBottom()) ui.scroll.scrollTop = ui.scroll.scrollHeight; });
  video.src = url;
  imgNodes.set(f.f, box);
  card.replaceWith(box);
}

/**
 * A file as a card with its name, size and "Spara" (or a way to fetch it); `note` is said after the size. `play`: a
 * video, with a button that plays it here.
 */
function fileCard(m, note, play = false) {
  const f = m.file;
  const action = f.have
    ? h("button", { class: "btn small", text: tr("common.save"), onclick: async () => download(f.name, await messenger.fileBlob(f.f, "application/octet-stream")) })
    : h("button", {
        class: "btn small",
        text: tr("msg.fetchOwn"),
        title: tr("msg.fetchOwnTitle"),
        onclick: async () => {
          try {
            const n = await messenger.fetchFromOwnDevices(current, f.f);
            toast(tr(n ? "msg.asking" : "msg.noOwn"));
          } catch (x) {
            toast(say(x));
          }
        },
      });
  const onPlay = (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    playVideo(m, btn.closest(".filecard")).catch((x) => {
      btn.disabled = false;
      toast(say(x));
    });
  };
  return h(
    "div",
    { class: "filecard" },
    play
      ? h("button", { type: "button", class: "ico play", "aria-label": tr("msg.play"), title: tr("msg.play"), onclick: onPlay }, icon("play", 20))
      : h("div", { class: "ico", text: (f.name.split(".").pop() || tr("msg.file")).slice(0, 4).toUpperCase() }),
    h("div", { class: "fi" }, h("div", { class: "fn", dir: "auto", text: f.name }), h("div", { class: "fs", text: f.have ? (note ? `${bytes(f.size)} · ${note}` : bytes(f.size)) : `${bytes(f.size)} · ${tr(m.dir === "in" ? "msg.notReceived" : "msg.notHere")}` })),
    action,
  );
}

// ── dialogs ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function showSafety(c) {
  const code = h("div", { class: "code", text: "…" });
  const d = dialog(
    h("h2", { text: tr("conv.safety") }),
    h("p", { text: tr("safety.compare", { handle: c.handle }) }),
    code,
    h("p", { class: "hint", text: tr("safety.changes") }),
    h("div", { class: "actions" }, h("button", { class: "btn", text: tr("common.close"), onclick: () => d.close() })),
  );
  try {
    code.textContent = await messenger.safetyCode(c.account);
  } catch (x) {
    code.textContent = say(x);
  }
}

function showContactMenu(c) {
  const d = dialog(
    h("h2", { text: c.handle }),
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:8px" },
      c.state === "accepted" ? h("button", { class: "btn", text: tr("contact.showSafety"), onclick: () => { d.close(); showSafety(c); } }) : null,
      retentionPicker(c),
      c.state !== "blocked" ? h("button", { class: "btn danger", text: tr("conv.block"), onclick: () => messenger.setState(c.account, "blocked").then(() => { d.close(); openConversation(null); }) }) : null,
      h("button", { class: "btn danger", text: tr("contact.delete"), onclick: () => messenger.setState(c.account, "declined").then(() => { d.close(); openConversation(null); }) }),
    ),
    h("div", { class: "actions" }, h("button", { class: "btn", text: tr("common.close"), onclick: () => d.close() })),
  );
}

/** How long the messages of a conversation are kept on this account's devices. */
function retentionPicker(c) {
  const current = validRetention(c.retention) ? c.retention : 0;
  const choices = RETENTIONS.some(([s]) => s === current) ? RETENTIONS : [...RETENTIONS, [current]];
  const select = h(
    "select",
    {
      class: "input",
      id: "retention",
      onchange: () => {
        const r = Number(select.value);
        messenger.setRetention(c.account, r).then(
          () => toast(r ? tr("contact.retentionSet", { time: retentionLabel(r) }) : tr("contact.retentionOff")),
          (x) => toast(say(x)),
        );
      },
    },
    ...choices.map(([s]) => h("option", { value: String(s), text: retentionLabel(s), selected: s === current })),
  );
  return h(
    "label",
    { class: "field" },
    h("span", { text: tr("contact.keep") }),
    select,
    h("span", { class: "hint", text: tr("contact.keepHint") }),
  );
}

function showLinkRequest({ request, code }) {
  const d = dialog(
    h("h2", { text: tr("linkReq.title") }),
    h("p", {}, h("strong", { text: request.device.label || tr("linkReq.unknown") }), tr("linkReq.text")),
    h("p", { class: "hint", text: tr("linkReq.compare") }),
    h("div", { class: "code", text: code }),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", text: tr("conv.decline"), onclick: () => { messenger.declineLink(request); d.close(); } }),
      h("button", {
        class: "btn primary",
        text: tr("linkReq.approve"),
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await messenger.approveLink(request);
            toast(tr("linkReq.done"));
            d.close();
          } catch (x) {
            toast(say(x));
            e.target.disabled = false;
          }
        },
      }),
    ),
  );
}

function showAccountMenu() {
  const s = settings();
  const notice = h("input", { type: "checkbox", checked: s.notify && notify.permission() === "granted" });
  const noticeHint = h("span", { class: "hint", style: "display:block", text: tr("acct.notifyHint") });
  notice.addEventListener("change", async () => {
    notice.disabled = true;
    const text = await setNotifications(notice.checked).catch((x) => say(x));
    notice.checked = settings().notify;
    notice.disabled = false;
    toast(text);
  });
  const queue = h("input", { type: "checkbox", checked: s.fileQueue, disabled: !info.file_queue });
  queue.addEventListener("change", () => setSetting("fileQueue", queue.checked));
  const undo = h("input", { type: "checkbox", checked: s.undoSend });
  undo.addEventListener("change", () => setSetting("undoSend", undo.checked));
  const d = dialog(
    h("h2", { text: messenger.handle }),
    h("p", { class: "hint", text: homeLabel(messenger.home) ? tr("acct.yourHandleFrom", { home: homeLabel(messenger.home) }) : tr("acct.yourHandle") }),
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:8px" },
      h("button", { class: "btn", text: tr("acct.copy"), onclick: () => copyHandle()?.then(() => d.close()) }),
      h("button", { class: "btn", text: tr("acct.devices"), onclick: () => { d.close(); showDevices(); } }),
      h("button", { class: "btn", text: tr("help.title"), onclick: () => { d.close(); showHelp(); } }),
      h("label", { class: "check" }, notice, h("span", {}, tr("acct.notify"), noticeHint)),
      h(
        "label",
        { class: "check" },
        queue,
        h(
          "span",
          {},
          tr("acct.queue"),
          h("span", { class: "hint", style: "display:block", text: tr(info.file_queue ? "acct.queueHint" : "acct.queueOff") }),
          queueMaxFile() > 0 ? h("span", { class: "hint", style: "display:block", text: tr("acct.queueLimit", { size: bytes(queueMaxFile()) }) }) : null,
        ),
      ),
      h(
        "label",
        { class: "check" },
        undo,
        h("span", {}, tr("acct.undo"), h("span", { class: "hint", style: "display:block", text: tn("acct.undoHint", UNDO_SEND / 1000) })),
      ),
      h("div", { class: "field", style: "margin:6px 0 0" }, h("label", { text: tr("theme.label") }), themePicker()),
      h("div", { class: "field", style: "margin:6px 0 0" }, h("label", { text: tr("common.language") }), languagePicker(() => { d.close(); renderShell(); showAccountMenu(); })),
      h("button", { class: "btn danger", text: tr("acct.logout"), onclick: () => { d.close(); logout(false); } }),
    ),
    h("div", { class: "actions" }, h("button", { class: "btn", text: tr("common.close"), onclick: () => d.close() })),
  );
}

async function showDevices() {
  const list = h("div", {}, h("span", { class: "spinner" }));
  const paper = h("div", { class: "paperbox" });
  const d = dialog(
    h("h2", { text: tr("dev.title") }),
    h("p", { class: "hint", text: tr("dev.hint") }),
    list,
    paper,
    h("div", { class: "actions" }, h("button", { class: "btn", text: tr("common.close"), onclick: () => d.close() })),
  );
  const render = async () => {
    const [own, seen] = await Promise.all([messenger.ownList(true), messenger.ownSeen()]);
    const keys = own.present.filter(p.isPaper);
    const browsers = own.present.filter((x) => !p.isPaper(x));
    put(
      list,
      browsers.length === 1 && !keys.length
        ? h("p", { class: "lone", text: tr("dev.lone") })
        : null,
      ...own.present.map((dev) =>
        h(
          "div",
          { class: "dev" },
          h(
            "div",
            { class: "l" },
            h("div", { text: p.isPaper(dev) ? tr("paper.label") : dev.id === messenger.me.device ? tr("dev.this", { label: dev.label }) : dev.label }),
            p.isPaper(dev)
              ? h("div", { class: "hint", text: tr("dev.paperHint") })
              : [
                  h("div", { class: "seen", text: lastSeen(dev.id === messenger.me.device ? 0 : seen[dev.id]) }),
                  h("div", { class: "id", text: dev.id }),
                ],
          ),
          dev.id === messenger.me.device
            ? null
            : h("button", {
                class: "btn small danger",
                text: tr("common.remove"),
                onclick: async () => {
                  try {
                    if (p.isPaper(dev) && !confirm(tr("dev.removePaper"))) return;
                    await messenger.removeDevice(dev.id);
                    await render();
                  } catch (x) {
                    toast(say(x));
                  }
                },
              }),
        ),
      ),
    );
    put(
      paper,
      h("h3", { text: tr("paper.label") }),
      h("p", { class: "hint", text: tr(keys.length ? "dev.haveKey" : "dev.keyIntro") }),
      h("button", { class: "btn", text: tr(keys.length ? "dev.newKey" : "lone.make"), onclick: () => { d.close(); showPaperKey(); } }),
    );
  };
  render().catch((x) => list.replaceChildren(h("div", { class: "error", text: say(x) })));
}

/**
 * Make a paper key (docs/DESIGN.md §4.5): the password unlocks the vault's local secret again, the key is shown and
 * must be saved, and only then is it added to the device list (replacing an earlier one).
 */
function showPaperKey(onDone = () => {}) {
  const err = h("div", { class: "error" });
  const pw = h("input", { type: "password", autocomplete: "current-password" });
  const go = h("button", { class: "btn primary", type: "submit", text: tr("common.continue") });
  const body = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const restore = busy(go, tr("common.unlocking"));
        let secret;
        try {
          secret = await id.unlockLocalSecret(api, messenger.home, messenger.me.account, pw.value);
          pw.value = "";
          showPaperKeyText(d, await messenger.preparePaperKey(secret), onDone);
        } catch (x) {
          err.textContent = say(x);
          restore();
        } finally {
          secret?.fill(0);
        }
      },
    },
    h("p", { text: tr("pk.intro") }),
    h("div", { class: "field" }, h("label", { text: tr("pk.yourPassword") }), pw),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", text: tr("common.cancel"), onclick: () => d.close() }), go),
    err,
  );
  const d = dialog(h("h2", { text: tr("lone.make") }), body);
  pw.focus();
}

function showPaperKeyText(d, prepared, onDone) {
  const err = h("div", { class: "error" });
  const saved = h("input", { type: "checkbox" });
  const go = h("button", { class: "btn primary", text: tr("pk.activate"), disabled: true });
  saved.addEventListener("change", () => (go.disabled = !saved.checked));
  const name = tr("pk.fileName", { name: splitHandle(messenger.handle)[0] });
  const text = tr("pk.fileText", { handle: messenger.handle, key: prepared.text, noOther: tr("link.noOther") });
  go.addEventListener("click", async () => {
    const restore = busy(go, tr("pk.activating"));
    try {
      await prepared.commit();
      toast(tr("pk.activated"));
      setSetting("singleDeviceSeen", true);
      d.close();
      onDone();
    } catch (x) {
      err.textContent = say(x);
      restore();
    }
  });
  d.classList.add("printable");
  d.replaceChildren(
    h("h2", { text: tr("pk.title") }),
    h("p", { text: tr("pk.writeDown") }),
    h("pre", { class: "cardtext paperkey", text: prepared.text }),
    h(
      "div",
      { style: "display:flex;gap:8px;flex-wrap:wrap" },
      h("button", { class: "btn", text: tr("common.downloadText"), onclick: () => download(name, new Blob([text], { type: "text/plain" })) }),
      h("button", { class: "btn ghost", text: tr("common.print"), onclick: () => print() }),
    ),
    h("label", { class: "check" }, saved, h("span", { text: tr("pk.saved") })),
    h("div", { class: "actions" }, h("button", { class: "btn", text: tr("common.cancel"), onclick: () => d.close() }), go),
    err,
  );
}

async function logout(forget) {
  const account = messenger?.me.account;
  if (messenger && settings().notify) {
    // A logged-out device is not woken any more (the setting stays for the next login).
    await notify.unsubscribe().catch(() => {});
    await messenger.setPushEndpoint(null).catch(() => {});
  }
  messenger?.stop();
  messenger = null;
  current = null;
  ui.sideList = null;
  if (session) await id.logout(api, session.home, session.token);
  session = null;
  if (account) {
    const store = await Store.open(account);
    await store.remember(false);
    store.close();
    if (forget) {
      // This device was removed: its data is gone, so the login screen does not offer the account any more.
      await Store.destroy(account);
      await accounts.remove(account);
    } else {
      const rec = (await accounts.all()).find((a) => a.account === account);
      if (rec) await accounts.put({ ...rec, remembered: false });
    }
  }
  showAuth("login");
}

boot().catch((x) => {
  root.replaceChildren(h("div", { class: "center" }, h("div", { class: "auth card", text: say(x) })));
});
