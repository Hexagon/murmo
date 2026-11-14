// The user interface. Everything is built with DOM nodes and textContent: no HTML strings, no innerHTML.

import * as p from "./protocol.js";
import { Api, ApiError } from "./api.js";
import * as id from "./identity.js";
import { Messenger, Store, setupDevice } from "./core.js";
import { accounts } from "./store.js";
import * as rc from "../vendor/rootcard/src/index.js";

const api = new Api(location.origin);
const root = document.getElementById("app");
let messenger = null;
let session = null; // { token, home } while a rootcard session exists
let info = null; // what this server accepts (GET /api/v1/info)
let current = null; // open conversation (account id)
const objectUrls = new Map();

// ── tiny DOM helpers ────────────────────────────────────────────────────────────────────────────────────────────

/** `el.replaceChildren` without null, undefined or false children. */
function put(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") el.style.cssText = v; // CSSOM, allowed by the CSP (no style attributes)
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const ICONS = {
  send: "M4 12l16-8-6 16-2-7-8-1z",
  clip: "M16 7l-7.5 7.5a2.5 2.5 0 0 0 3.5 3.5L19.5 10.5a4.5 4.5 0 0 0-6.4-6.4L5.6 11.6a6.5 6.5 0 0 0 9.2 9.2L20 15.6",
  menu: "M4 6h16M4 12h16M4 18h16",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
};

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", "18");
  s.setAttribute("height", "18");
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

const MESSAGES = {
  bad_handle: "Ange en fullständig identifierare, till exempel Alice#3F9C.",
  unknown_account: "Ingen identitet med den identifieraren finns här.",
  ambiguous_handle: "Identifieraren är tvetydig. Använd den längre taggen.",
  not_home: "Identiteten finns inte på den här servern.",
  self: "Det är din egen identifierare.",
  no_devices: "Mottagaren har ingen ansluten enhet ännu.",
  weak_password: "Lösenordet måste ha minst 12 tecken och får inte vara användarnamnet.",
  bad_username: "Användarnamnet får bara innehålla A–Z, a–z, 0–9, _ . - (högst 32 tecken).",
  username_policy: "Det användarnamnet är inte tillåtet här.",
  handle_taken: "Identifieraren är upptagen. Försök igen.",
  bad_signature: "Fel lösenord.",
  rate_limited: "För många försök. Vänta en stund och försök igen.",
  not_accepted: "Konversationen är inte accepterad ännu.",
  fork: "Den här kontaktens enhetslista har ändrats på ett sätt som inte går att verifiera. Kontrollera säkerhetskoden.",
  too_large: "Filen är för stor (högst 100 MB).",
  offline: "Ingen anslutning till servern just nu.",
  unsupported_browser: "Webbläsaren saknar stöd för Ed25519/X25519 i WebCrypto.",
  home_not_allowed: "Den här mesg-servern tar inte emot identiteter från den rootcard-servern.",
  home_unreachable: "Det gick inte att nå rootcard-servern.",
  bad_home: "Ange ett domännamn, till exempel rootcard.org.",
  bad_proof: "Identiteten kunde inte bevisas för servern.",
  wrong_host: "Domänen pekar på en annan server.",
};

function say(err) {
  const code = err instanceof ApiError ? err.code : (err?.code ?? err?.message ?? String(err));
  return MESSAGES[code] ?? `Något gick fel (${code}).`;
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

function splitHandle(handle) {
  const i = handle.lastIndexOf("#");
  return i < 0 ? [handle, ""] : [handle.slice(0, i), handle.slice(i)];
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const b = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Webbläsare";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} på ${os}` : b;
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function clock(t) {
  return new Date(t * 1000).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(t) {
  const d = new Date(t * 1000);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return "Idag";
  if (d.toDateString() === y.toDateString()) return "Igår";
  return d.toLocaleDateString("sv-SE", { day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function greeting(name) {
  const hr = new Date().getHours();
  const part = hr < 5 ? "God natt" : hr < 10 ? "God morgon" : hr < 18 ? "Hej" : "God kväll";
  return `${part}, ${name}`;
}

// ── theme: auto (system), light or dark ─────────────────────────────────────────────────────────────────────────

const THEMES = [["auto", "Auto"], ["light", "Ljust"], ["dark", "Mörkt"]];

function theme() {
  try {
    return localStorage.getItem("mesg-theme") || "auto";
  } catch {
    return "auto";
  }
}

function setTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem("mesg-theme", t);
  } catch {
    // storage may be unavailable; the choice then lasts for this page only
  }
}

function themePicker() {
  const box = h("div", { class: "theme", role: "radiogroup", "aria-label": "Tema" });
  const render = () =>
    put(
      box,
      THEMES.map(([v, label]) =>
        h("button", { class: theme() === v ? "on" : "", role: "radio", "aria-checked": String(theme() === v), text: label, onclick: () => { setTheme(v); render(); } }),
      ),
    );
  render();
  return box;
}

setTheme(theme());

function homeLabel(home) {
  if (!home || home === api.base) return "";
  try {
    return new URL(home).host;
  } catch {
    return home;
  }
}

// ── start ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    await rc.checkSupport(); // throws unsupported_browser
  } catch {
    root.replaceChildren(h("div", { class: "center" }, h("div", { class: "auth card", text: MESSAGES.unsupported_browser })));
    return;
  }
  info = await api.info();
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
    h("button", { class: tab === "login" ? "on" : "", text: "Logga in", onclick: () => showAuth("login") }),
    h("button", { class: tab === "register" ? "on" : "", text: "Skapa konto", onclick: () => showAuth("register") }),
  );
  root.replaceChildren(
    h(
      "div",
      { class: "center" },
      h(
        "div",
        { class: "auth" },
        h("h1", { class: "brand" }, h("img", { src: "icon.svg", alt: "" }), "mesg"),
        h("p", { class: "tagline", text: "Krypterade meddelanden mellan dina enheter och dina kontakter." }),
        h("div", { class: "card" }, tabs, body, err),
        h("div", { class: "auth-foot" }, themePicker()),
      ),
    ),
  );
  if (tab === "login") loginForm(body, err, prefill);
  else registerForm(body, err);
}

function allowedHomes() {
  const homes = info?.homes ?? [];
  if (homes.includes("*")) return "valfri rootcard-server";
  return homes.map((h) => homeLabel(h) || h).join(", ");
}

async function loginForm(body, err, prefill) {
  const known = await accounts.all();
  const remote = h("input", { class: "input", placeholder: "rootcard.org", spellcheck: "false", autocomplete: "off" });
  let where = "local";
  const remoteField = h("div", { class: "field hidden" }, h("label", { text: "Domän där din identitet finns" }), remote, h("div", { class: "hint", text: `Den här servern tar emot identiteter från: ${allowedHomes() || "ingen annan"}.` }));
  const seg = h("div", { class: "seg" });
  const setWhere = (w) => {
    where = w;
    remoteField.classList.toggle("hidden", w !== "remote");
    put(
      seg,
      h("button", { type: "button", class: w === "local" ? "on" : "", text: "Den här servern", onclick: () => setWhere("local") }),
      (info?.homes ?? []).length ? h("button", { type: "button", class: w === "remote" ? "on" : "", text: "Annan rootcard-server", onclick: () => { setWhere("remote"); remote.focus(); } }) : null,
    );
  };
  setWhere("local");
  const handle = h("input", { class: "input", autocomplete: "username", placeholder: "Namn#TAGG", value: prefill, spellcheck: "false" });
  const pw = h("input", { class: "input", type: "password", autocomplete: "current-password" });
  const remember = h("input", { type: "checkbox" });
  const btn = h("button", { class: "btn primary", type: "submit", text: "Logga in" });
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
        btn.disabled = true;
        btn.replaceChildren(h("span", { class: "spinner" }), "Låser upp…");
        try {
          await loginAndEnter(where === "remote" ? remote.value : "", handle.value.trim(), pw.value, remember.checked);
        } catch (x) {
          err.textContent = say(x);
          btn.disabled = false;
          btn.replaceChildren("Logga in");
        }
      },
    },
    chips,
    h("div", { class: "field" }, h("label", { text: "Var finns din identitet?" }), seg),
    remoteField,
    h("div", { class: "field" }, h("label", { text: "Identifierare" }), handle),
    h("div", { class: "field" }, h("label", { text: "Lösenord" }), pw),
    h("label", { class: "check" }, remember, h("span", { text: "Kom ihåg den här enheten (låses upp utan lösenord)" })),
    btn,
  );
  body.replaceChildren(form);
  (prefill ? pw : handle).focus();
}

