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
async function page(name) {
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  await pg.setViewport({ width: 1280, height: 800 });
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
  await b.click(".conv");
  await sleep(500);
  await b.screenshot({ path: `${shots}/b-5-request.png` });
  await clickText(b, "Acceptera");
  await b.waitForSelector(".composer textarea", { timeout: 20000 });
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
  await b.waitForFunction(() => [...document.querySelectorAll(".msg .filecard .fs")].some((e) => /50000 × 50000/.test(e.textContent)), { timeout: 20000 });
  if ((await b.$$(".msg img.inline")).length !== 1) throw new Error("the oversized image was shown inline");
  if (!(await b.evaluate(() => window.__shownImg?.isConnected && window.__shownImg === document.querySelector(".msg img.inline")))) throw new Error("the picture was made again when the thread was drawn");
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
  await a.waitForSelector(".upload.held", { timeout: 5000 });
  await a.screenshot({ path: `${shots}/a-6h-undo.png` });
  await clickText(a, "Ångra");
  await a.waitForFunction(() => document.querySelector(".composer textarea").value === "Oj, fel" && !document.querySelector(".upload.held"), { timeout: 5000 });
  await sleep(6000);
  if ((await count(b, ".msg")) !== bobBefore) throw new Error("a text taken back with Ångra was sent");
  // Sent after all, then deleted for everyone: a placeholder on both sides.
  await a.keyboard.press("Enter");
  await b.waitForFunction((n) => document.querySelectorAll(".msg").length > n, { timeout: 20000 }, bobBefore);
  const own = await a.$$(".msg.out");
  const last = own[own.length - 1];
  await last.hover();
  await (await last.$(".more-btn")).click();
  await a.waitForSelector("dialog .btn.danger", { timeout: 5000 });
  await a.screenshot({ path: `${shots}/a-6i-delete-menu.png` });
  await clickText(a, "Ta bort för alla");
  await a.waitForFunction(() => [...document.querySelectorAll(".msg.retracted")].some((m) => m.textContent.includes("Du tog bort")), { timeout: 10000 });
  await b.waitForFunction(() => [...document.querySelectorAll(".msg.retracted")].some((m) => m.textContent.includes("tog bort ett meddelande")), { timeout: 20000 });
  if (await b.evaluate(() => [...document.querySelectorAll(".msg")].some((m) => m.textContent.includes("Oj, fel")))) throw new Error("retracted text still shown");
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
  await b.click(".side-top .icon-btn");
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
  console.log("FAILED", e.message);
  process.exitCode = 1;
} finally {
  console.log(problems.join("\n") || "no console errors");
  if (problems.length) process.exitCode = 1;
  await browser.close();
}
