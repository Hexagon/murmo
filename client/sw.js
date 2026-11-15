// The service worker: notifications only. It has no fetch handler and caches nothing, so the page is always the
// one the server serves.
//
// A push carries no data (docs/DESIGN.md §10.1): it only says that something waits in the mailbox. The worker has no
// keys and does not connect to the mailbox, so being woken does not make this device look connected.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

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