function registerForm(body, err) {
  const user = h("input", { class: "input", autocomplete: "username", placeholder: "till exempel Alice", spellcheck: "false" });
  const pw = h("input", { class: "input", type: "password", autocomplete: "new-password" });
  const pw2 = h("input", { class: "input", type: "password", autocomplete: "new-password" });
  const btn = h("button", { class: "btn primary", type: "submit", text: "Fortsätt" });
  body.replaceChildren(
    h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = "";
          if (pw.value !== pw2.value) return (err.textContent = "Lösenorden matchar inte.");
          btn.disabled = true;
          btn.replaceChildren(h("span", { class: "spinner" }), "Skapar nycklar…");
          try {
            const reg = await id.prepareRegistration(api, user.value.trim(), pw.value);
            showCard(reg, pw.value);
          } catch (x) {
            err.textContent = say(x);
            btn.disabled = false;
            btn.replaceChildren("Fortsätt");
          }
        },
      },
      h("div", { class: "field" }, h("label", { text: "Användarnamn" }), user),
      h("div", { class: "field" }, h("label", { text: "Lösenord (minst 12 tecken)" }), pw),
      h("div", { class: "field" }, h("label", { text: "Upprepa lösenordet" }), pw2),
      h("p", { class: "hint", text: "Du får en identifierare som Namn#TAGG. Andra kan bara nå dig om de vet den exakt – det går inte att söka efter användare." }),
      (info?.homes ?? []).length ? h("p", { class: "hint", text: `Har du redan en rootcard-identitet (${allowedHomes()})? Logga in med den i stället.` }) : null,
      btn,
    ),
  );
  user.focus();
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
  const go = h("button", { class: "btn primary", text: "Skapa konto", disabled: true });
  saved.addEventListener("change", () => (go.disabled = !saved.checked));
  const base = `${reg.card.username}-${reg.account.slice(0, 4)}`;
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.replaceChildren(h("span", { class: "spinner" }), "Skapar…");
    try {
      const done = await reg.finish();
      await loginAndEnter("", done.handle, password, false);
    } catch (x) {
      err.textContent = say(x);
      go.disabled = false;
      go.replaceChildren("Skapa konto");
    }
  });
  root.replaceChildren(
    h(
      "div",
      { class: "center" },
      h(
        "div",
        { class: "auth", style: "width:min(560px,100%)" },
        h("h1", { class: "brand", text: "Ditt återställningskort" }),
        h(
          "div",
          { class: "card" },
          h("p", { text: "Spara kortet innan kontot skapas. Det är det enda sättet att återställa ett glömt lösenord eller flytta identiteten. Den som har kortet kontrollerar identiteten – förvara det offline." }),
          h("pre", { class: "cardtext", text: reg.cardText }),
          h(
            "div",
            { style: "display:flex;gap:8px;flex-wrap:wrap" },
            h("button", { class: "btn", text: "Ladda ner kortfil", onclick: () => download(`${base}.rootcard-card.json`, new Blob([rc.canonicalString(reg.card)], { type: "application/json" })) }),
            h("button", { class: "btn", text: "Ladda ner som text", onclick: () => download(`${base}.rootcard-card.txt`, new Blob([reg.cardText], { type: "text/plain" })) }),
            h("button", { class: "btn ghost", text: "Skriv ut", onclick: () => print() }),
          ),
          h("label", { class: "check" }, saved, h("span", { text: "Jag har sparat mitt återställningskort på ett säkert ställe." })),
          go,
          err,
        ),
      ),
    ),
  );
}

