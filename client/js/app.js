// The user interface. Everything is built with DOM nodes and textContent: no HTML strings, no innerHTML.

import * as p from "./protocol.js";
import { Api, ApiError } from "./api.js";
import * as id from "./identity.js";
import { GIF_MAX_BYTES, GIF_MAX_COUNT, Messenger, Store, setupDevice, validRetention } from "./core.js";
import * as emoji from "./emoji.js";
import * as giphy from "./giphy.js";
import { accounts } from "./store.js";
import * as notify from "./notify.js";
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
  back: "M15 5l-7 7 7 7",
  plus: "M12 5v14M5 12h14",
  ring: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17z",
  ringCheck: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17zM8 12.4l2.7 2.7L16 9.6",
  close: "M6 6l12 12M18 6L6 18",
  smile: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17zM8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01",
  clock: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17zM12 7.5V12l3 2",
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
  offline: "Ingen anslutning till servern just nu. Försök igen om en stund.",
  disconnected: "Anslutningen bröts. Försök igen.",
  timeout: "Servern svarade inte. Försök igen.",
  unsupported_browser: "Webbläsaren saknar stöd för Ed25519/X25519 i WebCrypto.",
  home_not_allowed: "Den här Murmo-servern tar inte emot identiteter från den rootcard-servern.",
  home_unreachable: "Det gick inte att nå rootcard-servern.",
  bad_home: "Ange ett domännamn, till exempel rootcard.org.",
  bad_proof: "Identiteten kunde inte bevisas för servern.",
  wrong_host: "Domänen pekar på en annan server.",
  bad_paper_key: "Det där är ingen giltig pappersnyckel. Kontrollera att alla tecken är rätt.",
  wrong_paper_key: "Pappersnyckeln hör inte till det här kontot, eller så har den ersatts av en nyare.",
  no_local_secret: "Kontot saknar lokal nyckel i valvet. Logga ut och in igen och försök sedan på nytt.",
  not_gif: "Det är inte en GIF-fil.",
  gif_too_large: "GIF:en är för stor för samlingen (högst 8 MB).",
  too_big_image: "Bilden har för många bildpunkter.",
  gifs_full: `Samlingen är full (högst ${GIF_MAX_COUNT} GIF:ar). Ta bort någon först.`,
  gif_missing: "GIF:en har inte kommit till den här enheten än.",
  giphy_limit: "GIPHY tar inte emot fler sökningar från den här servern just nu. Försök igen om en stund.",
  giphy_key: "GIPHY-nyckeln på servern fungerar inte. Säg till den som driver servern.",
  giphy_failed: "Det gick inte att nå GIPHY.",
  bad_reaction: "Det går bara att reagera med en emoji.",
  no_message: "Meddelandet finns inte längre.",
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

/** Choices for how long a conversation's messages are kept (seconds; 0: until the conversation is deleted). */
const RETENTIONS = [
  [0, "Tills vidare"],
  [3600, "1 timme"],
  [86400, "1 dag"],
  [7 * 86400, "1 vecka"],
  [30 * 86400, "30 dagar"],
  [365 * 86400, "1 år"],
];

