// Murmo Bridge: the owner's pages (DESIGN.md §16). Log in with a rootcard identity (the messenger's own login, in this
// browser), prove it to the bridge, then make and manage bots. Nothing is stored in the browser: a reload logs out.

import * as rc from "../vendor/rootcard/src/index.js";
import { Api } from "../js/api.js";
import * as id from "../js/identity.js";
import * as LANGS from "./lang.js";

const api = new Api(location.origin);
const BRIDGE = `${location.origin}/bridge/api/v1`;
const RETENTION = [0, 1, 7, 14, 30];

const lang = (navigator.languages ?? [navigator.language]).map((l) => String(l).toLowerCase().split("-")[0]).find((l) => l in LANGS) ?? "en";
document.documentElement.lang = lang;
const t = (key, vars = {}) => String(LANGS[lang][key] ?? LANGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
const errText = (e) => (LANGS[lang][`error.${e?.code}`] ? t(`error.${e.code}`) : t("error", { code: e?.code ?? e?.message ?? "?" }));
const date = (s) => new Date(s * 1000).toLocaleString(lang);

let session = null; // { token, account, handle, max }

/** An element; text only ever goes into text nodes. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

const main = document.getElementById("main");
const show = (...nodes) => main.replaceChildren(...nodes);

async function call(method, path, body, token = session?.token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BRIDGE}${path}`, { method, headers, body: body === undefined ? undefined : rc.canonicalString(body), credentials: "omit", cache: "no-store" });
  const text = await res.text();
  const value = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(value?.error ?? `http_${res.status}`), { code: value?.error ?? `http_${res.status}` });
  return value;
}

function copyButton(text) {
  const b = h("button", { type: "button", class: "ghost", text: t("copy") });
  b.addEventListener("click", async () => {
    await navigator.clipboard?.writeText(text);
    b.textContent = t("copied");
  });
  return b;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A form whose submit runs `f` with the button disabled and shows its error. */
function form(fields, submit, busy, f) {
  const error = h("p", { class: "error", role: "alert" });
  const button = h("button", { type: "submit", text: submit });
  const el = h("form", {}, fields, error, h("div", { class: "row" }, button));
  el.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    button.disabled = true;
    button.textContent = busy;
    try {
      await f(new FormData(el));
    } catch (err) {
      error.textContent = errText(err);
    } finally {
      button.disabled = false;
      button.textContent = submit;
    }
  });
  return el;
}

const field = (name, label, type = "text", attrs = {}) => h("label", {}, h("span", { text: label }), h("input", { name, type, ...attrs }));

function retentionSelect(name, value) {
  const s = h("select", { name });
  for (const d of RETENTION) s.append(h("option", { value: String(d), selected: d === value, text: d === 0 ? t("retention.0") : t("retention.days", { n: d }) }));
  return s;
}

// ── login ───────────────────────────────────────────────────────────────────────────────────────────────────────

function showLogin() {
  document.getElementById("who").replaceChildren();
  show(
    h("h1", { text: t("login.title") }),
    h("p", { class: "muted", text: t("login.intro") }),
    h("div", { class: "card" },
      form(
        [
          field("home", t("login.home"), "text", { placeholder: location.host, autocomplete: "off" }),
          field("handle", t("login.handle"), "text", { required: true, autocomplete: "username" }),
          field("password", t("login.password"), "password", { required: true, autocomplete: "current-password" }),
        ],
        t("login.submit"),
        t("login.busy"),
        async (d) => {
          const home = await id.resolveHome(api, d.get("home"));
          const login = await id.login(api, home, String(d.get("handle")), String(d.get("password")));
          try {
            const { nonce } = await call("POST", "/challenge", {}, null);
            const proof = await rc.prove(login.state, "account", login.unlocked.contents.accountSeed, rc.base64urlDecode(nonce), `${location.origin}/bridge`);
            const r = await call("POST", "/login", { account: login.state.account, home, nonce, proof }, null);
            session = { token: r.token, account: r.account, handle: r.handle, max: r.max_bots };
          } finally {
            login.unlocked.contents.accountSeed.fill(0);
            await id.logout(api, home, login.token); // the session at the home is not needed
          }
          await showBots();
        },
      ),
      h("p", { class: "muted", text: t("login.note") }),
    ),
  );
}

// ── bots ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function showBots(secret = null) {
  const r = await call("GET", "/bots");
  const logout = h("button", { type: "button", class: "ghost", text: t("logout") });
  logout.addEventListener("click", async () => {
    await call("POST", "/logout", {}).catch(() => {});
    session = null;
    showLogin();
  });
  document.getElementById("who").replaceChildren(h("span", { class: "row" }, h("code", { text: session.handle }), logout));
  const nodes = [];
  if (secret) nodes.push(secretCard(secret));
  nodes.push(h("h1", { text: t("bots.title") }), h("p", { class: "muted", text: t("bots.count", { n: r.bots.length, max: r.max_bots }) }));
  if (!r.bots.length) nodes.push(h("p", { text: t("bots.none") }));
  nodes.push(h("p", { class: "muted" }, h("small", { text: t("owner.account", { account: session.account }) })));
  for (const b of r.bots) nodes.push(botCard(b));
  if (r.bots.length < r.max_bots) nodes.push(createCard());
  if (r.bots.length) nodes.push(apiCard(r.bots[0]));
  show(...nodes);
  if (secret) main.querySelector(".secret")?.scrollIntoView();
}

