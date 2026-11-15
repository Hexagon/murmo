// Browser smoke test of the real UI with two users in headless Chrome (puppeteer-core, no browser download).
//
//   MESG_ORIGIN=http://127.0.0.1:18100 MESG_BIND=127.0.0.1:18100 MESG_DB=/tmp/ui.sqlite MESG_HOST_KEY_FILE=/tmp/ui.key \
//     MESG_LIMIT_SCALE=10 cargo run &
//   CHROME=/usr/bin/google-chrome node tests/ui-smoke.mjs   (screenshots in $SHOTS, default /tmp/mesg-shots)
//
// It fails on any console error or warning, so CSP violations show up here.

import puppeteer from "puppeteer-core";
const BASE = process.env.MESG_URL ?? "http://127.0.0.1:18100/";
const shots = process.env.SHOTS ?? "/tmp/mesg-shots";
(await import("node:fs")).mkdirSync(shots, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const problems = [];
async function page(name) {
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  await pg.setViewport({ width: 1280, height: 800 });
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
  await b.waitForSelector(".msg img.inline", { timeout: 20000 });
  await sleep(1000);
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
  if (codeA !== codeB) throw new Error("safety codes differ");
} catch (e) {
  console.log("FAILED", e.message);
  process.exitCode = 1;
} finally {
  console.log(problems.join("\n") || "no console errors");
  if (problems.length) process.exitCode = 1;
  await browser.close();
}