function retentionLabel(r) {
  return RETENTIONS.find(([s]) => s === r)?.[1] ?? `${Math.round(r / 86400)} dagar`;
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

// ── settings of this browser, per account ───────────────────────────────────────────────────────────────────────

// notify: on unless the user turns it off (the browser still asks for its permission, see askNotifications).
const DEFAULTS = { notify: true, fileQueue: true, notifyPrompted: false };

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

const THEMES = [["auto", "Auto"], ["light", "Ljust"], ["dark", "Mörkt"]];

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

// ── how it works ────────────────────────────────────────────────────────────────────────────────────────────────

const FACTS = [
  "Krypteras i webbläsaren, separat till varje mottagande enhet (X25519 och AES-GCM), och signeras av den skickande enheten (Ed25519).",
  "Servern håller bara krypterade meddelanden tills de levererats, högst 14 dagar. Ingen historik, inga kontaktlistor.",
  "Ingen sökning: man når någon bara med exakt identifierare, och första meddelandet är en förfrågan.",
  "En ny enhet godkänns på en enhet du redan har. Ett lösenord räcker inte.",
  "Identiteten är en rootcard-identitet. Lösenordet lämnar aldrig webbläsaren.",
];

/** The short version, for the empty conversation list and the settings. */
function about() {
  return h(
    "div",
    { class: "about" },
    h("ul", {}, FACTS.map((t) => h("li", { text: t }))),
    h("button", { class: "link", type: "button", text: "Säkerhet och integritet i detalj", onclick: showHelp }),
  );
}

const HELP = [
  ["Kryptering", [
    "Varje meddelande krypteras på din enhet innan det skickas, en gång för varje enhet som ska läsa det: mottagarens enheter och dina egna andra enheter. Bara de enheterna har nycklarna. Servern, nätverket och den som driver tjänsten ser bara chiffertext.",
    "Varje meddelande signeras med den skickande enhetens nyckel. Mottagaren kontrollerar att det kommer från en enhet som finns i avsändarens enhetslista och att det var avsett för just den konversationen.",
    "Nycklarna som tar emot meddelanden byts varje vecka och raderas efter tre veckor. Den som senare stjäl en enhet kan alltså inte läsa äldre inspelad trafik, men meddelanden från de senaste veckorna kan läsas med en stulen, upplåst enhet.",
  ]],
  ["Identitet och enheter", [
    "Du identifieras med en rootcard-identitet, till exempel Namn#TAGG. Lösenordet används bara i webbläsaren för att låsa upp dina nycklar; det skickas aldrig till servern.",
    "Återställningskortet styr identiteten. Den som har det kan ta över den, så förvara det offline.",
    "En ny enhet läggs bara till när en av dina befintliga enheter godkänner den, efter att ni jämfört en kod. Ett stulet lösenord räcker alltså inte för att läsa dina meddelanden.",
    "En pappersnyckel kan godkänna en ny enhet när ingen annan finns kvar, men bara tillsammans med ditt lösenord: papperet ensamt ger ingen åtkomst. Den kan inte läsa några meddelanden, och historiken följer inte med.",
    "Säkerhetskoden i en konversation beräknas från båda parters enhetslistor. Är den likadan hos er båda sitter ingen – inte heller servern – mellan er. Koden ändras när någon lägger till eller tar bort en enhet, och du ser då en varning.",
  ]],
  ["Vad servern ser och sparar", [
    "Sparar: din identitet (för konton skapade här), varje kontos lista över enheter med publika nycklar, och krypterade meddelanden tills de hämtats, högst 14 dagar.",
    "Sparar inte: meddelandehistorik, kontaktlistor, vem du har accepterat eller blockerat, IP-adresser i loggar.",
    "Ser i stunden: vilken enhet som skickar till vilka enheter, när och hur mycket. Det är ett krav för att leverera, men det skrivs inte ner.",
    "Den som känner till din identifierare kan se när dina enheter är anslutna (det behövs för att skicka filer direkt).",
  ]],
  ["Filer", [
    "Filer krypteras med en egen nyckel som bara finns i det krypterade meddelandet om filen.",
    "Är mottagaren ansluten går filen direkt, via servern, utan att sparas. Är den inte ansluten kan servern hålla den krypterad tills mottagaren hämtat den, högst 14 dagar. Det går att stänga av under Konto och inställningar; då skickas filen i stället när ni båda är anslutna samtidigt. Servern ser filens ungefärliga storlek, aldrig namn eller innehåll.",
    "Emoji är vanlig text som ritas av enhetens eget typsnitt, och reaktioner skickas krypterade som andra meddelanden. GIF:ar skickas som filer. Dina sparade GIF:ar finns krypterade på dina enheter och synkas mellan dem, krypterat.",
    "Om servern har GIPHY-sökning påslagen hämtar din webbläsare sökresultat och GIF:ar direkt från GIPHY. GIPHY ser då din IP-adress och vad du söker, och den trafiken skyddas bara av HTTPS – inte av end-to-end-krypteringen. Inget hämtas från GIPHY förrän du själv söker.",
  ]],
  ["Notiser", [
    "Notiser är på från början om du tillåter dem när webbläsaren frågar. Du kan stänga av dem under Konto och inställningar, och valet gäller bara den enhet du gör det på.",
    "När Murmo är stängt skickar servern ett tomt meddelande via webbläsarens pushtjänst (Google, Mozilla eller Apple), som väcker webbläsaren. Pushtjänsten får veta att din webbläsare fick något från den här servern och när – inget om innehåll eller avsändare. Notisen säger bara ”Nytt meddelande”.",
    "Att väckas gör inte att du visas som ansluten: webbläsaren ansluter inte till servern förrän du öppnar Murmo.",
  ]],
  ["På din enhet", [
    "Historik, kontakter och nycklar sparas krypterat i webbläsaren och låses upp med ditt lösenord.",
    "Med ”Kom ihåg den här enheten” sparar webbläsaren en upplåsningsnyckel, så att Murmo öppnas utan lösenord. Den som kommer åt webbläsaren kan då läsa dina meddelanden. Använd det inte på delade datorer.",
    "Utan någon kvarvarande enhet är historiken borta, även med en pappersnyckel. Det finns ingen säkerhetskopia på servern; dina kontakter har kvar sina egna kopior av era konversationer.",
  ]],
  ["Begränsningar", [
    "Sidan hämtas från servern. Den som kontrollerar servern kan i princip leverera ändrad kod, och det gäller alla webbappar.",
    "Murmo och rootcard är tidiga versioner som inte har granskats av någon utomstående.",
    "Krypteringen skyddar inte mot en enhet som redan är infekterad, eller mot någon som tittar på din skärm.",
  ]],
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
    `Version ${info.version}`,
    commit ? " · commit " : null,
    commit && source ? h("a", { href: `${source}/commit/${commit}`, target: "_blank", rel: "noopener noreferrer", text: short }) : short,
  );
}

