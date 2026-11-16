// Browser smoke test of the real UI with two users in headless Chrome (puppeteer-core, no browser download).
//
//   MURMO_ORIGIN=http://127.0.0.1:18100 MURMO_BIND=127.0.0.1:18100 MURMO_DB=/tmp/ui.sqlite MURMO_HOST_KEY_FILE=/tmp/ui.key \
//     MURMO_LIMIT_SCALE=10 MURMO_GIPHY_KEY=testkey cargo run &
//   CHROME=/usr/bin/google-chrome node tests/ui-smoke.mjs   (screenshots in $SHOTS, default /tmp/murmo-shots)
//
// It fails on any console error or warning, so CSP violations show up here. Requests to GIPHY never leave the test:
// they are answered here (after the page's CSP has allowed them), and they are recorded to check what was sent.

import puppeteer from "puppeteer-core";
const BASE = process.env.MURMO_URL ?? "http://127.0.0.1:18100/";
const shots = process.env.SHOTS ?? "/tmp/murmo-shots";
(await import("node:fs")).mkdirSync(shots, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const problems = [];
const GIF_2X2 = Buffer.from("R0lGODlhAgACAIAAAP///wAAACH5BAEAAAAALAAAAAACAAIAAAIChFEAOw==", "base64");
const giphyRequests = [];
function giphy(req) {
  const url = new URL(req.url());
  giphyRequests.push({ url, headers: req.headers() });
  const cors = { "access-control-allow-origin": "*" };
  if (url.hostname === "api.giphy.com") {
    const media = (n) => ({ url: `https://media2.giphy.com/media/test/${n}?cid=track&rid=x`, size: String(GIF_2X2.length), width: "2", height: "2" });
    const data = [1, 2, 3].map((i) => ({ id: `g${i}`, title: `Test ${i}`, images: { fixed_width_small: media("100w.gif"), original: media("giphy.gif") } }));
    return req.respond({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ data }) });
  }
  return req.respond({ status: 200, headers: cors, contentType: "image/gif", body: GIF_2X2 });
}
/** Whether the app sees a mouse (`hover: hover`) or a touch screen. Headless Chrome reports no hover, and CDP cannot
 * emulate it, so the page's matchMedia answers that one query from a flag (set up in `page`). */