async function loginAndEnter(homeInput, handle, password, remember) {
  const home = await id.resolveHome(api, homeInput);
  const login = await id.login(api, home, handle, password);
  try {
    const account = login.state.account;
    if (home !== api.base) await api.connect(account, home); // the server fetches and verifies the log at that home
    const secret = await id.localSecret(api, login);
    const store = await Store.open(account);
    await store.unlock(secret);
    secret.fill(0);
    await store.remember(remember);
    await accounts.put({ account, handle: login.state.handle, home, remembered: remember });
    const setup = await setupDevice({ api, store, state: login.state, login, label: deviceLabel() });
    session = { token: login.token, home };
    if (!setup.ready) {
      const ok = await showLinkWait(setup, login.state.handle);
      if (!ok) {
        store.close();
        showAuth("login", login.state.handle);
        return;
      }
    }
    await enter({ store, account, handle: login.state.handle, home });
  } finally {
    login.unlocked.contents.accountSeed.fill(0);
    login.unlocked.vaultKey?.fill?.(0);
  }
}

function showLinkWait(setup, handle) {
  return new Promise((resolve) => {
    const ctl = new AbortController();
    root.replaceChildren(
      h(
        "div",
        { class: "center" },
        h(
          "div",
          { class: "auth" },
          h("h1", { class: "brand", text: "Länka den här enheten" }),
          h(
            "div",
            { class: "card" },
            h("p", { text: `${handle} används redan på en annan enhet. Öppna mesg där och godkänn den här enheten. Kontrollera att koden är densamma på båda skärmarna.` }),
            h("div", { class: "code", text: setup.code }),
            h("p", { class: "hint" }, h("span", { class: "spinner" }), " Väntar på godkännande… (giltigt i 10 minuter)"),
            h("button", { class: "btn ghost", text: "Avbryt", onclick: () => { ctl.abort(); resolve(false); } }),
          ),
        ),
      ),
    );
    setup.waitForApproval(ctl.signal).then(resolve, () => resolve(false));
  });
}

