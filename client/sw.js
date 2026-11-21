// The service worker: notifications, and a screen for an app opened without a connection. It stores only that
// screen (offline.html and what it needs), never the app: the page is always the one the server serves, and the
// stored screen is shown only when the server cannot be reached at all.
//
// A push carries no data (docs/DESIGN.md §10.1): it only says that something waits in the mailbox. The worker has no
// keys and does not connect to the mailbox, so being woken does not make this device look connected.

const OFFLINE = "murmo-offline-1"; // a new name when the offline screen's files change
const OFFLINE_FILES = ["offline.html", "offline.css", "offline.js", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(OFFLINE);
      await cache.addAll(OFFLINE_FILES.map((f) => new Request(f, { cache: "reload" })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== OFFLINE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

// Opening a page goes to the network as always; only when that fails is the stored screen shown. Its own files are
// answered from the store when the network fails too. Everything else is not touched.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const own = url.origin === self.location.origin;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(async () => (await caches.match("offline.html")) ?? Response.error()));
  } else if (own && e.request.method === "GET" && OFFLINE_FILES.some((f) => url.pathname === new URL(f, self.location).pathname)) {
    e.respondWith(fetch(e.request).catch(async () => (await caches.match(e.request, { ignoreSearch: true })) ?? Response.error()));
  }
});

// The notification's only text, in the browser's language (the worker cannot import the page's i18n.js; English for
// languages without a translation).
const NEW_MESSAGE = { sv: "Nytt meddelande", en: "New message", de: "Neue Nachricht", es: "Mensaje nuevo" };
function newMessage() {
  for (const tag of self.navigator.languages ?? [self.navigator.language ?? ""]) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (base in NEW_MESSAGE) return NEW_MESSAGE[base];
  }
  return NEW_MESSAGE.en;
}

// Safari withdraws the push permission from a site whose pushes do not show a notification.
const MUST_SHOW = /iPhone|iPad|Macintosh/.test(self.navigator.userAgent) && !/Chrom/.test(self.navigator.userAgent);

self.addEventListener("push", (e) => {
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!MUST_SHOW && wins.some((w) => w.visibilityState === "visible")) return; // the open page shows it
      await self.registration.showNotification("Murmo", {
        body: newMessage(),
        tag: "murmo",
        renotify: true,
        icon: "icon-512.png",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const w = wins.find((x) => "focus" in x);
      if (w) return w.focus();
      return self.clients.openWindow("./");
    })(),
  );
});
