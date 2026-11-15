// GIF search at GIPHY, only when the server operator configured a key (GET /api/v1/info: `giphy`).
//
// The browser talks to GIPHY itself: the Murmo server never sees a search. GIPHY does see the user's address and what
// they search for, and that traffic is protected by HTTPS only, not by Murmo's end-to-end encryption; the interface
// says so where the search is (docs/DESIGN.md §9.3). Requests carry no cookies and no referrer, media URLs are
// stripped of their tracking parameters, and only GIPHY's own hosts are contacted (also enforced by the CSP).

/** The media hosts results may point to (the same list as the server's CSP, server/src/app.rs GIPHY_HOSTS). */
export const MEDIA_HOSTS = ["media.giphy.com", "media0.giphy.com", "media1.giphy.com", "media2.giphy.com", "media3.giphy.com", "media4.giphy.com", "i.giphy.com"];

const API = "https://api.giphy.com/v1/gifs/search";
const FETCH = { credentials: "omit", referrerPolicy: "no-referrer", mode: "cors" };

/** A GIPHY media URL without its query (tracking ids), or null when it is not https on one of MEDIA_HOSTS. */
export function mediaUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" || !MEDIA_HOSTS.includes(url.hostname) || url.port) return null;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The results of a search response, as `[{ id, title, preview, full }]`: `preview` a small rendition for the grid,
 * `full` the largest GIF rendition within `maxBytes`. Entries without usable URLs are left out.
 */
export function parseResults(json, maxBytes) {
  const out = [];
  for (const d of Array.isArray(json?.data) ? json.data : []) {
    const im = d?.images ?? {};
    const preview = mediaUrl(im.fixed_width_small?.url ?? im.fixed_width?.url ?? im.preview_gif?.url);
    let full = null;
    for (const k of ["original", "downsized_medium", "downsized", "fixed_width"]) {
      const r = im[k];
      const size = Number(r?.size);
      if (r?.url && Number.isFinite(size) && size > 0 && size <= maxBytes) {
        full = mediaUrl(r.url);
        if (full) break;
      }
    }
    if (preview && full) out.push({ id: String(d.id ?? full), title: String(d.title ?? "").slice(0, 200), preview, full });
  }
  return out;
}

/** An error with a code the interface can explain. */
function fail(code) {
  return Object.assign(new Error(code), { code });
}

/** Search GIPHY in language `lang`: `config` is `info.giphy` (`{ key, rating }`). Throws `giphy_limit`, `giphy_key` or `giphy_failed`. */
export async function search(config, query, { maxBytes, limit = 24, signal, lang = "en" } = {}) {
  const q = String(query).trim().slice(0, 50);
  if (!q) return [];
  const url = new URL(API);
  url.search = new URLSearchParams({ api_key: config.key, q, limit: String(limit), rating: config.rating ?? "pg-13", lang }).toString();
  let r;
  try {
    r = await fetch(url, { ...FETCH, signal });
  } catch (x) {
    if (x?.name === "AbortError") throw x;
    throw fail("giphy_failed");
  }
  if (r.status === 429) throw fail("giphy_limit");
  if (r.status === 401 || r.status === 403) throw fail("giphy_key");
  if (!r.ok) throw fail("giphy_failed");
  return parseResults(await r.json(), maxBytes);
}

/** Fetch one GIF (a URL from `parseResults`) as a Blob, refusing anything larger than `maxBytes`. */
export async function fetchGif(url, maxBytes, signal) {
  if (!mediaUrl(url)) throw fail("giphy_failed");
  let r;
  try {
    r = await fetch(url, { ...FETCH, signal });
  } catch (x) {
    if (x?.name === "AbortError") throw x;
    throw fail("giphy_failed");
  }
  if (!r.ok) throw fail("giphy_failed");
  if (Number(r.headers.get("content-length")) > maxBytes) throw fail("gif_too_large");
  const b = await r.blob();
  if (b.size > maxBytes) throw fail("gif_too_large");
  return b;
}