// ── the main view ───────────────────────────────────────────────────────────────────────────────────────────────

async function enter({ store, account, handle, home }) {
  messenger = new Messenger({ api, store, account, handle, home, realms: info.realms });
  messenger.addEventListener("contacts", () => renderSidebar());
  messenger.addEventListener("messages", (e) => { if (e.detail.conv === current) renderThread(); renderSidebar(); });
  messenger.addEventListener("status", () => renderSidebar());
  messenger.addEventListener("link", (e) => showLinkRequest(e.detail));
  messenger.addEventListener("error", (e) => console.warn(e.detail.message));
  messenger.addEventListener("removed", async () => {
    toast("Den här enheten har tagits bort från kontot.");
    await logout(true);
  });
  await messenger.start();
  renderShell();
}

const ui = {};

function renderShell() {
  ui.sideList = h("nav", { class: "side-list", "aria-label": "Konversationer" });
  ui.foot = h("div", { class: "side-foot" });
  ui.main = h("main", { class: "main" });
  ui.shell = h(
    "div",
    { class: "shell" },
    h(
      "aside",
      { class: "sidebar" },
      h("div", { class: "side-top" }, h("div", { class: "logo" }, h("img", { src: "icon.svg", alt: "" }), "mesg")),
      h("button", { class: "btn newchat", onclick: () => openConversation(null) }, h("span", { class: "plus", text: "+" }), "Ny konversation"),
      ui.sideList,
      ui.foot,
    ),
    ui.main,
  );
  root.replaceChildren(ui.shell);
  renderSidebar();
  openConversation(current);
}