function showHelp() {
  const d = dialog(
    h("h2", { text: "Säkerhet och integritet" }),
    h(
      "div",
      { class: "help" },
      HELP.map(([title, items]) => h("section", {}, h("h3", { text: title }), h("ul", {}, items.map((t) => h("li", { text: t }))))),
    ),
    versionLine(),
    h("div", { class: "actions" }, h("button", { class: "btn", text: "Stäng", onclick: () => d.close() })),
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
  try {
    await rc.checkSupport(); // throws unsupported_browser
  } catch {
    root.replaceChildren(h("div", { class: "center" }, h("div", { class: "auth card", text: MESSAGES.unsupported_browser })));
    return;
  }
  info = await api.info();
  const origins = info.origins ?? (info.origin ? [info.origin] : []);
  if (origins.length && !origins.includes(location.origin)) {
    // The server signs and checks everything for its configured origin (MURMO_ORIGIN): proofs to it and the
    // WebSocket would fail here in confusing ways, so say what is wrong instead.
    root.replaceChildren(h("div", { class: "center" }, h("div", { class: "auth card" },
      h("p", { text: `Servern är inställd för ${info.origin}, men sidan öppnades på ${location.origin}. Inloggning och anslutning fungerar inte här.` }),
      h("p", { class: "hint", text: "Öppna Murmo på rätt adress, eller (för den som driver servern) sätt MURMO_ORIGIN till den här adressen och starta om servern." }),
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
    h("button", { class: tab === "login" ? "on" : "", text: "Logga in", onclick: () => showAuth("login") }),
    h("button", { class: tab === "register" ? "on" : "", text: "Skapa konto", onclick: () => showAuth("register") }),
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
        h("button", { class: "link", type: "button", text: "Säkerhet och integritet i detalj", onclick: showHelp }),
        themePicker(),
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
    h(
      "label",
      { class: "check" },
      remember,
      h(
        "span",
        {},
        "Kom ihåg den här enheten",
        h("span", { class: "hint", style: "display:block", text: "Sparar inte ditt lösenord. Webbläsaren behåller en låst nyckel så att Murmo öppnas direkt – den som kommer åt webbläsaren kan då läsa dina meddelanden. Lämna av på delade datorer." }),
      ),
    ),
    btn,
  );
  body.replaceChildren(form);
  // Not on touch (it would open the keyboard), and without scrolling the start page down to the form.
  if (matchMedia("(hover: hover)").matches) (prefill ? pw : handle).focus({ preventScroll: true });
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
  if (matchMedia("(hover: hover)").matches) user.focus({ preventScroll: true });
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
  inApp(true);
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
      text: "Jag har ingen annan enhet kvar",
      onclick: () => { help.hidden = !help.hidden; },
    });
    const card = h(
      "div",
      { class: "card" },
      h("p", { text: `${handle} används redan på en annan enhet. Öppna Murmo där och godkänn den här enheten. Kontrollera att koden är densamma på båda skärmarna.` }),
      h("div", { class: "code", text: setup.code }),
      h("p", { class: "hint" }, h("span", { class: "spinner" }), " Väntar på godkännande… (giltigt i 10 minuter)"),
      h("button", { class: "btn ghost", text: "Avbryt", onclick: () => done(false) }),
      toggle,
      help,
    );
    inApp(true);
    root.replaceChildren(h("div", { class: "center" }, h("div", { class: "auth" }, h("h1", { class: "brand", text: "Länka den här enheten" }), card)));
    setup.waitForApproval(ctl.signal).then(
      (ok) => {
        if (ctl.signal.aborted) return;
        if (ok) return resolve("linked");
        // Nobody approved in time: most likely no other device is left. Say what can be done instead.
        card.replaceChildren(
          h("p", { text: "Ingen enhet godkände den här i tid, och begäran har gått ut." }),
          h("p", { class: "hint", text: "Har du en annan enhet där du är inloggad? Öppna Murmo på den och logga in här igen, så får du en ny kod." }),
          h("div", { class: "recover" }, paperKeyForm(setup, done), ...recoveryHelp(home, handle)),
          h("button", { class: "btn primary", text: "Tillbaka till inloggningen", onclick: () => done(false) }),
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
  const go = h("button", { class: "btn primary", type: "submit", text: "Använd pappersnyckeln" });
  const form = h(
    "form",
    {
      class: "paper",
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        go.disabled = true;
        go.replaceChildren(h("span", { class: "spinner" }), "Kontrollerar…");
        try {
          await setup.approveWithPaperKey(input.value);
          input.value = "";
          done("paper");
        } catch (x) {
          err.textContent = say(x);
          go.disabled = false;
          go.replaceChildren("Använd pappersnyckeln");
        }
      },
    },
    h("p", {}, h("strong", { text: "Har du en pappersnyckel?" }), " Då kan den godkänna den här enheten i stället för en annan enhet. Kontot, dina kontakters förtroende och identifieraren är kvar som förut."),
    h("div", { class: "field" }, h("label", { text: "Pappersnyckel" }), input),
    go,
    err,
    h("p", { class: "hint", text: "Ingen pappersnyckel? Då återstår återställningskortet:" }),
  );
  return form;
}

/** After a paper key brought the account back: what is (and is not) on this device now. */
function showAfterPaperKey() {
  const d = dialog(
    h("h2", { text: "Välkommen tillbaka" }),
    h("p", { text: "Pappersnyckeln har lagt till den här enheten. Kontot och identifieraren är desamma, och dina kontakter ser bara att du har fått en ny enhet." }),
    h("p", { class: "hint", text: "Kontakter och meddelanden fanns bara på den enhet du förlorade och finns inte här. Skriv till dina kontakter igen med deras identifierare: de som redan har godkänt dig kopplas direkt, och deras egna kopior av era konversationer finns kvar hos dem." }),
    h("p", { class: "hint", text: "Ta bort den förlorade enheten under Enheter, så att ingen kan använda den. Pappersnyckeln gäller fortfarande; skapa gärna en ny där om den gamla har legat framme." }),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", text: "Stäng", onclick: () => d.close() }),
      h("button", { class: "btn primary", text: "Öppna Enheter", onclick: () => { d.close(); showDevices(); } }),
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
  const intro = [
    h("p", { text: "Utan en annan enhet kan ingen godkänna den här – ett lösenord räcker inte, det är det som skyddar kontot. Vägen tillbaka är ditt återställningskort." }),
    h("p", { class: "hint", text: "När du återställer identiteten med kortet börjar kontot om, och nästa enhet du loggar in på blir den första. Identifieraren är densamma, men meddelandehistoriken går inte att få tillbaka (den fanns bara på dina enheter), och dina kontakter ser att dina nycklar har ändrats." }),
  ];
  if (!homeIsHere(home)) {
    return [
      ...intro,
      h("p", { text: `Din identitet finns hos ${host}. Gå dit och återställ den med ditt återställningskort (glömt lösenord). Logga sedan in här igen.` }),
    ];
  }
  return [
    ...intro,
    h(
      "ol",
      {},
      h("li", {}, "Ladda ner rootcards nyckelverktyg – en fristående sida – och öppna filen i webbläsaren på din dator. ", h("a", { href: "vendor/rootcard/keytool.html", download: "rootcard-keytool.html", text: "Ladda ner nyckelverktyget" })),
      h("li", { text: `Öppna identiteten med ditt återställningskort – kortfilen, eller användarnamnet ${handle.split("#")[0]} och återställningsnyckeln – och ange ${host} som värdadress.` }),
      h("li", { text: `Välj "Reset forgotten password" och ett nytt lösenord.` }),
      h("li", { text: "Logga sedan in här igen med det nya lösenordet." }),
    ),
  ];
}

// ── the main view ───────────────────────────────────────────────────────────────────────────────────────────────

async function enter({ store, account, handle, home }) {
  messenger = new Messenger({ api, store, account, handle, home, realms: info.realms, fileQueue: () => settings().fileQueue });
  messenger.addEventListener("contacts", () => { renderSidebar(); refreshConversation(); });
  messenger.addEventListener("messages", (e) => { if (e.detail.conv === current) renderThread(); renderSidebar(); });
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
    toast("Den här enheten har tagits bort från kontot.");
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
  const who = messenger.contacts.get(conv)?.handle ?? "någon";
  const text = kind === "request" ? `Ny förfrågan från ${who}` : kind === "file" ? `Ny fil från ${who}` : `Nytt meddelande från ${who}`;
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
    async () => {
      if (!due()) return;
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
    h("span", { text: "En ny version av Murmo finns." }),
    h("button", { class: "btn small primary", text: "Ladda om", onclick: () => location.reload() }),
    h("button", { class: "btn small ghost", text: "Senare", onclick: () => bar.remove() }),
  );
  document.body.append(bar);
}
setInterval(checkVersion, 15 * 60_000);

/** Turn notifications on (from a click) or off. Returns a text for the user. */
async function setNotifications(on) {
  if (!on) {
    setSetting("notify", false);
    await notify.unsubscribe().catch(() => {});
    await messenger.setPushEndpoint(null).catch(() => {});
    return "Notiser är av.";
  }
  const s = notify.support();
  if (s === "ios-install") return "På iPhone och iPad fungerar notiser när Murmo ligger på hemskärmen: välj Dela → Lägg till på hemskärmen och slå på notiser där.";
  if (s !== "ok") return "Den här webbläsaren stöder inte notiser.";
  const r = await notify.request();
  if (r !== "granted") return r === "denied" ? "Notiser är blockerade för den här sidan. Tillåt dem i webbläsarens inställningar för sidan och försök igen." : "Notiser slogs inte på.";
  setSetting("notify", true);
  setSetting("notifyPrompted", true);
  try {
    const endpoint = await notify.pushEndpoint(info.push_key);
    if (!endpoint) return "Notiser är på medan Murmo är öppet i bakgrunden. Den här webbläsaren eller servern stöder inte push, så en stängd app väcks inte.";
    await messenger.setPushEndpoint(endpoint);
    return "Notiser är på, även när Murmo är stängt.";
  } catch (x) {
    console.warn("push", x?.message ?? x);
    return "Notiser är på medan Murmo är öppet i bakgrunden. Push gick inte att slå på just nu, så en stängd app väcks inte.";
  }
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
      h(
        "div",
        { class: "side-top" },
        h("div", { class: "logo" }, h("img", { src: "icon.svg", alt: "" }), "Murmo"),
        h("button", { class: "icon-btn", "aria-label": "Ny konversation", title: "Ny konversation", onclick: () => openConversation(null, true) }, icon("plus")),
      ),
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

function renderSidebar() {
  if (!ui.sideList || !messenger) return;
  const all = messenger.contactList().sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  const incoming = all.filter((c) => c.state === "incoming");
  const convs = all.filter((c) => c.state === "accepted" || c.state === "outgoing");
  const blocked = all.filter((c) => c.state === "blocked");
  const item = (c) => {
    const [name, tag] = splitHandle(c.handle);
    return h(
      "button",
      { class: `conv${c.account === current ? " on" : ""}`, onclick: () => openConversation(c.account) },
      h("span", { class: "avatar small", text: name.slice(0, 1).toUpperCase() }),
      h("span", { class: "name" }, name, h("span", { class: "tag", text: tag })),
      c.state === "incoming" ? h("span", { class: "badge", text: "ny" }) : null,
      c.state === "outgoing" ? h("span", { class: "badge muted", text: "väntar" }) : null,
      c.state === "accepted" && unread.has(c.account) ? h("span", { class: "unread", "aria-label": "Oläst" }) : null,
      c.fork ? h("span", { class: "badge", text: "!" }) : null,
    );
  };
  put(ui.sideList,
    incoming.length ? h("div", { class: "side-head", text: "Förfrågningar" }) : null,
    ...incoming.map(item),
    h("div", { class: "side-head", text: "Konversationer" }),
    ...(convs.length
      ? convs.map(item)
      : [h("div", { class: "empty" }, h("p", { class: "hint", text: "Inga konversationer ännu." }), h("button", { class: "btn primary", text: "Ny konversation", onclick: () => openConversation(null, true) }), about())]),
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
    h("button", { class: "icon-btn", "aria-label": "Konto och inställningar", title: "Konto och inställningar", onclick: showAccountMenu }, icon("more")),
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
    h("button", { class: "icon-btn back-btn", "aria-label": "Tillbaka till konversationerna", onclick: closeConversation }, icon("back")),
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
    h("div", { class: "title" }, name, h("span", { class: "tag", text: tag }), homeLabel(c.home) ? h("span", { class: "home", text: ` · ${homeLabel(c.home)}` }) : null, c.retention ? h("span", { class: "home", title: "Meddelanden raderas från dina enheter efter den här tiden", text: ` · raderas efter ${retentionLabel(c.retention)}` }) : null),
    c.state === "accepted" ? h("button", { class: "btn ghost small", onclick: () => showSafety(c) }, icon("shield"), h("span", { class: "wide", text: "Säkerhetskod" })) : null,
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
  renderSeq = 0;
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

/** The start of the main pane: add a conversation by exact identifier. */
function renderWelcome() {
  ui.thread = null;
  const input = h("input", { class: "input", id: "new-handle", placeholder: "Namn#TAGG", spellcheck: "false", autocomplete: "off", autocapitalize: "off", enterkeyhint: "next" });
  const note = h("input", { class: "input", id: "new-note", placeholder: "Hej, det är jag!", maxlength: 500, enterkeyhint: "send" });
  const err = h("div", { class: "error" });
  const send = h("button", { class: "btn primary", type: "submit", text: "Skicka förfrågan" });
  const copy = () => navigator.clipboard?.writeText(messenger.handle).then(() => toast("Identifieraren kopierad."));
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
    h("h1", { text: "Ny konversation" }),
    h("p", { class: "hint", text: "Skriv personens identifierare exakt. Det går inte att söka, och mottagaren måste acceptera innan ni kan skriva till varandra." }),
    h("div", { class: "field" }, h("label", { for: "new-handle", text: "Identifierare" }), input),
    h("div", { class: "field" }, h("label", { for: "new-note", text: "Hälsning (valfri, skickas med förfrågan)" }), note),
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
        h("div", {}, h("strong", { text: "Notiser" }), h("div", { class: "hint", text: "Få veta när någon skriver, även när Murmo är stängt." })),
        h("button", { class: "btn small", text: "Inte nu", onclick: () => { setSetting("notify", false); offer.remove(); } }),
        h("button", { class: "btn small primary", text: "Slå på", onclick: async () => { offer.remove(); toast(await setNotifications(true)); } }),
      );
  put(ui.main,
    topbar(h("div", { class: "title", text: "Ny konversation" })),
    h(
      "div",
      { class: "welcome" },
      h(
        "div",
        { class: "welcome-inner" },
        form,
        h("div", { class: "card mine" }, h("div", {}, h("div", { class: "hint", text: "Din identifierare – dela den med dem du vill höra av" }), h("strong", { text: messenger.handle })), h("button", { class: "btn small", text: "Kopiera", onclick: copy })),
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
            h("strong", { text: "Du har bara den här enheten" }),
            h("div", { class: "hint", text: "Om webbläsarens data rensas kan ingen enhet godkänna en ny. Då behövs återställningskortet, och kontot börjar om. Länka en enhet till, eller skapa en pappersnyckel som kan godkänna en ny enhet." }),
          ),
          h(
            "div",
            { class: "btns" },
            h("button", { class: "btn small primary", text: "Skapa pappersnyckel", onclick: () => showPaperKey(() => slot.remove()) }),
            h("button", { class: "btn small", text: "Inte nu", onclick: () => { setSetting("singleDeviceSeen", true); slot.remove(); } }),
          ),
        ),
      );
    },
    () => {},
  );
  return slot;
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
  const sent = (name, r) => {
    if (r.live) toast(`${name} skickad.`);
    else if (r.queued) toast(`${name} väntar krypterad på servern tills mottagaren ansluter.`);
    else toast(`${name} är inte skickad än: mottagaren är inte ansluten. Den skickas när ni båda är anslutna.`);
  };
  const sendFiles = async (files) => {
    for (const f of files) {
      try {
        sent(f.name, await messenger.sendFile(c.account, f));
      } catch (x) {
        toast(say(x));
      }
    }
  };
  /** Put text where the cursor is (or over the selection), and keep the cursor after it. */
  const insert = (text) => {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    ta.setRangeText(text, start, end, "end");
    grow();
    if (matchMedia("(hover: hover)").matches) ta.focus();
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
  const panel = h("div", { class: "picker hidden", role: "region", "aria-label": "Emoji och GIF" });
  let open = null;
  let seq = 0;
  let urls = []; // object URLs of the GIFs shown, revoked when the panel closes
  const emojiBtn = h("button", { class: "icon-btn", type: "button", "aria-label": "Emoji", title: "Emoji", "aria-expanded": "false" }, icon("smile"));
  const gifBtn = h("button", { class: "icon-btn gif-btn", type: "button", "aria-label": "GIF", title: "Dina GIF:ar", "aria-expanded": "false", text: "GIF" });
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
    else gifPanel(panel, c, { sent, close: closePanel, alive, track: (u) => urls.push(u) }).catch(fail);
  };
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
      h("button", { class: "icon-btn", "aria-label": "Bifoga fil", title: "Skicka fil", onclick: () => file.click() }, icon("clip")),
      emojiBtn,
      gifBtn,
      h("span", { class: "grow" }),
      send,
    ),
    file,
  );
  const wrap = h("div", { class: "composer-wrap" }, panel, box, h("div", { class: "foot-note", text: "Krypterat från enhet till enhet. Servern sparar inget efter leverans." }));
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
  if (matchMedia("(hover: hover)").matches) setTimeout(() => ta.focus()); // not on touch: it would open the keyboard
  return wrap;
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
  const cats = [...(recent.length ? [{ label: "Senast använda", icon: null, emoji: recent }] : []), ...emoji.CATEGORIES];
  const grid = h("div", { class: "emoji-grid", role: "listbox", "aria-label": "Emoji" });
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
  put(panel, tabs, h("div", { class: "picker-title", text: "Emoji" }), grid);
  show(0);
}

/**
 * The GIF panel: "Mina" (the user's collection, one tap sends one) and, when the server has a GIPHY key, "Sök" (one
 * tap saves a result in the collection). The collection is encrypted on the device and shared with the account's
 * other devices (docs/DESIGN.md §9.2–9.3).
 */
async function gifPanel(panel, c, { sent, close, alive, track }) {
  const body = h("div", { class: "gif-body" });
  const search = info?.giphy?.key ? info.giphy : null;
  const tabs = h("div", { class: "seg gif-tabs", role: "tablist" });
  const show = (which) => {
    put(tabs,
      h("button", { type: "button", role: "tab", class: which === "mine" ? "on" : "", "aria-selected": String(which === "mine"), text: "Mina GIF:ar", onclick: () => show("mine") }),
      search ? h("button", { type: "button", role: "tab", class: which === "search" ? "on" : "", "aria-selected": String(which === "search"), text: "Sök på GIPHY", onclick: () => show("search") }) : null,
    );
    const still = () => alive() && tabs.dataset.on === which;
    tabs.dataset.on = which;
    (which === "mine" ? gifMine(body, c, { sent, close, alive: still, track }) : gifSearch(body, search, { alive: still, track }))
      .catch((x) => { if (still()) put(body, h("p", { class: "hint", text: say(x) })); });
  };
  put(panel, tabs, body);
  show("mine");
}

/** The user's collection: one tap sends a GIF, the cross removes it (on all own devices). */
async function gifMine(box, c, { sent, close, alive, track }) {
  const pickFile = h("input", { type: "file", class: "hidden", accept: "image/gif" });
  const grid = h("div", { class: "gif-grid" });
  let shown = []; // object URLs of this view, replaced on each render
  const render = async () => {
    const list = await messenger.gifs();
    if (!alive()) return;
    if (!list.length) {
      put(grid, h("p", { class: "hint", text: info?.giphy?.key
        ? "Inga sparade GIF:ar än. Sök på GIPHY, välj en fil, eller tryck ”Spara GIF” under en GIF i en konversation."
        : "Inga sparade GIF:ar än. Välj en fil, eller tryck ”Spara GIF” under en GIF i en konversation." }));
      return;
    }
    const items = [];
    const made = [];
    for (const g of list) {
      const blob = await messenger.gifBlob(g.id);
      const remove = h("button", {
        type: "button",
        class: "gif-remove",
        "aria-label": "Ta bort från mina GIF:ar",
        title: "Ta bort från mina GIF:ar",
        onclick: () => messenger.removeGif(g.id).catch((x) => toast(say(x))),
      }, icon("close"));
      if (!blob) {
        // Saved on another device; the bytes are on their way (or come when that device is connected).
        items.push(h("div", { class: "gif" }, h("div", { class: "gif-send wait", text: "Hämtas…", title: "Sparad på en annan enhet, hämtas därifrån" }), remove));
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
          title: "Skicka",
          onclick: async () => {
            close();
            try {
              sent("GIF:en", await messenger.sendGif(c.account, g.id));
            } catch (x) {
              toast(say(x));
            }
          },
        }, h("img", { src: url, alt: "Sparad GIF", width: String(g.width), height: String(g.height) })),
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
      try {
        sent(f.name, await messenger.sendFile(c.account, f));
      } catch (x) {
        toast(say(x));
      }
    }
  });
  put(
    box,
    h(
      "div",
      { class: "picker-head" },
      h("span", { class: "hint", text: "Tryck för att skicka. Krypterad, på alla dina enheter." }),
      h("button", { type: "button", class: "btn small", text: "Från fil…", title: "Välj GIF-fil", onclick: () => pickFile.click() }),
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
  const input = h("input", { class: "input", type: "search", placeholder: "Sök GIF:ar, tryck för att spara", enterkeyhint: "search", spellcheck: "false", autocomplete: "off", "aria-label": "Sök GIF:ar på GIPHY" });
  const grid = h("div", { class: "gif-grid" });
  const status = h("span", { class: "hint", text: "Skriv minst två tecken." });
  let ctl = null;
  let timer = 0;
  let shown = [];
  const run = async (q) => {
    ctl?.abort();
    ctl = new AbortController();
    const signal = ctl.signal;
    status.textContent = "Söker…";
    let results;
    try {
      results = await giphy.search(config, q, { maxBytes: GIF_MAX_BYTES, signal });
    } catch (x) {
      if (x?.name === "AbortError" || !alive()) return;
      status.textContent = say(x);
      return;
    }
    if (!alive() || signal.aborted) return;
    status.textContent = results.length ? "Tryck för att spara i Mina GIF:ar." : "Inga träffar.";
    for (const u of shown) URL.revokeObjectURL(u);
    shown = [];
    put(grid, results.map((r) => {
      const img = h("img", { alt: r.title || "GIF från GIPHY" });
      const tile = h("button", {
        type: "button",
        class: "gif-send",
        title: r.title ? `Spara: ${r.title}` : "Spara bland mina GIF:ar",
        onclick: async () => {
          if (tile.classList.contains("busy") || tile.classList.contains("saved")) return;
          tile.classList.add("busy");
          try {
            const res = await messenger.saveGif(await giphy.fetchGif(r.full, GIF_MAX_BYTES));
            tile.classList.add("saved");
            toast(res === "exists" ? "Den finns redan bland dina GIF:ar." : "Sparad bland dina GIF:ar.");
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
      status.textContent = "Skriv minst två tecken.";
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
    if (!matchMedia("(hover: hover)").matches) input.blur(); // on a phone: the keyboard goes, the results get the room
  });
  put(
    box,
    // Always there, but one short line: the details open on a tap (a phone has little room with the keyboard up).
    h(
      "details",
      { class: "warn-note", role: "note" },
      h("summary", {}, h("strong", { text: "Direkt från GIPHY: " }), "de ser din IP-adress och sökning. Bara HTTPS, inte E2E."),
      h("p", { text: "Sökningen och GIF:arna hämtas av din webbläsare direkt från GIPHY, som ser din IP-adress och vad du söker. Den trafiken skyddas bara av HTTPS, inte av Murmos end-to-end-kryptering. Inget hämtas innan du skriver, och det du sedan skickar är krypterat som vanligt." }),
    ),
    input,
    h("div", { class: "gif-status" }, status, h("span", { class: "giphy-mark", text: "Powered by GIPHY" })),
    grid,
  );
  if (matchMedia("(hover: hover)").matches) input.focus();
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
  const body = m.kind === "file" ? fileView(m) : h("div", { class: emoji.emojiOnly(m.text) ? "body jumbo" : "body", dir: "auto", text: m.text ?? "" });
  const media = m.kind === "file" ? " media" : "";
  const meta = h("div", { class: "meta", text: clock(m.time) });
  if (Messenger.undelivered(m)) {
    meta.append(
      h("span", { class: "pending", text: " · Inte skickad än – skickas när mottagaren är ansluten " }),
      h("button", {
        class: "link",
        text: "Försök nu",
        onclick: async () => {
          try {
            toast((await messenger.flushFiles()) ? "Skickad." : "Mottagaren är inte ansluten just nu.");
          } catch (x) {
            toast(say(x));
          }
        },
      }),
    );
  }
  else if (m.dir === "out" && m.delivered !== undefined) meta.append(deliveryMark(m));
  if (m.kind === "file" && m.file?.have && m.file.mime === "image/gif") meta.append(saveGifButton(m));
  const canReact = ["text", "file"].includes(m.kind) && messenger.contacts.get(m.conv)?.state === "accepted";
  if (canReact) meta.append(reactButton(m));
  return h("div", { class: `msg ${m.dir}${media}` }, body, reactionsView(m, canReact), meta);
}

// ── saving GIFs from a conversation ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 of the GIFs in the collection, to show which GIFs of a conversation are already saved. */
let gifHashes = new Set();
async function refreshGifHashes() {
  gifHashes = new Set((await messenger.gifs()).map((g) => g.sha256));
}

/** "Spara GIF" under a GIF in the thread (also in the viewer): into the collection, on all own devices. */
function saveGifButton(m) {
  const saved = gifHashes.has(m.file.sha256);
  return h("button", {
    type: "button",
    class: saved ? "save-gif-inline saved" : "save-gif-inline",
    text: saved ? "✓ Sparad" : "Spara GIF",
    title: saved ? "Finns bland dina GIF:ar" : "Spara bland dina GIF:ar",
    disabled: saved,
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await messenger.saveGif(await messenger.fileBlob(m.file.f, "image/gif"));
        toast(r === "exists" ? "Den finns redan bland dina GIF:ar." : "Sparad bland dina GIF:ar.");
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
  if (account === messenger.me.account) return "Du";
  return splitHandle(messenger.contacts.get(account)?.handle ?? "")[0] || "Någon";
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
      title: mine ? `${names} · tryck för att ta bort din` : names,
      "aria-label": `${e} från ${names}`,
      disabled: !canReact,
      onclick: () => react(m, mine ? "" : e),
    }, h("span", { text: e }), who.length > 1 ? h("span", { class: "n", text: String(who.length) }) : null);
  }));
}

function reactButton(m) {
  const btn = h("button", { type: "button", class: "react-btn", "aria-label": "Reagera", title: "Reagera", "aria-haspopup": "menu" }, icon("smile"));
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
    { class: "react-menu", role: "menu", "aria-label": "Reagera" },
    QUICK_REACTIONS.map((e) => h("button", {
      type: "button",
      role: "menuitem",
      class: e === mine ? "on" : "",
      text: e,
      title: e === mine ? "Ta bort din reaktion" : `Reagera med ${e}`,
      onclick: () => { close(); react(m, e === mine ? "" : e); },
    })),
    h("button", { type: "button", role: "menuitem", class: "more", "aria-label": "Fler emoji", title: "Fler emoji", onclick: () => { close(); reactDialog(m); } }, icon("plus")),
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
    h("h2", { text: "Reagera" }),
    panel,
    h("div", { class: "actions" }, h("button", { class: "btn", text: "Avbryt", onclick: () => d.close() })),
  );
  emojiPanel(panel, (e) => { d.close(); react(m, e); }, () => d.open).catch(() => {});
}

/** A ring while the server holds the message for the recipient, a ring with a check once a device of theirs has it. */
function deliveryMark(m) {
  const done = !!m.delivered;
  const label = done ? "Levererat till mottagaren" : "Köat på servern – inte levererat än";
  const s = icon(done ? "ringCheck" : "ring");
  s.setAttribute("width", "14");
  s.setAttribute("height", "14");
  s.setAttribute("aria-hidden", "true");
  return h("span", { class: `delivery${done ? " ok" : ""}`, role: "img", "aria-label": label, title: label }, s);
}

/** A picture full size: closed by the cross, a tap anywhere, Escape or the back button. */
function showImage(url, name, gif = null) {
  const save = gif
    ? h("button", {
        class: "btn small save-gif",
        text: "Spara i mina GIF:ar",
        onclick: async (e) => {
          e.stopPropagation(); // a click anywhere else closes the viewer
          try {
            const r = await messenger.saveGif(await gif());
            toast(r === "exists" ? "Den finns redan bland dina GIF:ar." : "Sparad bland dina GIF:ar.");
            d.close();
          } catch (x) {
            toast(say(x));
          }
        },
      })
    : null;
  const d = dialog(
    h("button", { class: "close", "aria-label": "Stäng", title: "Stäng", onclick: () => d.close() }, icon("close")),
    h("img", { src: url, alt: name }),
    save,
  );
  d.classList.add("viewer");
  d.addEventListener("click", () => d.close());
}

function fileView(m) {
  const f = m.file;
  if (f.have && p.inlineImage(f.mime, f.size)) {
    // The dimensions are read from the header first: a small file can decode to gigabytes and freeze the tab.
    const img = h("img", { class: "inline", alt: f.name });
    messenger.imageSize(f.f).then(async (size) => {
      if (!p.imageFits(size)) {
        const why = size ? `${size.width} × ${size.height} bildpunkter, för stor för att visas` : "kan inte visas här";
        img.replaceWith(fileCard(m, why));
        return;
      }
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
    }).catch(() => img.replaceWith(fileCard(m)));
    return img;
  }
  return fileCard(m);
}

/** A file as a card with its name, size and "Spara" (or a way to fetch it); `note` is said after the size. */
function fileCard(m, note) {
  const f = m.file;
  const action = f.have
    ? h("button", { class: "btn small", text: "Spara", onclick: async () => download(f.name, await messenger.fileBlob(f.f, "application/octet-stream")) })
    : h("button", {
        class: "btn small",
        text: "Hämta från mina enheter",
        title: "Filen har inte kommit till den här enheten. Den här frågar dina andra anslutna enheter.",
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
    h("div", { class: "fi" }, h("div", { class: "fn", dir: "auto", text: f.name }), h("div", { class: "fs", text: f.have ? (note ? `${bytes(f.size)} · ${note}` : bytes(f.size)) : `${bytes(f.size)} · ${m.dir === "in" ? "inte mottagen än" : "inte mottagen på den här enheten"}` })),
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
      retentionPicker(c),
      c.state !== "blocked" ? h("button", { class: "btn danger", text: "Blockera", onclick: () => messenger.setState(c.account, "blocked").then(() => { d.close(); openConversation(null); }) }) : null,
      h("button", { class: "btn danger", text: "Ta bort konversationen", onclick: () => messenger.setState(c.account, "declined").then(() => { d.close(); openConversation(null); }) }),
    ),
    h("div", { class: "actions" }, h("button", { class: "btn", text: "Stäng", onclick: () => d.close() })),
  );
}

/** How long the messages of a conversation are kept on this account's devices. */
function retentionPicker(c) {
  const current = validRetention(c.retention) ? c.retention : 0;
  const choices = RETENTIONS.some(([s]) => s === current) ? RETENTIONS : [...RETENTIONS, [current, retentionLabel(current)]];
  const select = h(
    "select",
    {
      class: "input",
      id: "retention",
      onchange: () => {
        const r = Number(select.value);
        messenger.setRetention(c.account, r).then(
          () => toast(r ? `Meddelanden äldre än ${retentionLabel(r)} raderas nu från dina enheter.` : "Meddelandena sparas tills vidare."),
          (x) => toast(say(x)),
        );
      },
    },
    ...choices.map(([s, label]) => h("option", { value: String(s), text: label, selected: s === current })),
  );
  return h(
    "label",
    { class: "field" },
    h("span", { text: "Spara meddelanden" }),
    select,
    h("span", { class: "hint", text: "Gäller dina egna enheter, också texter och filer du redan har. Motparten bestämmer själv över sina kopior." }),
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
  const s = settings();
  const notice = h("input", { type: "checkbox", checked: s.notify && notify.permission() === "granted" });
  const noticeHint = h("span", { class: "hint", style: "display:block", text: "Visar bara att något har kommit och från vem – aldrig innehållet. När Murmo är stängt väcker servern webbläsaren via dess pushtjänst (Google, Mozilla eller Apple) med ett tomt meddelande: tjänsten får veta att den här webbläsaren fick något från den här servern och när, inget mer." });
  notice.addEventListener("change", async () => {
    notice.disabled = true;
    const text = await setNotifications(notice.checked).catch((x) => say(x));
    notice.checked = settings().notify;
    notice.disabled = false;
    toast(text);
  });
  const queue = h("input", { type: "checkbox", checked: s.fileQueue, disabled: !info.file_queue });
  queue.addEventListener("change", () => setSetting("fileQueue", queue.checked));
  const d = dialog(
    h("h2", { text: messenger.handle }),
    h("p", { class: "hint", text: `Din identifierare${homeLabel(messenger.home) ? ` (från ${homeLabel(messenger.home)})` : ""}. Den som vill nå dig behöver den exakt – det går inte att söka efter användare.` }),
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:8px" },
      h("button", { class: "btn", text: "Kopiera identifierare", onclick: () => navigator.clipboard?.writeText(messenger.handle).then(() => { toast("Identifieraren kopierad."); d.close(); }) }),
      h("button", { class: "btn", text: "Enheter", onclick: () => { d.close(); showDevices(); } }),
      h("button", { class: "btn", text: "Säkerhet och integritet", onclick: () => { d.close(); showHelp(); } }),
      h("label", { class: "check" }, notice, h("span", {}, "Notiser på den här enheten", noticeHint)),
      h(
        "label",
        { class: "check" },
        queue,
        h(
          "span",
          {},
          "Låt servern hålla filer åt mottagare som inte är anslutna",
          h("span", { class: "hint", style: "display:block", text: info.file_queue ? "Filen ligger krypterad på servern tills mottagarens enhet hämtat den, högst 14 dagar. Servern ser storlek och tidpunkt men inte innehåll eller namn. Av: filer går bara direkt mellan anslutna enheter och skickas annars när ni båda är anslutna." : "Avstängt på den här servern: filer går bara direkt mellan anslutna enheter." }),
        ),
      ),
      h("div", { class: "field", style: "margin:6px 0 0" }, h("label", { text: "Tema" }), themePicker()),
      h("button", { class: "btn danger", text: "Logga ut", onclick: () => { d.close(); logout(false); } }),
    ),
    h("div", { class: "actions" }, h("button", { class: "btn", text: "Stäng", onclick: () => d.close() })),
  );
}

async function showDevices() {
  const list = h("div", {}, h("span", { class: "spinner" }));
  const paper = h("div", { class: "paperbox" });
  const d = dialog(
    h("h2", { text: "Dina enheter" }),
    h("p", { class: "hint", text: "Nya enheter läggs till genom att logga in på dem och godkänna här. Ett lösenord räcker inte för att lägga till en enhet." }),
    list,
    paper,
    h("div", { class: "actions" }, h("button", { class: "btn", text: "Stäng", onclick: () => d.close() })),
  );
  const render = async () => {
    const own = await messenger.ownList(true);
    const keys = own.present.filter(p.isPaper);
    const browsers = own.present.filter((x) => !p.isPaper(x));
    put(
      list,
      browsers.length === 1 && !keys.length
        ? h("p", { class: "lone", text: "Det här är din enda enhet. Om webbläsarens data rensas kan ingen godkänna en ny enhet: då behövs återställningskortet, kontot börjar om och historiken går förlorad. Länka en enhet till, eller skapa en pappersnyckel." })
        : null,
      ...own.present.map((dev) =>
        h(
          "div",
          { class: "dev" },
          h(
            "div",
            { class: "l" },
            h("div", { text: p.isPaper(dev) ? "Pappersnyckel" : dev.label + (dev.id === messenger.me.device ? " (den här)" : "") }),
            p.isPaper(dev)
              ? h("div", { class: "hint", text: "Kan godkänna en ny enhet tillsammans med ditt lösenord. Tar du bort den slutar den gamla nyckeln att fungera." })
              : h("div", { class: "id", text: dev.id }),
          ),
          dev.id === messenger.me.device
            ? null
            : h("button", {
                class: "btn small danger",
                text: "Ta bort",
                onclick: async () => {
                  try {
                    if (p.isPaper(dev) && !confirm("Ta bort pappersnyckeln? Den kan då inte längre godkänna en ny enhet.")) return;
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
      h("h3", { text: "Pappersnyckel" }),
      h("p", { class: "hint", text: keys.length
        ? "Du har en pappersnyckel. En ny ersätter den gamla, som då slutar fungera."
        : "En pappersnyckel kan godkänna en ny enhet om du inte har någon enhet kvar. Den fungerar bara tillsammans med ditt lösenord, så papperet ensamt ger ingen åtkomst. Historiken följer inte med: den finns bara på dina enheter." }),
      h("button", { class: "btn", text: keys.length ? "Skapa ny pappersnyckel" : "Skapa pappersnyckel", onclick: () => { d.close(); showPaperKey(); } }),
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
  const go = h("button", { class: "btn primary", type: "submit", text: "Fortsätt" });
  const body = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        go.disabled = true;
        go.replaceChildren(h("span", { class: "spinner" }), "Låser upp…");
        let secret;
        try {
          secret = await id.unlockLocalSecret(api, messenger.home, messenger.me.account, pw.value);
          pw.value = "";
          showPaperKeyText(d, await messenger.preparePaperKey(secret), onDone);
        } catch (x) {
          err.textContent = say(x);
          go.disabled = false;
          go.replaceChildren("Fortsätt");
        } finally {
          secret?.fill(0);
        }
      },
    },
    h("p", { text: "En pappersnyckel kan godkänna en ny enhet när du inte har någon annan enhet kvar – tillsammans med ditt lösenord. Kontot och dina kontakters förtroende är då kvar; bara historiken på den förlorade enheten går inte att få tillbaka." }),
    h("div", { class: "field" }, h("label", { text: "Ditt lösenord" }), pw),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", text: "Avbryt", onclick: () => d.close() }), go),
    err,
  );
  const d = dialog(h("h2", { text: "Skapa pappersnyckel" }), body);
  pw.focus();
}

function showPaperKeyText(d, prepared, onDone) {
  const err = h("div", { class: "error" });
  const saved = h("input", { type: "checkbox" });
  const go = h("button", { class: "btn primary", text: "Aktivera pappersnyckeln", disabled: true });
  saved.addEventListener("change", () => (go.disabled = !saved.checked));
  const name = `murmo-pappersnyckel-${splitHandle(messenger.handle)[0]}.txt`;
  const text = `Murmo – pappersnyckel för ${messenger.handle}\n\n${prepared.text}\n\nGodkänner en ny enhet tillsammans med lösenordet när ingen annan enhet finns kvar.\nLogga in, välj "Jag har ingen annan enhet kvar" och ange nyckeln.\n`;
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.replaceChildren(h("span", { class: "spinner" }), "Aktiverar…");
    try {
      await prepared.commit();
      toast("Pappersnyckeln är aktiverad.");
      setSetting("singleDeviceSeen", true);
      d.close();
      onDone();
    } catch (x) {
      err.textContent = say(x);
      go.disabled = false;
      go.replaceChildren("Aktivera pappersnyckeln");
    }
  });
  d.classList.add("printable");
  d.replaceChildren(
    h("h2", { text: "Din pappersnyckel" }),
    h("p", { text: "Skriv ner nyckeln eller skriv ut den, och förvara den på ett annat ställe än dina enheter. Den visas bara nu." }),
    h("pre", { class: "cardtext paperkey", text: prepared.text }),
    h(
      "div",
      { style: "display:flex;gap:8px;flex-wrap:wrap" },
      h("button", { class: "btn", text: "Ladda ner som text", onclick: () => download(name, new Blob([text], { type: "text/plain" })) }),
      h("button", { class: "btn ghost", text: "Skriv ut", onclick: () => print() }),
    ),
    h("label", { class: "check" }, saved, h("span", { text: "Jag har sparat pappersnyckeln på ett säkert ställe." })),
    h("div", { class: "actions" }, h("button", { class: "btn", text: "Avbryt", onclick: () => d.close() }), go),
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
    const rec = (await accounts.all()).find((a) => a.account === account);
    if (rec) await accounts.put({ ...rec, remembered: false });
    if (forget) await Store.destroy(account);
  }
  showAuth("login");
}

boot().catch((x) => {
  root.replaceChildren(h("div", { class: "center" }, h("div", { class: "auth card", text: say(x) })));
});