function botCard(b) {
  const auto = h("input", { type: "checkbox", checked: b.auto_accept });
  auto.addEventListener("change", async () => {
    try {
      await call("POST", `/bots/${b.account}`, { auto_accept: auto.checked });
    } catch (e) {
      auto.checked = !auto.checked;
      alert(errText(e));
    }
  });
  const only = h("input", { type: "checkbox", checked: b.owner_only });
  only.addEventListener("change", async () => {
    try {
      await call("POST", `/bots/${b.account}`, { owner_only: only.checked });
    } catch (e) {
      only.checked = !only.checked;
      alert(errText(e));
    }
  });
  const keep = retentionSelect("retention", b.retention_days);
  keep.addEventListener("change", async () => {
    try {
      await call("POST", `/bots/${b.account}`, { retention_days: Number(keep.value) });
    } catch (e) {
      alert(errText(e));
    }
  });
  const newKey = h("button", { type: "button", class: "ghost", text: t("bots.newKey") });
  newKey.addEventListener("click", async () => {
    if (!confirm(t("bots.newKeyConfirm"))) return;
    try {
      const r = await call("POST", `/bots/${b.account}/key`, {});
      await showBots({ bot: r.bot, key: r.api_key });
    } catch (e) {
      alert(errText(e));
    }
  });
  const del = h("button", { type: "button", class: "danger", text: t("bots.delete") });
  del.addEventListener("click", async () => {
    if (!confirm(t("bots.deleteConfirm", { handle: b.handle }))) return;
    try {
      await call("DELETE", `/bots/${b.account}`);
      await showBots();
    } catch (e) {
      alert(errText(e));
    }
  });
  return h("div", { class: "card" },
    h("h2", { text: b.handle }),
    h("table", {},
      h("tr", {}, h("td", { text: t("bots.address") }), h("td", {}, h("code", { text: b.address }), " ", copyButton(b.address))),
      h("tr", {}, h("td", { text: t("bots.created") }), h("td", { text: date(b.created) })),
      h("tr", {}, h("td", { text: t("bots.key") }), h("td", { text: t("bots.keyHint", { hint: b.key_hint, date: date(b.key_created) }) })),
      h("tr", {}, h("td", { text: t("bots.retention") }), h("td", {}, keep)),
    ),
    h("label", { class: "check" }, only, h("span", { text: t("bots.ownerOnly", { handle: session.handle }) })),
    h("label", { class: "check" }, auto, h("span", { text: t("bots.autoAccept") })),
    h("div", { class: "row" }, newKey, del),
  );
}

function createCard() {
  return h("div", { class: "card" },
    h("h2", { text: t("create.title") }),
    form(
      [
        field("name", t("create.name"), "text", { required: true, maxlength: "32", pattern: "[A-Za-z0-9_.\\-]{1,32}", autocomplete: "off" }),
        h("label", {}, h("span", { text: t("bots.retention") }), retentionSelect("retention", 0)),
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "only" }), h("span", { text: t("bots.ownerOnly", { handle: session.handle }) })),
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "auto" }), h("span", { text: t("bots.autoAccept") })),
      ],
      t("create.submit"),
      t("create.busy"),
      async (d) => {
        const r = await call("POST", "/bots", { name: String(d.get("name")), auto_accept: d.get("auto") === "on", owner_only: d.get("only") === "on", retention_days: Number(d.get("retention")) });
        await showBots({ bot: r.bot, key: r.api_key, card: r.card, cardText: r.card_text });
      },
    ),
  );
}

/** The API key (and, for a new bot, the recovery card), shown once. */
function secretCard({ bot, key, card, cardText }) {
  const done = h("button", { type: "button", text: t("secret.done") });
  done.addEventListener("click", () => showBots());
  const parts = [h("h2", { text: `${t("secret.title")}: ${bot.handle}` }), h("p", { text: t("secret.key") }), h("pre", { text: key }), h("div", { class: "row" }, copyButton(key))];
  if (card) {
    const base = `${bot.handle.replace("#", "-")}.rootcard-card`;
    const dl = h("button", { type: "button", class: "ghost", text: t("secret.download") });
    dl.addEventListener("click", () => download(`${base}.json`, rc.canonicalString(card), "application/json"));
    const txt = h("button", { type: "button", class: "ghost", text: ".txt" });
    txt.addEventListener("click", () => download(`${base}.txt`, cardText, "text/plain"));
    parts.push(h("p", { text: t("secret.card") }), h("pre", { text: cardText }), h("div", { class: "row" }, dl, txt));
  }
  parts.push(h("p", {}), h("div", { class: "row" }, done));
  return h("div", { class: "card secret", role: "alert" }, ...parts);
}

function apiCard(b) {
  const o = location.origin;
  const ex = [
    `# Who am I`,
    `curl -H "Authorization: Bearer $KEY" ${o}/bridge/api/v1/me`,
    ``,
    `# Send (a text to a contact; to someone new, a message request with the text as note)`,
    `curl -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\`,
    `  -d '{"to":"Name#TAG","text":"Hello"}' ${o}/bridge/api/v1/messages`,
    ``,
    `# Receive (waits up to 30 s); with retention, confirm with ?after=<next>`,
    `curl -H "Authorization: Bearer $KEY" "${o}/bridge/api/v1/messages?wait=30"`,
    ``,
    `# Contacts, and answering a request`,
    `curl -H "Authorization: Bearer $KEY" ${o}/bridge/api/v1/contacts`,
    `curl -X POST -H "Authorization: Bearer $KEY" ${o}/bridge/api/v1/contacts/<account>/accept`,
  ].join("\n");
  return h("div", { class: "card" }, h("h2", { text: t("api.title") }), h("p", { class: "muted", text: t("api.intro") }), h("pre", { text: `# ${b.address}\n${ex}` }));
}

showLogin();