function renderSidebar() {
  if (!ui.sideList) return;
  const all = messenger.contactList().sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  const incoming = all.filter((c) => c.state === "incoming");
  const convs = all.filter((c) => c.state === "accepted" || c.state === "outgoing");
  const blocked = all.filter((c) => c.state === "blocked");
  const item = (c) => {
    const [name, tag] = splitHandle(c.handle);
    return h(
      "button",
      { class: `conv${c.account === current ? " on" : ""}`, onclick: () => { openConversation(c.account); ui.shell.classList.remove("open"); } },
      h("span", { class: "name" }, name, h("span", { class: "tag", text: tag })),
      c.state === "incoming" ? h("span", { class: "badge", text: "ny" }) : null,
      c.state === "outgoing" ? h("span", { class: "badge muted", text: "väntar" }) : null,
      c.fork ? h("span", { class: "badge", text: "!" }) : null,
    );
  };
  put(ui.sideList,
    incoming.length ? h("div", { class: "side-head", text: "Förfrågningar" }) : null,
    ...incoming.map(item),
    h("div", { class: "side-head", text: "Konversationer" }),
    ...(convs.length ? convs.map(item) : [h("div", { class: "hint", style: "padding:4px 10px", text: "Inga ännu." })]),
    blocked.length ? h("div", { class: "side-head", text: "Blockerade" }) : null,
    ...blocked.map(item),
  );
  const [name] = splitHandle(messenger.handle);
  put(ui.foot,
    h("div", { class: "avatar", text: name.slice(0, 1).toUpperCase() }),
    h(
      "div",
      { class: "me" },
      h("div", { class: "h", text: messenger.handle, title: "Klicka för att kopiera", onclick: () => navigator.clipboard?.writeText(messenger.handle).then(() => toast("Identifieraren kopierad.")) }),
      h("div", { class: "s" }, h("span", { class: `dot${messenger.status === "online" ? " on" : ""}` }), messenger.status === "online" ? "Ansluten" : "Ansluter…", homeLabel(messenger.home) ? ` · ${homeLabel(messenger.home)}` : ""),
    ),
    h("button", { class: "icon-btn", "aria-label": "Konto", title: "Konto", onclick: showAccountMenu }, icon("more")),
  );
}

function topbar(...children) {
  return h(
    "div",
    { class: "topbar" },
    h("button", { class: "icon-btn menu-btn", "aria-label": "Meny", onclick: () => ui.shell.classList.toggle("open") }, icon("menu")),
    ...children,
  );
}

function openConversation(account) {
  current = account;
  for (const u of objectUrls.values()) URL.revokeObjectURL(u);
  objectUrls.clear();
  renderSidebar();
  if (!account) return renderWelcome();
  const c = messenger.contacts.get(account);
  if (!c) return renderWelcome();
  const [name, tag] = splitHandle(c.handle);
  ui.thread = h("div", { class: "thread" });
  ui.scroll = h("div", { class: "scroll" }, ui.thread);
  const head = topbar(
    h("div", { class: "title" }, name, h("span", { class: "tag", text: tag }), homeLabel(c.home) ? h("span", { class: "home", text: ` · ${homeLabel(c.home)}` }) : null),
    c.state === "accepted" ? h("button", { class: "btn ghost small", onclick: () => showSafety(c) }, icon("shield"), "Säkerhetskod") : null,
    h("button", { class: "icon-btn", "aria-label": "Fler val", onclick: () => showContactMenu(c) }, icon("more")),
  );
  const parts = [head];
  if (c.fork) parts.push(h("div", { class: "banner warn", text: MESSAGES.fork }));
  else if (c.devicesChanged && c.state === "accepted") {
    parts.push(h("div", { class: "banner", text: `${c.handle} har ändrat sina enheter. Säkerhetskoden har ändrats.` }));
  }
  parts.push(ui.scroll);
  if (c.state === "incoming") parts.push(requestBox(c));
  else if (c.state === "outgoing") parts.push(h("div", { class: "request-box", text: `Förfrågan skickad. Du kan skriva när ${c.handle} har accepterat.` }));
  else if (c.state === "blocked") parts.push(h("div", { class: "request-box" }, h("span", { text: "Blockerad. " }), h("button", { class: "btn small", text: "Häv blockering", onclick: () => messenger.setState(c.account, "accepted").then(() => openConversation(c.account)) })));
  else parts.push(composer(c));
  put(ui.main,...parts);
  renderThread();
}

