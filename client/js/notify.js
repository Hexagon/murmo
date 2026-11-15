// Notifications: shown by the page while it runs in the background, and by the service worker (sw.js) after a
// content-free push when the page is frozen or closed (docs/DESIGN.md §10.1).

import * as p from "./protocol.js";

const TAG = "murmo";

/** "ok", or why notifications cannot work here: "insecure", "ios-install" (add to the home screen first), "unsupported". */
export function support() {
  if (!globalThis.isSecureContext) return "insecure";
  if ("serviceWorker" in navigator && "Notification" in globalThis) return "ok";
  if (/iPhone|iPad/.test(navigator.userAgent)) return "ios-install";
  return "unsupported";
}

export function permission() {
  return "Notification" in globalThis ? Notification.permission : "denied";
}

function registration() {
  return navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
}

async function activeRegistration() {
  await registration();
  return navigator.serviceWorker.ready;
}

/**
 * Ask for permission (call from a click) and register the worker. Returns "granted", "denied" or "default".
 */
export async function request() {
  if (support() !== "ok") return "denied";
  const r = await Notification.requestPermission();
  if (r === "granted") await registration();
  return r;
}

/**
 * The push endpoint of this browser for the server's key (subscribing if needed), or null when push is not
 * available here. Notifications from the open page work without it.
 */
export async function pushEndpoint(serverKey) {
  if (support() !== "ok" || permission() !== "granted" || !serverKey) return null;
  const reg = await activeRegistration();
  if (!reg.pushManager) return null;
  const key = p.unb64(serverKey);
  let sub = await reg.pushManager.getSubscription();
  const current = sub?.options?.applicationServerKey;
  if (sub && current && p.b64(new Uint8Array(current)) !== serverKey) {
    await sub.unsubscribe(); // the server has a new key
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return sub.endpoint;
}

/** Stop push on this browser. */
export async function unsubscribe() {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager?.getSubscription();
  await sub?.unsubscribe();
}

/** Show a notification from the page (through the worker: Android has no `new Notification`). */
export async function show(body) {
  if (support() !== "ok" || permission() !== "granted") return;
  const reg = await activeRegistration();
  await reg.showNotification("Murmo", { body, tag: TAG, renotify: true, icon: "icon-512.png" });
}

/** Remove our notifications (the user is looking at the page). */
export async function clear() {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  for (const n of (await reg?.getNotifications?.({ tag: TAG })) ?? []) n.close();
}
