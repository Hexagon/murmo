// The "install as an app" box on the start page (index.html, #install). It is shown only where installing is
// possible and Murmo is not already running as an installed app:
//
// - browsers that offer their own install prompt (Chrome, Edge, Samsung Internet …) fire `beforeinstallprompt`; the
//   box then has a button that opens that prompt;
// - Safari on iPhone and iPad has no prompt, so the box says how: Share, then "Add to Home Screen";
// - Safari on a Mac (17 and later) likewise: File, then "Add to Dock".
//
// Anywhere else (Firefox on a computer, an already installed app) the box stays hidden.

const box = document.getElementById("install");
const button = document.getElementById("install-btn");
let deferred = null;

function standalone() {
  return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function show(kind) {
  if (!box || standalone()) return;
  for (const el of box.querySelectorAll("[data-install]")) el.hidden = el.dataset.install !== kind;
  box.hidden = false;
}

function hide() {
  if (box) box.hidden = true;
  deferred = null;
}

/** Safari (not Chrome, Firefox, Edge … on iOS, which cannot install web apps everywhere): "ios", "mac" or null. */
function safariKind() {
  const ua = navigator.userAgent;
  if (!/Safari\//.test(ua) || /Chrom|CriOS|FxiOS|EdgiOS|OPiOS|Android/.test(ua)) return null;
  const touch = navigator.maxTouchPoints > 1; // iPadOS says "Macintosh"
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch)) return "ios";
  if (/Macintosh/.test(ua) && Number(ua.match(/Version\/(\d+)/)?.[1] ?? 0) >= 17) return "mac";
  return null;
}

addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // show our own box instead of the browser's mini bar
  deferred = e;
  show("prompt");
});

addEventListener("appinstalled", hide);

button?.addEventListener("click", async () => {
  if (!deferred) return;
  const e = deferred;
  deferred = null;
  await e.prompt();
  const { outcome } = await e.userChoice;
  if (outcome === "accepted") hide();
  // When dismissed, the browser may fire `beforeinstallprompt` again later, which shows the box again.
  else box.hidden = true;
});

const safari = safariKind();
if (safari) show(safari);