function requestBox(c) {
  return h(
    "div",
    { class: "request-box" },
    h("strong", { text: c.handle }),
    h("span", { text: " vill skicka meddelanden till dig." }),
    h("p", { class: "hint", text: "Inget mer från avsändaren visas förrän du accepterar." }),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn primary", text: "Acceptera", onclick: () => messenger.accept(c.account).then(() => openConversation(c.account), (x) => toast(say(x))) }),
      h("button", { class: "btn", text: "Neka", onclick: () => messenger.setState(c.account, "declined").then(() => openConversation(null)) }),
      h("button", { class: "btn danger", text: "Blockera", onclick: () => messenger.setState(c.account, "blocked").then(() => openConversation(null)) }),
    ),
  );
}

function renderWelcome() {
  const [name] = splitHandle(messenger.handle);
  const input = h("textarea", { rows: 1, placeholder: "Skriv en identifierare, till exempel Alice#3F9C", spellcheck: "false" });
  const note = h("input", { class: "input", placeholder: "Valfri hälsning (skickas med förfrågan)", maxlength: 500, style: "margin-top:10px" });
  const err = h("div", { class: "error", style: "margin-top:8px" });
  const send = h("button", { class: "send", "aria-label": "Skicka förfrågan" }, icon("send"));
  const go = async () => {
    err.textContent = "";
    if (!input.value.trim()) return;
    send.disabled = true;
    try {
      const c = await messenger.request(input.value.trim(), note.value.trim());
      openConversation(c.account);
    } catch (x) {
      err.textContent = say(x);
      send.disabled = false;
    }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } });
  note.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
  send.addEventListener("click", go);
  put(ui.main,
    topbar(h("div", { class: "title" })),
    h(
      "div",
      { class: "welcome" },
      h(
        "div",
        { class: "welcome-inner" },
        h("h1", { text: greeting(name) }),
        h("div", { class: "composer" }, input, h("div", { class: "row" }, h("span", { class: "grow", text: "Ny konversation – mottagaren måste acceptera innan ni kan skriva." }), send)),
        note,
        err,
        h("p", { class: "hint", style: "margin-top:18px" }, "Din identifierare är ", h("strong", { text: messenger.handle }), ". Dela den med dem du vill höra av." ),
      ),
    ),
  );
  input.focus();
}

function composer(c) {
  const ta = h("textarea", { rows: 1, placeholder: `Skriv till ${splitHandle(c.handle)[0]}…` });
  const file = h("input", { type: "file", class: "hidden", multiple: true });
  const send = h("button", { class: "send", "aria-label": "Skicka", disabled: true }, icon("send"));
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
    send.disabled = !ta.value.trim();
  };
  const submit = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    grow();
    try {
      await messenger.sendText(c.account, text);
    } catch (x) {
      ta.value = text;
      grow();
      toast(say(x));
    }
  };
  const sendFiles = async (files) => {
    for (const f of files) {
      try {
        const n = await messenger.sendFile(c.account, f);
        toast(n ? `${f.name} skickad till ${n} ansluten${n === 1 ? "" : "a"} enhet${n === 1 ? "" : "er"}.` : `${f.name}: ingen mottagarenhet var ansluten, så filen överfördes inte.`);
      } catch (x) {
        toast(say(x));
      }
    }
  };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  ta.addEventListener("paste", (e) => {
    const fs = [...(e.clipboardData?.files ?? [])];
    if (fs.length) { e.preventDefault(); sendFiles(fs); }
  });
  send.addEventListener("click", submit);
  file.addEventListener("change", () => { sendFiles([...file.files]); file.value = ""; });
  const box = h(
    "div",
    { class: "composer" },
    ta,
    h(
      "div",
      { class: "row" },
      h("button", { class: "icon-btn", "aria-label": "Bifoga fil", title: "Skicka fil (bara till enheter som är anslutna nu)", onclick: () => file.click() }, icon("clip")),
      h("span", { class: "grow" }),
      send,
    ),
    file,
  );
  const wrap = h("div", { class: "composer-wrap" }, box, h("div", { class: "foot-note", text: "Krypterat från enhet till enhet. Servern sparar inga meddelanden efter leverans och aldrig filer." }));
  wrap.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("drop"); });
  wrap.addEventListener("dragleave", () => box.classList.remove("drop"));
  wrap.addEventListener("drop", (e) => { e.preventDefault(); box.classList.remove("drop"); sendFiles([...e.dataTransfer.files]); });
  setTimeout(() => ta.focus());
  return wrap;
}