const hover = (pg, on) => pg.evaluate((v) => { window.__hover = v; }, on);
async function page(name, languages = null) {
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  // The flow below looks for the Swedish texts; `languages` instead lets the browser's own list choose.
  if (languages) await pg.evaluateOnNewDocument((l) => Object.defineProperty(navigator, "languages", { get: () => l }), languages);
  else await pg.evaluateOnNewDocument(() => localStorage.setItem("murmo-lang", "sv"));
  await pg.setViewport({ width: 1280, height: 800 });
  // Headless Chrome reports no hover, which the app takes for a touch screen (Enter would not send): act as a mouse.
  await pg.evaluateOnNewDocument(() => {
    window.__hover = true;
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => (q === "(hover: hover)" ? { matches: window.__hover, media: q } : real(q));
  });
  await pg.setRequestInterception(true);
  pg.on("request", (req) => (/\.giphy\.com$/.test(new URL(req.url()).hostname) ? giphy(req) : req.continue()));
  pg.on("console", (m) => { if (["error", "warning"].includes(m.type())) problems.push(`${name} console ${m.type()}: ${m.text()}`); });
  pg.on("pageerror", (e) => problems.push(`${name} pageerror: ${e.message}`));
  await pg.goto(BASE, { waitUntil: "networkidle0" });
  return pg;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function clickText(pg, text, sel = "button") {
  const els = await pg.$$(sel);
  for (const e of els) if ((await e.evaluate((x) => x.textContent.trim())) === text) return e.click();
  throw new Error(`no ${sel} with text ${text}`);
}
async function register(pg, user, tag) {
  await pg.screenshot({ path: `${shots}/${tag}-1-login.png` });
  await clickText(pg, "Skapa konto");
  const inputs = await pg.$$("form input");
  await inputs[0].type(user);
  await inputs[1].type("correct horse battery staple");
  await inputs[2].type("correct horse battery staple");
  await pg.screenshot({ path: `${shots}/${tag}-2-register.png` });
  await clickText(pg, "Fortsätt");
  await pg.waitForSelector("pre.cardtext", { timeout: 60000 });
  await pg.screenshot({ path: `${shots}/${tag}-3-card.png` });
  await pg.click(".check input");
  await clickText(pg, "Skapa konto");
  await pg.waitForSelector(".shell", { timeout: 60000 });
  await sleep(800);
  await pg.screenshot({ path: `${shots}/${tag}-4-welcome.png` });
  return pg.$eval(".me .h", (e) => e.textContent);
}
try {
  // The language follows the browser (German here, English for one we do not have), the start page included.
  for (const [langs, login, h1] of [[["de-AT", "en"], "Anmelden", "Verschlüsselte Nachrichten ohne Telefonnummer"], [["fr-FR"], "Log in", "Encrypted messages without a phone number"]]) {
    const pg = await page(`lang-${langs[0]}`, langs);
    await pg.waitForSelector(".auth .tabs button", { timeout: 10000 });
    const got = await pg.evaluate(() => [document.querySelector(".auth .tabs button").textContent, document.querySelector(".hero h1").textContent, document.documentElement.lang]);
    if (got[0] !== login || got[1] !== h1) throw new Error(`language ${langs}: ${got}`);
    await pg.screenshot({ path: `${shots}/lang-${langs[0]}.png` });
    // Chosen in the picker: the page and the form change at once, and the choice is kept.
    await pg.select(".auth-foot select.lang", "es");
    const es = await pg.evaluate(() => [document.querySelector(".auth .tabs button").textContent, document.documentElement.lang]);
    if (es[0] !== "Iniciar sesión" || es[1] !== "es") throw new Error(`picked Spanish: ${es}`);
    await pg.browserContext().close();
  }
  const a = await page("alice");
  const aliceHandle = await register(a, "Alice", "a");
  const b = await page("bob");
  const bobHandle = await register(b, "Bob", "b");
  console.log("handles", aliceHandle, bobHandle);
  // Alice requests Bob by exact identifier.
  await a.type("#new-handle", bobHandle);
  await a.type("#new-note", "Hej Bob! Det är Alice.");
  await a.keyboard.press("Enter");
  await a.waitForSelector(".topbar .title .tag", { timeout: 20000 });
  await sleep(500);
  await a.screenshot({ path: `${shots}/a-5-requested.png` });
  // Bob sees the request and accepts.
  await b.waitForFunction(() => [...document.querySelectorAll(".side-head")].some((x) => x.textContent === "Förfrågningar"), { timeout: 20000 });
  // The tab title counts what waits (the Omarchy bar reads it for its badge): one request, and nothing once answered.
  await b.waitForFunction(() => document.title === "(1) Murmo", { timeout: 5000 });
  await b.click(".conv");
  await sleep(500);
  await b.screenshot({ path: `${shots}/b-5-request.png` });
  await clickText(b, "Acceptera");
  await b.waitForSelector(".composer textarea", { timeout: 20000 });
  await b.waitForFunction(() => !document.title.startsWith("("), { timeout: 5000 });
  // Alice's open conversation turns into a chat by itself once Bob accepts (no reload).
  await a.waitForSelector(".composer textarea", { timeout: 20000 });
  await b.type(".composer textarea", "Hej Alice! Kul att höras.\nAndra raden.");
  await b.keyboard.press("Enter");
  // Alice opens the conversation and replies; sends an image.
  await a.waitForFunction(() => !document.querySelector(".badge.muted"), { timeout: 20000 });

  await a.click(".conv");
  await a.waitForSelector(".composer textarea", { timeout: 20000 });
  await a.type(".composer textarea", "Hej! Här är en bild:");
  await a.keyboard.press("Enter");
  // Code (DESIGN.md §6.10): inside an open ``` block Enter makes a new line; after the closing fence it sends.
  const value = () => a.$eval(".composer textarea", (t) => t.value);
  await a.type(".composer textarea", "Kör `npm test` först:");
  await a.keyboard.down("Shift");
  await a.keyboard.press("Enter");
  await a.keyboard.up("Shift");
  await a.type(".composer textarea", "```js");
  await a.keyboard.press("Enter");
  await a.type(".composer textarea", 'const x = "<b>hej</b>"; // ok');
  await a.keyboard.press("Enter");
  if ((await value()) !== 'Kör `npm test` först:\n```js\nconst x = "<b>hej</b>"; // ok\n') throw new Error(`Enter inside a code block: ${JSON.stringify(await value())}`);
  await a.type(".composer textarea", "```");
  await a.keyboard.press("Enter");
  if (await value()) throw new Error("Enter after the closing fence did not send");
  // On a touch screen there is no Shift+Enter: Enter is always a new line and the send button sends.
  await hover(a, false);
  await a.type(".composer textarea", "Rad ett");
  await a.keyboard.press("Enter");
  await a.type(".composer textarea", "rad två");
  if ((await value()) !== "Rad ett\nrad två") throw new Error(`Enter on a touch screen: ${JSON.stringify(await value())}`);
  await a.click(".composer .send");
  await a.waitForFunction(() => !document.querySelector(".composer textarea").value, { timeout: 5000 });
  await hover(a, true);
  await b.waitForSelector(".msg .codeblock", { timeout: 20000 });
  const shown = await b.evaluate(() => {
    const m = [...document.querySelectorAll(".msg")].find((x) => x.querySelector(".codeblock"));
    return {
      inline: m.querySelector("code.ic")?.textContent,
      lang: m.querySelector(".cb-lang")?.textContent,
      code: m.querySelector(".codeblock pre").textContent,
      kw: m.querySelector(".tk-k")?.textContent,
      comment: m.querySelector(".tk-c")?.textContent,
      bold: m.querySelector("b") !== null,
    };
  });
  if (shown.inline !== "npm test" || shown.lang !== "JavaScript" || shown.code !== 'const x = "<b>hej</b>"; // ok' || shown.kw !== "const" || shown.comment !== "// ok" || shown.bold) {
    throw new Error(`code shown wrongly: ${JSON.stringify(shown)}`);
  }
  await b.screenshot({ path: `${shots}/b-5c-code.png` });
  const [chooser] = await Promise.all([a.waitForFileChooser(), a.click(".composer .icon-btn")]);
  await chooser.accept([new URL("../client/icon.svg", import.meta.url).pathname]); // not an inline type: shown as a file card
  await sleep(1500);
  // A PNG for inline display.
  const png = await a.screenshot({ type: "png", clip: { x: 0, y: 0, width: 320, height: 200 } });
  const fs = await import("node:fs");
  fs.writeFileSync(`${shots}/sample.png`, png);
  const [ch2] = await Promise.all([a.waitForFileChooser(), a.click(".composer .icon-btn")]);
  await ch2.accept([`${shots}/sample.png`]);
  // The sender sees the file on its way above the composer, and how it went.
  await a.waitForFunction(() => [...document.querySelectorAll(".uploads .upload")].some((e) => /sample\.png/.test(e.textContent)), { timeout: 20000 });
  await a.waitForFunction(() => document.querySelector(".uploads .upload.ok, .uploads .upload.wait"), { timeout: 20000 });
  await a.screenshot({ path: `${shots}/a-6a-upload.png` });
  await b.waitForSelector(".msg img.inline", { timeout: 20000 });
  await sleep(1000);
  // A picture already shown is kept when the thread is drawn again (new messages): not loaded anew, no blinking.
  await b.evaluate(() => { window.__shownImg = document.querySelector(".msg img.inline"); });
  // The picture opens full size and closes with the cross.
  await b.click(".msg img.inline");
  await b.waitForSelector("dialog.viewer .close", { visible: true, timeout: 5000 });
  await b.screenshot({ path: `${shots}/b-6b-viewer.png` });
  await b.click("dialog.viewer .close");
  await b.waitForFunction(() => !document.querySelector("dialog.viewer"), { timeout: 5000 });
  // A PNG whose header claims 50000 × 50000 pixels is not decoded: it becomes a card with "Spara".
  const bomb = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(bomb);
  bomb.writeUInt32BE(50000, 16);
  bomb.writeUInt32BE(50000, 20);
  fs.writeFileSync(`${shots}/bomb.png`, bomb);
  const [ch3] = await Promise.all([a.waitForFileChooser(), a.click(".composer .icon-btn")]);
  await ch3.accept([`${shots}/bomb.png`]);
  await b.waitForFunction(() => [...document.querySelectorAll(".msg .filecard .fs")].some((e) => /50\s?000 × 50\s?000/.test(e.textContent)), { timeout: 20000 }); // the numbers are written the local way
  if ((await b.$$(".msg img.inline")).length !== 1) throw new Error("the oversized image was shown inline");
  if (!(await b.evaluate(() => window.__shownImg?.isConnected && window.__shownImg === document.querySelector(".msg img.inline")))) throw new Error("the picture was made again when the thread was drawn");
  // A video is a card with a play button; played, it is shown in the conversation and goes on playing when the thread
  // is drawn again. A video the browser cannot decode goes back to a card that says so.
  const webm = await a.evaluate(async () => {
    const c = Object.assign(document.createElement("canvas"), { width: 64, height: 48 });
    const g = c.getContext("2d");
    const rec = new MediaRecorder(c.captureStream(10), { mimeType: "video/webm" });
    const parts = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start();
    for (let i = 0; i < 10; i++) {
      g.fillStyle = `hsl(${i * 36} 80% 50%)`;
      g.fillRect(0, 0, 64, 48);
      await new Promise((r) => setTimeout(r, 100));
    }
    rec.stop();
    await stopped;
    const b = new Uint8Array(await new Blob(parts).arrayBuffer());
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  });
  fs.writeFileSync(`${shots}/klipp.webm`, Buffer.from(webm, "base64"));
  fs.writeFileSync(`${shots}/trasig.mp4`, Buffer.alloc(4096, 7));
  for (const name of ["klipp.webm", "trasig.mp4"]) {
    const [chooser] = await Promise.all([a.waitForFileChooser(), a.click(".composer .icon-btn")]);
    await chooser.accept([`${shots}/${name}`]);
    await b.waitForFunction((n) => [...document.querySelectorAll(".msg .filecard .fn")].some((e) => e.textContent === n), { timeout: 20000 }, name);
  }
  const playOf = (name) => b.evaluateHandle((n) => [...document.querySelectorAll(".msg .filecard")].find((c) => c.querySelector(".fn")?.textContent === n)?.querySelector("button.ico.play"), name);
  await (await playOf("klipp.webm")).click();
  await b.waitForFunction(() => { const v = document.querySelector(".msg .videobox video"); return v && v.readyState >= 1 && v.duration > 0; }, { timeout: 10000 });
  await b.evaluate(() => { window.__video = document.querySelector(".msg .videobox video"); });
  await b.screenshot({ path: `${shots}/b-6v-video.png` });
  await (await playOf("trasig.mp4")).click();
  await b.waitForFunction(() => [...document.querySelectorAll(".msg .filecard .fs")].some((e) => /kan inte spelas upp här/.test(e.textContent)), { timeout: 10000 });
  if (!(await b.evaluate(() => window.__video?.isConnected && window.__video === document.querySelector(".msg .videobox video")))) throw new Error("the video was made again when the thread was drawn");
  // Emoji: picked from the panel into the text, and a message of only emoji is shown larger.
  await a.click('.composer .icon-btn[aria-label="Emoji"]');
  await a.waitForSelector(".picker .emoji-grid .emoji", { visible: true, timeout: 5000 });
  await a.screenshot({ path: `${shots}/a-6c-emoji.png` });
  await a.click(".picker .emoji-grid .emoji");
  await a.click(".picker .emoji-grid .emoji");
  await a.focus(".composer textarea");
  await a.keyboard.press("Enter");
  await b.waitForSelector(".msg .body.jumbo", { timeout: 20000 });
  if (await a.$(".picker:not(.hidden)")) await a.keyboard.press("Escape");
  // Disappearing messages: the timer stays on, files wait; the countdown starts on screen, the message fades away.
  await a.click(".composer .timer-btn");
  await a.waitForSelector(".timer-menu", { visible: true, timeout: 5000 });
  await a.screenshot({ path: `${shots}/a-6d-timer-menu.png` });
  await clickText(a, "15 s", ".timer-menu button");
  await a.waitForSelector(".composer.ephemeral .timer-btn.on", { timeout: 5000 });
  if (!(await a.$eval(".composer textarea", (t) => t.placeholder)).startsWith("Försvinnande meddelande")) throw new Error("the placeholder does not say the message disappears");
  if (!(await a.$eval(".composer .gif-btn", (x) => x.disabled))) throw new Error("GIFs can be sent with a timer on");
  await a.type(".composer textarea", "Den här försvinner.");
  await a.keyboard.press("Enter");
  await b.waitForSelector(".msg.ephemeral.in .fuse[data-end]", { timeout: 20000 }); // seen: the countdown runs
  await a.waitForSelector(".msg.ephemeral.out .fuse[data-end]", { timeout: 20000 }); // delivered: the sender's too
  await b.screenshot({ path: `${shots}/b-6e-ephemeral.png` });
  if (!(await a.$(".composer .timer-btn.on"))) throw new Error("the timer did not stay on after sending");
  await b.waitForSelector(".msg.ephemeral.dissolve", { timeout: 20000 });
  await b.screenshot({ path: `${shots}/b-6f-dissolve.png` });
  await b.waitForFunction(() => !document.querySelector(".msg.ephemeral"), { timeout: 10000 });
  await a.waitForFunction(() => !document.querySelector(".msg.ephemeral"), { timeout: 20000 });
  // With the timer on, a picture goes as a disappearing picture (no "Spara" anywhere); another file is refused.
  const [eph] = await Promise.all([a.waitForFileChooser(), a.click(".composer .icon-btn[aria-label='Bifoga fil']")]);
  await eph.accept([new URL("../client/icon.svg", import.meta.url).pathname]);
  await a.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /bara bilder/.test(t.textContent)), { timeout: 5000 });
  const [eph2] = await Promise.all([a.waitForFileChooser(), a.click(".composer .icon-btn[aria-label='Bifoga fil']")]);
  await eph2.accept([`${shots}/sample.png`]);
  await b.waitForSelector(".msg.ephemeral.in.media img.inline[src]", { timeout: 20000 });
  await b.waitForSelector(".msg.ephemeral.in .fuse[data-end]", { timeout: 20000 });
  await a.waitForSelector(".msg.ephemeral.out.media .fuse[data-end]", { timeout: 20000 });
  if (await b.$(".msg.ephemeral :is(.save-gif-inline, .filecard button)")) throw new Error("a disappearing picture can be saved");
  await b.screenshot({ path: `${shots}/b-6g-ephemeral-picture.png` });
  await b.click(".msg.ephemeral.in img.inline");
  await b.waitForSelector("dialog.viewer[data-f]", { timeout: 5000 });
  if (await b.$("dialog.viewer .save-gif")) throw new Error("the viewer offers to save a disappearing picture");
  // When the time is up the viewer closes, and the picture is gone on both sides.
  await b.waitForFunction(() => !document.querySelector("dialog.viewer") && !document.querySelector(".msg.ephemeral"), { timeout: 25000 });
  await a.waitForFunction(() => !document.querySelector(".msg.ephemeral"), { timeout: 20000 });
  await a.click(".composer .timer-btn");
  await clickText(a, "Av", ".timer-menu button");
  await a.waitForFunction(() => !document.querySelector(".composer.ephemeral"), { timeout: 5000 });
  // GIFs: picked from a file (and kept in the collection), then saved by the recipient from the viewer and resent.
  fs.writeFileSync(`${shots}/tiny.gif`, Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
  await a.click(".composer .gif-btn");
  await a.waitForSelector(".picker .gif-grid", { visible: true, timeout: 5000 });
  const [ch4] = await Promise.all([a.waitForFileChooser(), clickText(a, "Från fil…")]);
  await ch4.accept([`${shots}/tiny.gif`]);
  await a.waitForSelector(".picker .gif-grid .gif img", { timeout: 10000 });
  await a.screenshot({ path: `${shots}/a-6d-gifs.png` });
  await b.waitForFunction(() => document.querySelectorAll(".msg img.inline").length === 2, { timeout: 20000 });
  await sleep(500);
  // "Spara GIF" right under a received GIF; it turns into "✓ Sparad" (by content, so on every copy of that GIF).
  if ((await b.$$(".msg .save-gif-inline")).length !== 1) throw new Error("no save button under the received GIF");
  await b.click(".msg .save-gif-inline");
  await b.waitForSelector(".msg .save-gif-inline.saved", { timeout: 10000 });
  await b.screenshot({ path: `${shots}/b-6d-gif-saved.png` });
  // The viewer offers the same, and says it is already there.
  const imgs = await b.$$(".msg img.inline");
  await imgs[imgs.length - 1].click();
  await b.waitForSelector("dialog.viewer .save-gif", { visible: true, timeout: 5000 });
  await b.click("dialog.viewer .save-gif");
  await b.waitForFunction(() => !document.querySelector("dialog.viewer"), { timeout: 5000 });
  await b.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /redan/.test(t.textContent)), { timeout: 5000 });
  await b.click(".composer .gif-btn");
  await b.waitForSelector(".picker .gif-grid .gif img", { timeout: 10000 });
  await b.click(".picker .gif-grid .gif-send");
  await a.waitForFunction(() => document.querySelectorAll(".msg img.inline").length === 3, { timeout: 20000 });
  // The toasts ("GIF:en skickad.") go away by themselves; later steps click where they were.
  for (const pg of [a, b]) await pg.waitForFunction(() => !document.querySelector(".toast"), { timeout: 10000 });
  // Reactions: Bob reacts from the quick row, Alice sees it and adds the same by tapping the chip.
  if (await a.$(".picker:not(.hidden)")) await a.click(".composer .gif-btn"); // the GIF panel from before closes
  const bobMsgs = await b.$$(".msg");
  const target = bobMsgs[bobMsgs.length - 1];
  await target.hover();
  await (await target.$(".react-btn")).click();
  await b.waitForSelector(".react-menu button", { visible: true, timeout: 5000 });
  await b.screenshot({ path: `${shots}/b-6e-react-menu.png` });
  await b.click(".react-menu button");
  await a.waitForSelector(".msg .reaction", { timeout: 20000 });
  await a.click(".msg .reaction");
  await b.waitForFunction(() => document.querySelector(".msg .reaction .n")?.textContent === "2", { timeout: 20000 });
  await b.screenshot({ path: `${shots}/b-6f-reactions.png` });
  // "Ångra": a text waits above the composer and can be taken back before anything is sent.
  const count = (pg, sel) => pg.evaluate((s) => document.querySelectorAll(s).length, sel);
  const bobBefore = await count(b, ".msg");
  await a.type(".composer textarea", "Oj, fel");
  await a.keyboard.press("Enter");
  // It is shown in the thread like a sent message, with an undo button instead of the menu.
  await a.waitForSelector(".msg.out.held .undo-btn", { timeout: 5000 });
  if (await a.$(".msg.out.held .more-btn")) throw new Error("a waiting text shows the menu");
  await a.screenshot({ path: `${shots}/a-6h-undo.png` });
  await a.click(".msg.out.held .undo-btn");
  await a.waitForFunction(() => document.querySelector(".composer textarea").value === "Oj, fel" && !document.querySelector(".msg.held"), { timeout: 5000 });
  await sleep(6000);
  if ((await count(b, ".msg")) !== bobBefore) throw new Error("a text taken back with Ångra was sent");
  // Sent after all, then deleted for everyone: a placeholder on both sides.
  await a.keyboard.press("Enter");
  await b.waitForFunction((n) => document.querySelectorAll(".msg").length > n, { timeout: 20000 }, bobBefore);
  await a.waitForFunction(() => !document.querySelector(".msg.held"), { timeout: 10000 });
  // Edited: the new text and "redigerat" on both sides.
  const sentNow = await a.$$(".msg.out");
  const edited = sentNow[sentNow.length - 1];
  await edited.hover();
  await (await edited.$(".more-btn")).click();
  await clickText(a, "Redigera", "dialog button");
  await a.waitForSelector("dialog textarea", { timeout: 5000 });
  await a.$eval("dialog textarea", (t) => { t.value = ""; });
  await a.type("dialog textarea", "Oj, rätt");
  await a.screenshot({ path: `${shots}/a-6h2-edit.png` });
  await clickText(a, "Spara", "dialog button");
  await b.waitForFunction(() => [...document.querySelectorAll(".msg.in")].some((m) => m.textContent.includes("Oj, rätt") && m.querySelector(".edited")), { timeout: 20000 });
  await a.waitForFunction(() => [...document.querySelectorAll(".msg.out")].some((m) => m.textContent.includes("Oj, rätt") && m.querySelector(".edited")), { timeout: 10000 });
  await b.screenshot({ path: `${shots}/b-6h2-edited.png` });
  const own = await a.$$(".msg.out");
  const last = own[own.length - 1];
  await last.hover();
  await (await last.$(".more-btn")).click();
  await a.waitForSelector("dialog .btn.danger", { timeout: 5000 });
  await a.screenshot({ path: `${shots}/a-6i-delete-menu.png` });
  await clickText(a, "Ta bort för alla", "dialog button");
  await a.waitForFunction(() => [...document.querySelectorAll(".msg.retracted")].some((m) => m.textContent.includes("Du tog bort")), { timeout: 10000 });
  await b.waitForFunction(() => [...document.querySelectorAll(".msg.retracted")].some((m) => m.textContent.includes("tog bort ett meddelande")), { timeout: 20000 });
  if (await b.evaluate(() => [...document.querySelectorAll(".msg")].some((m) => m.textContent.includes("Oj,")))) throw new Error("retracted text still shown");
  await b.screenshot({ path: `${shots}/b-6i-retracted.png` });
  for (const pg of [a, b]) await pg.waitForFunction(() => !document.querySelector(".toast"), { timeout: 10000 });
  // GIPHY search: nothing is asked before typing; the warning is there; a tap saves into the collection.
  await a.click(".composer .gif-btn");
  await clickText(a, "Sök på GIPHY");
  await a.waitForSelector(".warn-note", { visible: true, timeout: 5000 });
  if (giphyRequests.length) throw new Error("GIPHY was asked before anything was typed");
  await a.type(".gif-body input", "katt");
  await a.waitForFunction(() => document.querySelectorAll(".gif-body .gif-grid img[src^='blob:']").length === 3, { timeout: 10000 });
  await a.screenshot({ path: `${shots}/a-6g-giphy.png` });
  // The results have room, and the tiles do not overlap (rows once collapsed when the panel was short).
  const layout = await a.evaluate(() => {
    const boxes = [...document.querySelectorAll(".gif-body .gif-grid .gif-send")].map((e) => e.getBoundingClientRect());
    const overlap = boxes.some((p, i) => boxes.some((q, j) => i < j && p.left < q.right - 1 && q.left < p.right - 1 && p.top < q.bottom - 1 && q.top < p.bottom - 1));
    return { grid: document.querySelector(".gif-body .gif-grid").getBoundingClientRect().height, tile: boxes[0]?.height ?? 0, overlap };
  });
  if (layout.overlap || layout.grid < layout.tile || layout.tile < 40) throw new Error(`GIF results laid out badly: ${JSON.stringify(layout)}`);
  const before = await a.evaluate(() => document.querySelectorAll(".msg").length);
  await a.click(".gif-body .gif-grid .gif-send");
  await a.waitForSelector(".gif-body .gif-send.saved", { timeout: 10000 });
  const searches = giphyRequests.filter((r) => r.url.hostname === "api.giphy.com");
  if (searches.length !== 1 || searches[0].url.searchParams.get("q") !== "katt") throw new Error(`unexpected searches: ${searches.map((r) => r.url)}`);
  for (const r of giphyRequests) {
    if (r.headers.cookie || r.headers.referer) throw new Error(`cookie or referrer sent to GIPHY: ${r.url}`);
    if (r.url.hostname !== "api.giphy.com" && r.url.search) throw new Error(`tracking parameters kept: ${r.url}`);
  }
  await clickText(a, "Mina GIF:ar");
  await a.waitForFunction(() => document.querySelectorAll(".gif-body .gif-grid .gif img").length === 2, { timeout: 10000 });
  if ((await a.evaluate(() => document.querySelectorAll(".msg").length)) !== before) throw new Error("saving from GIPHY sent something");
  await a.keyboard.press("Escape");
  for (const pg of [a, b]) await pg.waitForFunction(() => !document.querySelector(".toast"), { timeout: 10000 });
  await a.screenshot({ path: `${shots}/a-6-chat.png` });
  await b.screenshot({ path: `${shots}/b-6-chat.png` });
  await clickText(b, "Säkerhetskod");
  await b.waitForFunction(() => /\d{4}/.test(document.querySelector("dialog .code")?.textContent ?? ""), { timeout: 20000 });
  await b.screenshot({ path: `${shots}/b-7-safety.png` });
  const codeB = await b.$eval("dialog .code", (e) => e.textContent);
  await clickText(a, "Säkerhetskod");
  await a.waitForFunction(() => /\d{4}/.test(document.querySelector("dialog .code")?.textContent ?? ""), { timeout: 20000 });
  const codeA = await a.$eval("dialog .code", (e) => e.textContent);
  console.log("safety codes equal:", codeA === codeB);
  // Retention: chosen in the contact menu, shown in the conversation's title.
  await a.keyboard.press("Escape");
  await a.click('.topbar [aria-label="Fler val"]');
  await a.waitForSelector("dialog #retention", { timeout: 5000 });
  await a.select("dialog #retention", String(7 * 86400));
  await a.waitForFunction(() => document.querySelector(".topbar .title")?.textContent.includes("raderas efter 1 vecka"), { timeout: 5000 });
  await a.screenshot({ path: `${shots}/a-7-retention.png` });
  await a.keyboard.press("Escape");
  // A long history: the newest messages are drawn first, older ones as the reader scrolls up, and what is on the
  // screen stays in place while they come.
  for (let i = 1; i <= 60; i++) {
    await a.type(".composer textarea", `Historik ${i}`);
    await a.keyboard.press("Enter");
  }
  await b.waitForFunction(() => [...document.querySelectorAll(".msg")].some((m) => m.textContent.includes("Historik 60")), { timeout: 60000 });
  await a.waitForFunction(() => !document.querySelector(".msg.held"), { timeout: 30000 });
  await b.$eval(".side-list .conv.on", (e) => e.click()); // opened again: drawn from the start
  await b.waitForFunction(() => [...document.querySelectorAll(".msg")].some((m) => m.textContent.includes("Historik 60")), { timeout: 10000 });
  const drawn = await count(b, ".msg");
  if (drawn > 55 || !(await b.$(".thread > .older"))) throw new Error(`the whole history was drawn at once (${drawn} messages)`);
  if (await b.evaluate(() => [...document.querySelectorAll(".msg")].some((m) => m.textContent.includes("Andra raden.")))) throw new Error("an old message was drawn at once");
  for (let i = 0; i < 10 && (await b.$(".thread > .older")); i++) {
    const kept = await b.evaluate(() => {
      const s = document.querySelector(".main .scroll");
      s.scrollTop = 0;
      const m = document.querySelector(".thread .msg");
      window.__top = m;
      return m.getBoundingClientRect().top;
    });
    await b.waitForFunction(() => document.querySelector(".thread .msg") !== window.__top, { timeout: 10000 });
    await sleep(100);
    const moved = await b.evaluate((y) => Math.abs(window.__top.getBoundingClientRect().top - y), kept);
    if (!(moved < 2)) throw new Error(`the thread jumped by ${moved}px when older messages came`);
  }
  if (!(await b.evaluate(() => [...document.querySelectorAll(".msg")].some((m) => m.textContent.includes("Andra raden."))))) throw new Error("the oldest messages never came");
  await b.screenshot({ path: `${shots}/b-7d-older.png` });
  // Search: the field in the sidebar finds a contact by handle and an old message by its text (any case), with the
  // match marked; the hit opens the conversation with that message in view and marked. Escape brings the list back.
  // The field is hidden until the search button (or Ctrl+K) opens it, and Esc on an empty field hides it again.
  if (await a.$eval(".side-search", (e) => e.offsetParent !== null)) throw new Error("search field shown before it is opened");
  await a.click(".side-top .search-btn");
  await a.waitForFunction(() => document.activeElement === document.querySelector(".side-search input"), { timeout: 5000 });
  await a.keyboard.press("Escape");
  await a.waitForFunction(() => document.querySelector(".side-search").offsetParent === null, { timeout: 5000 });
  await a.keyboard.down("Control");
  await a.keyboard.press("k");
  await a.keyboard.up("Control");
  await a.waitForFunction(() => document.activeElement === document.querySelector(".side-search input"), { timeout: 5000 });
  await a.type(".side-search input", "BOB");
  await a.waitForFunction(() => document.querySelector(".side-list .conv:not(.hit) .name")?.textContent.startsWith("Bob"), { timeout: 5000 });
  await a.click(".side-search input", { clickCount: 3 });
  await a.type(".side-search input", "andra RAD");
  await a.waitForFunction(() => document.querySelectorAll(".side-list .conv.hit").length === 1 && document.querySelector(".side-list .conv.hit mark")?.textContent === "Andra rad", { timeout: 5000 });
  await a.screenshot({ path: `${shots}/a-7b-search.png` });
  await a.evaluate(() => { const s = document.querySelector(".main .scroll"); s.scrollTop = s.scrollHeight; });
  await a.click(".side-list .conv.hit");
  await a.waitForFunction(() => {
    const m = document.querySelector(".msg.found");
    if (!m || !m.textContent.includes("Andra raden.")) return false;
    const r = m.getBoundingClientRect(), s = document.querySelector(".main .scroll").getBoundingClientRect();
    return r.top >= s.top && r.bottom <= s.bottom;
  }, { timeout: 5000 });
  await a.screenshot({ path: `${shots}/a-7c-search-jump.png` });
  await a.focus(".side-search input");
  await a.keyboard.press("Escape");
  await a.waitForFunction(() => !document.querySelector(".side-list .conv.hit") && document.querySelector(".side-search input").value === "", { timeout: 5000 });
  await a.type(".side-search input", "finns inte någonstans");
  await a.waitForSelector(".side-list .search-none", { timeout: 5000 });
  await a.keyboard.press("Escape");
  await a.keyboard.press("Escape");
  await a.waitForFunction(() => document.querySelector(".side-search").offsetParent === null, { timeout: 5000 });
  // The files view (DESIGN.md §13.9): every file of the conversations, pictures as tiles, other files as rows; the
  // viewer steps through the pictures; a file removed from this device stays as a message with "Hämta igen".
  await a.click(".side-top .files-btn");
  await a.waitForSelector(".fv-tile img[src]", { timeout: 20000 });
  await a.waitForFunction(() => [...document.querySelectorAll(".fv-row .fn")].some((e) => e.textContent === "icon.svg"), { timeout: 5000 });
  if (await a.$eval(".side-top .files-btn", (e) => e.getAttribute("aria-pressed")) !== "true") throw new Error("files button not marked");
  await a.screenshot({ path: `${shots}/a-8-files.png` });
  await a.click(".fv-tile img[src]");
  await a.waitForSelector("dialog.viewer.gallery .fv-stage img[src]", { timeout: 10000 });
  await a.screenshot({ path: `${shots}/a-8b-files-viewer.png` });
  await a.click("dialog.viewer .close");
  await a.waitForFunction(() => !document.querySelector("dialog.viewer"), { timeout: 5000 });
  await clickText(a, "Dokument", ".fv-tabs button");
  await a.waitForFunction(() => !document.querySelector(".fv-tile") && document.querySelector(".fv-row"), { timeout: 5000 });
  await clickText(a, "Välj", ".topbar button");
  await a.waitForSelector(".fv-row .fv-check", { timeout: 5000 });
  await a.click(".fv-row .fv-check");
  await a.waitForFunction(() => /1 fil vald/.test(document.querySelector(".fv-foot").textContent), { timeout: 5000 });
  await a.screenshot({ path: `${shots}/a-8c-files-select.png` });
  await clickText(a, "Ta bort från den här enheten", ".fv-foot button");
  await a.waitForSelector("dialog .btn.primary", { timeout: 5000 });
  await clickText(a, "Ta bort från den här enheten", "dialog button");
  await a.waitForFunction(() => [...document.querySelectorAll(".fv-row .fv-status")].some((e) => /borttagen från den här enheten/.test(e.textContent)), { timeout: 10000 });
  await a.waitForFunction(() => [...document.querySelectorAll(".fv-row button")].some((e) => e.textContent === "Hämta igen"), { timeout: 5000 });
  await a.screenshot({ path: `${shots}/a-8d-files-freed.png` });
  await clickText(a, "Alla", ".fv-tabs button"); // the choice is remembered: back to all for the steps after
  await a.click(".side-list .conv");
  await a.waitForSelector(".composer textarea", { timeout: 5000 });
  // Dark mode and narrow screen.
  await b.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await b.keyboard.press("Escape");
  await b.setViewport({ width: 400, height: 760 });
  await sleep(300);
  await b.screenshot({ path: `${shots}/b-8-dark-mobile.png` });
  // The conversation fits the window: the thread scrolls and the composer is on screen.
  const fit = await b.evaluate(() => {
    const c = document.querySelector(".composer")?.getBoundingClientRect();
    const s = document.querySelector(".main .scroll");
    return { composer: !!c && c.bottom <= innerHeight && c.top >= 0, scrolls: !!s && s.scrollHeight > s.clientHeight && getComputedStyle(s).overflowY === "auto" };
  });
  if (!fit.composer || !fit.scrolls) throw new Error(`conversation does not fit the window: ${JSON.stringify(fit)}`);
  // On a phone the start page is the list of conversations; back leads there from a conversation.
  await b.goBack();
  await b.waitForFunction(() => getComputedStyle(document.querySelector(".sidebar")).display !== "none" && getComputedStyle(document.querySelector(".main")).display === "none", { timeout: 5000 });
  await b.screenshot({ path: `${shots}/b-9-mobile-list.png` });
  // The files view on a phone: it covers the list like a conversation, and back leads to the list.
  await b.click(".side-top .files-btn");
  await b.waitForSelector(".fv-tile", { visible: true, timeout: 10000 });
  await sleep(500);
  await b.screenshot({ path: `${shots}/b-9b-mobile-files.png` });
  await b.goBack();
  await b.waitForFunction(() => getComputedStyle(document.querySelector(".main")).display === "none", { timeout: 5000 });
  // Headless Chrome has not been allowed to notify: the header shows a struck-through bell that says so.
  const bell = await b.$eval(".side-top .bell-off", (e) => ({ shown: !e.hidden && e.offsetWidth > 0, title: e.title }));
  if (!bell.shown || !bell.title.startsWith("Murmo kan inte skicka notiser.")) throw new Error(`no notification warning: ${JSON.stringify(bell)}`);
  await b.click(".side-top .new-btn");
  await b.waitForSelector("#new-handle", { visible: true, timeout: 5000 });
  await b.screenshot({ path: `${shots}/b-10-mobile-new.png` });
  await clickText(b, "Säkerhet och integritet i detalj");
  await b.waitForSelector("dialog .help", { timeout: 5000 });
  await b.screenshot({ path: `${shots}/b-11-help.png` });
  await b.keyboard.press("Escape");
  // A page that comes back from the background reconnects at once.
  await a.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await sleep(500);
  await a.waitForFunction(() => document.querySelector(".me .s")?.textContent.includes("Ansluten"), { timeout: 10000 });
  // Alice makes a paper key, loses her only browser, and comes back with it on a new one.
  await a.click('[aria-label="Konto och inställningar"]');
  await clickText(a, "Enheter");
  await a.waitForFunction(() => [...document.querySelectorAll("dialog button")].some((x) => x.textContent === "Skapa pappersnyckel"), { timeout: 10000 });
  await a.screenshot({ path: `${shots}/a-8-devices.png` });
  await clickText(a, "Skapa pappersnyckel");
  await a.waitForSelector("dialog input[type=password]", { timeout: 5000 });
  await a.type("dialog input[type=password]", "correct horse battery staple");
  await clickText(a, "Fortsätt");
  await a.waitForSelector("dialog pre.paperkey", { timeout: 60000 });
  await a.screenshot({ path: `${shots}/a-9-paperkey.png` });
  const paperKey = await a.$eval("dialog pre.paperkey", (e) => e.textContent);
  await a.click("dialog .check input");
  await clickText(a, "Aktivera pappersnyckeln");
  await a.waitForFunction(() => !document.querySelector("dialog"), { timeout: 10000 });
  const a2 = await page("alice2");
  await a2.type("form input[autocomplete=username]", aliceHandle);
  await a2.type("form input[type=password]", "correct horse battery staple");
  await a2.click("form button[type=submit]");
  await a2.waitForSelector(".code", { timeout: 60000 });
  await clickText(a2, "Jag har ingen annan enhet kvar");
  await a2.type("form.paper input", paperKey.toLowerCase());
  await a2.screenshot({ path: `${shots}/a2-1-link-paper.png`, fullPage: true });
  await clickText(a2, "Använd pappersnyckeln");
  await a2.waitForFunction(() => document.querySelector("dialog h2")?.textContent === "Välkommen tillbaka", { timeout: 30000 });
  await a2.screenshot({ path: `${shots}/a2-2-welcome-back.png` });
  if (codeA !== codeB) throw new Error("safety codes differ");
} catch (e) {
  console.log("FAILED", e.message, e.stack?.split("\n").find((l) => l.includes("ui-smoke")));
  process.exitCode = 1;
} finally {
  console.log(problems.join("\n") || "no console errors");
  if (problems.length) process.exitCode = 1;
  await browser.close();
}
