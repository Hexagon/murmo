// rootcard registration and login (rootcard GETTING_STARTED §2) at this server's own home or at another home such as
// rootcard.org, and the local secret kept in the vault (docs/DESIGN.md §3, §8).

import * as rc from "../vendor/rootcard/src/index.js";
import { register as rcRegister, deriveLockSecrets, unlockVault, updateContents } from "../vendor/rootcard/src/vault-index.js";
import { ApiError } from "./api.js";

// The vault entry keeps the project's old name ("mesg") so that existing accounts find their local secret.
const LOCAL_KEY = "app.mesg.localkey";
const HANDLE = /^[A-Za-z0-9_.-]{1,32}#[0-9A-Za-z]{4}(-[0-9A-Za-z]{1,48})?$/;
const now = () => Math.floor(Date.now() / 1000);

/**
 * The rootcard base URL for what the user typed: empty for this server, otherwise a domain (`rootcard.org`), an origin
 * or a base URL. A domain is resolved with its host pointer `/.well-known/rootcard` ([HST-23]).
 */
export async function resolveHome(api, input) {
  const t = (input ?? "").trim();
  if (!t) return api.base;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw new ApiError(400, "bad_home");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    rc.checkBaseUrl(base);
    return base;
  }
  try {
    const res = await fetch(`${url.origin}${rc.WELL_KNOWN_PATH}`, { credentials: "omit", redirect: "error", cache: "no-store" });
    if (res.ok) {
      const doc = rc.parseJson(new Uint8Array(await res.arrayBuffer()));
      return rc.wellKnownBase(url.origin, doc);
    }
  } catch (e) {
    if (e instanceof TypeError) throw new ApiError(502, "home_unreachable");
  }
  return url.origin; // an origin without a pointer is the base URL itself
}

/** A home's descriptor and its realm. */
export async function hostInfo(api, base) {
  const host = await api.rcAt(base, "GET", "/host");
  const realm = host.realms?.[0]?.realm;
  if (typeof realm !== "string") throw new ApiError(500, "no_realm");
  return { host, realm };
}

/**
 * Prepare a registration at this server's own home: everything is built in the browser and the recovery card is
 * returned FIRST. The caller must have the user save the card, then call `finish()`, which sends the registration.
 */
export async function prepareRegistration(api, username, password) {
  const { host, realm } = await hostInfo(api, api.base);
  const recoveryKey = await rc.newRecoveryKey(realm, username, rc.systemRandom);
  let reg;
  try {
    reg = await rcRegister(recoveryKey, realm, username, password, "Password", { key: host.key, url: api.base }, now(), rc.KDF_DEFAULT, rc.systemRandom);
  } finally {
    recoveryKey.fill(0);
  }
  const cardText = await rc.cardText(reg.card);
  return {
    realm,
    account: reg.account,
    card: reg.card,
    cardText,
    finish: () => api.rc("POST", "/id/register", { log: reg.log, vault: reg.vault, public: reg.public }),
  };
}

/** Fetch an account's log from its home and verify it ourselves; the home must be the one the log names. */
export async function fetchState(api, home, realms, account) {
  const { events } = await api.rcAt(home, "GET", `/id/${account}/log`);
  const state = await rc.verifyLog(events, { realms, now: now() });
  if (state.account !== account) throw new ApiError(502, "bad_log");
  if (!state.instance) throw new ApiError(410, "account_retired");
  if (state.instance.home.url !== home) throw new ApiError(409, "not_home");
  return state;
}

/** Check the shape of an identifier: `Name#TAG`, optionally `@host` for an identity from another home. */
export function checkHandle(handle) {
  const [h] = handle.trim().split("@");
  if (!HANDLE.test(h)) throw new ApiError(400, "bad_handle");
  return handle.trim();
}

/**
 * Look up an exact identifier among the identities known to this murmo server, then verify the identity's log from
 * its own home. There is no search: the full handle is required.
 */
export async function lookup(api, realms, handle) {
  const found = await api.lookup(checkHandle(handle));
  return fetchState(api, found.home, realms, found.account);
}

/**
 * Log in at `home` (a base URL) with handle and password. Returns `{ state, realm, home, token, unlocked, vault }`;
 * the caller must erase `unlocked.contents.accountSeed` when done with it.
 */
export async function login(api, home, handle, password, onProgress = () => {}) {
  const { realm } = await hostInfo(api, home);
  const [h] = checkHandle(handle).split("@");
  const found = await api.rcAt(home, "GET", `/id/lookup?realm=${encodeURIComponent(realm)}&handle=${encodeURIComponent(h)}`);
  const state = await fetchState(api, home, [realm], found.account);
  const { locks } = await api.rcAt(home, "GET", `/id/${state.account}/locks`);
  const lock = locks[0];
  if (!lock) throw new ApiError(409, "no_password");
  onProgress("deriving");
  const { authSeed } = await deriveLockSecrets(state.account, lock.id, password, lock.kdf, rc.base64urlDecode(lock.kdf.salt));
  onProgress("unlocking");
  const fch = rc.parseChallenge(await api.rcAt(home, "POST", `/id/${state.account}/challenge`, { purpose: "fetch" }));
  const fsig = await rc.ed25519Sign(authSeed, rc.fetchMessage(state.account, fch.host, lock.id, fch.nonce, home));
  authSeed.fill(0);
  const { vault } = await api.rcAt(home, "POST", `/id/${state.account}/fetch`, { lock: lock.id, nonce: fch.nonce, url: home, sig: rc.base64urlEncode(fsig) });
  const unlocked = await unlockVault(vault, state, { lock: lock.id, password });
  const lch = await api.rcAt(home, "POST", `/id/${state.account}/challenge`, { purpose: "login" });
  const req = await rc.signLogin(state, lch, home, lock.id, unlocked.contents.accountSeed, unlocked.lockSeed);
  const session = await api.rcAt(home, "POST", `/id/${state.account}/login`, req);
  return { state, realm, home, token: session.token, unlocked, vault };
}

/** The account's local secret from the vault, created (and saved to the vault at the home) on first use. */
export async function localSecret(api, login) {
  const { unlocked, vault, token, home } = login;
  const v = unlocked.contents.data?.[LOCAL_KEY];
  if (typeof v === "string") return rc.base64urlDecode(v);
  const secret = rc.systemRandom(32);
  const data = rc.setData(unlocked.contents.data ?? {}, "mesg", LOCAL_KEY, rc.base64urlEncode(secret));
  const next = await updateContents(unlocked, vault, { ...unlocked.contents, data }, rc.systemRandom);
  await api.rcAt(home, "PUT", "/session/vault", { vault: next }, token);
  return secret;
}

/** A rootcard proof by the account key for a challenge from this murmo server (used to request linking). */
export async function proveToServer(api, state, accountSeed) {
  const { nonce } = await api.challenge();
  const proof = await rc.prove(state, "account", accountSeed, rc.base64urlDecode(nonce), api.origin);
  return { proof, nonce };
}

export async function logout(api, home, token) {
  if (!token) return;
  try {
    await api.rcAt(home, "POST", "/session/logout", undefined, token);
  } catch {
    // the session may have expired already
  }
}