let renderSeq = 0;
async function renderThread() {
  if (!ui.thread || !current) return;
  const seq = ++renderSeq;
  const conv = current;
  const msgs = await messenger.messages(conv);
  if (seq !== renderSeq || conv !== current) return;
  const nearBottom = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 80;
  const out = [];
  let lastDay = "";
  for (const m of msgs) {
    const d = dayLabel(m.time);
    if (d !== lastDay) {
      out.push(h("div", { class: "day", text: d }));
      lastDay = d;
    }
    out.push(message(m));
  }
  if (!msgs.length) out.push(h("div", { class: "day", text: "Inga meddelanden ännu." }));
  put(ui.thread,...out);
  if (nearBottom || seq === 1) ui.scroll.scrollTop = ui.scroll.scrollHeight;
}

function message(m) {
  const body = m.kind === "file" ? fileView(m) : h("div", { class: "body", text: m.text ?? "" });
  const media = m.kind === "file" ? " media" : "";
  return h("div", { class: `msg ${m.dir}${media}` }, body, h("div", { class: "meta", text: clock(m.time) }));
}

function fileView(m) {
  const f = m.file;
  if (f.have && p.inlineImage(f.mime, f.size)) {
    const img = h("img", { class: "inline", alt: f.name });
    messenger.fileBlob(f.f, f.mime).then((b) => {
      if (!b) return;
      const url = objectUrls.get(f.f) ?? URL.createObjectURL(b);
      objectUrls.set(f.f, url);
      img.addEventListener("load", () => {
        if (ui.scroll && ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < img.height + 160) ui.scroll.scrollTop = ui.scroll.scrollHeight;
      });
      img.src = url;
      img.addEventListener("click", () => dialog(h("img", { src: url, alt: f.name })).classList.add("viewer"));
    });
    return img;
  }
  const action = f.have
    ? h("button", { class: "btn small", text: "Spara", onclick: async () => download(f.name, await messenger.fileBlob(f.f, "application/octet-stream")) })
    : h("button", {
        class: "btn small",
        text: "Hämta från mina enheter",
        title: "Filen överfördes bara till enheter som var anslutna. Den här frågar dina andra anslutna enheter.",
        onclick: async () => {
          try {
            const n = await messenger.fetchFromOwnDevices(current, f.f);
            toast(n ? "Frågar dina anslutna enheter…" : "Ingen av dina andra enheter är ansluten just nu.");
          } catch (x) {
            toast(say(x));
          }
        },
      });
  return h(
    "div",
    { class: "filecard" },
    h("div", { class: "ico", text: (f.name.split(".").pop() || "fil").slice(0, 4).toUpperCase() }),
    h("div", { class: "fi" }, h("div", { class: "fn", text: f.name }), h("div", { class: "fs", text: f.have ? bytes(f.size) : `${bytes(f.size)} · inte mottagen på den här enheten` })),
    action,
  );
}

