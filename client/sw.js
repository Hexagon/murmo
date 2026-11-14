// The service worker: notifications only. It has no fetch handler and caches nothing, so the page is always the
// one the server serves.
//
// A push carries no data (docs/DESIGN.md §10.1): it only says that something waits in the mailbox. The worker has no
// keys and does not connect to the mailbox, so being woken does not make this device look connected.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Safari withdraws the push permission from a site whose pushes do not show a notification.
const MUST_SHOW = /iPhone|iPad|Macintosh/.test(self.navigator.userAgent) && !/Chrom/.test(self.navigator.userAgent);

self.addEventListener("push", (e) => {
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!MUST_SHOW && wins.some((w) => w.visibilityState === "visible")) return; // the open page shows it
      await self.registration.showNotification("mesg", {
        body: "Nytt meddelande",
        tag: "mesg",
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
