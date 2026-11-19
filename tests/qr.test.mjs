// QR codes for invite links (client/js/qr.js): what is drawn is read back by an independent decoder (jsQR), from the
// SVG path itself, with the quiet zone, for the lengths an invite link can have.

import { test } from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { modules, path, QUIET } from "../client/js/qr.js";

/** Fill a grid from the path's `M x y h n v1 h-n z` rectangles, and scale it to RGBA pixels (light everywhere else). */
function raster(d, side, scale = 4) {
  const grid = Array.from({ length: side }, () => new Uint8Array(side));
  for (const [, x, y, n] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) for (let i = 0; i < Number(n); i++) grid[Number(y)][Number(x) + i] = 1;
  const w = side * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) if (grid[Math.floor(y / scale)][Math.floor(x / scale)]) px.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  return { px, w, grid };
}

const links = [
  "https://murmo.org/#add=Al%233F9C",
  "https://chat.example.org/#add=Alice%233F9C%40chat.example.org",
  `https://xn--mrmo-1ra.example/#add=${encodeURIComponent(`${"a".repeat(32)}#3F9C-${"Z".repeat(48)}@${"sub.".repeat(20)}example.org`)}`,
];

for (const link of links) {
  test(`a code for a ${link.length}-character link reads back as the link`, () => {
    const m = modules(link);
    const side = m.size + 2 * QUIET;
    const { px, w, grid } = raster(path(m), side);
    // The path fills exactly the dark modules, and nothing in the quiet zone.
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const inside = x >= QUIET && y >= QUIET && x < QUIET + m.size && y < QUIET + m.size;
        assert.equal(grid[y][x], inside && m.dark(x - QUIET, y - QUIET) ? 1 : 0, `module ${x},${y}`);
      }
    }
    const read = jsQR(px, w, w, { inversionAttempts: "dontInvert" });
    assert.ok(read, "not decoded");
    assert.equal(read.data, link);
  });
}

test("a typical invite link fits a small version (scannable at arm's length)", () => {
  const m = modules("https://chat.example.org/#add=Alice%233F9C%40chat.example.org");
  assert.ok(m.size <= 37, `version too large: ${m.size} modules`); // version 5 or less
});