// ── dialogs ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function showSafety(c) {
  const code = h("div", { class: "code", text: "…" });
  const d = dialog(
    h("h2", { text: "Säkerhetskod" }),
    h("p", { text: `Jämför koden med ${c.handle}, helst i person. Är den likadan på båda sidor sitter ingen – inte heller servern – mellan er.` }),
    code,
    h("p", { class: "hint", text: "Koden ändras när någon av er lägger till eller tar bort en enhet." }),
    h("div", { class: "actions" }, h("button", { class: "btn", text: "Stäng", onclick: () => d.close() })),
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
      c.state === "accepted" ? h("button", { class: "btn", text: "Visa säkerhetskod", onclick: () => { d.close(); showSafety(c); } }) : null,
      c.state !== "blocked" ? h("button", { class: "btn danger", text: "Blockera", onclick: () => messenger.setState(c.account, "blocked").then(() => { d.close(); openConversation(null); }) }) : null,
      h("button", { class: "btn danger", text: "Ta bort konversationen", onclick: () => messenger.setState(c.account, "declined").then(() => { d.close(); openConversation(null); }) }),
    ),
    h("div", { class: "actions" }, h("button", { class: "btn", text: "Stäng", onclick: () => d.close() })),
  );
}

function showLinkRequest({ request, code }) {
  const d = dialog(
    h("h2", { text: "Ny enhet vill länkas" }),
    h("p", {}, h("strong", { text: request.device.label || "Okänd enhet" }), " vill bli en enhet för ditt konto. Godkänn bara om du själv just loggade in där."),
    h("p", { class: "hint", text: "Kontrollera att koden är exakt densamma som på den nya enheten:" }),
    h("div", { class: "code", text: code }),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", text: "Neka", onclick: () => { messenger.declineLink(request); d.close(); } }),
      h("button", {
        class: "btn primary",
        text: "Godkänn",
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await messenger.approveLink(request);
            toast("Enheten är länkad. Historiken skickas till den.");
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
  const d = dialog(
    h("h2", { text: messenger.handle }),
    h("p", { class: "hint", text: `Din identifierare${homeLabel(messenger.home) ? ` (från ${homeLabel(messenger.home)})` : ""}. Den som vill nå dig behöver den exakt – det går inte att söka efter användare.` }),
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:8px" },
      h("button", { class: "btn", text: "Kopiera identifierare", onclick: () => navigator.clipboard?.writeText(messenger.handle).then(() => { toast("Identifieraren kopierad."); d.close(); }) }),
      h("button", { class: "btn", text: "Enheter", onclick: () => { d.close(); showDevices(); } }),
      h("div", { class: "field", style: "margin:6px 0 0" }, h("label", { text: "Tema" }), themePicker()),
      h("button", { class: "btn danger", text: "Logga ut", onclick: () => { d.close(); logout(false); } }),
    ),
    h("div", { class: "actions" }, h("button", { class: "btn", text: "Stäng", onclick: () => d.close() })),
  );
}

async function showDevices() {
  const list = h("div", {}, h("span", { class: "spinner" }));
  const d = dialog(
    h("h2", { text: "Dina enheter" }),
    h("p", { class: "hint", text: "Nya enheter läggs till genom att logga in på dem och godkänna här. Ett lösenord räcker inte för att lägga till en enhet." }),
    list,
    h("div", { class: "actions" }, h("button", { class: "btn", text: "Stäng", onclick: () => d.close() })),
  );
  const render = async () => {
    const own = await messenger.ownList(true);
    put(
      list,
      ...own.present.map((dev) =>
        h(
          "div",
          { class: "dev" },
          h("div", { class: "l" }, h("div", { text: dev.label + (dev.id === messenger.me.device ? " (den här)" : "") }), h("div", { class: "id", text: dev.id })),
          dev.id === messenger.me.device
            ? null
            : h("button", {
                class: "btn small danger",
                text: "Ta bort",
                onclick: async () => {
                  try {
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
  };
  render().catch((x) => list.replaceChildren(h("div", { class: "error", text: say(x) })));
}

async function logout(forget) {
  const account = messenger?.me.account;
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
    const rec = (await accounts.all()).find((a) => a.account === account);
    if (rec) await accounts.put({ ...rec, remembered: false });
    if (forget) await Store.destroy(account);
  }
  showAuth("login");
}

boot().catch((x) => {
  root.replaceChildren(h("div", { class: "center" }, h("div", { class: "auth card", text: say(x) })));
});
