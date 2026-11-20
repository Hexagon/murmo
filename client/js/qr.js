// QR codes for invite links (docs/DESIGN.md §6.1). The vendored encoder (client/vendor/qrcode, unmodified) makes the
// modules; they are drawn here as one SVG path with the DOM, which the CSP allows: no markup strings, no data: URL.
// Always dark on light with the standard quiet zone of four modules, whatever the theme, so every camera reads it.

import qrcode from "../vendor/qrcode/qrcode.mjs";

/** The quiet zone around the code, in modules (ISO/IEC 18004). */
export const QUIET = 4;

/**
 * The modules of a QR code for `text` (ASCII, as a URL is): `{ size, dark(x, y) }`. Error correction M (15 %), the
 * smallest version it fits in. Throws for text too long for any version.
 */
export function modules(text) {
  const q = qrcode(0, "M");
  q.addData(text, "Byte");
  q.make();
  const size = q.getModuleCount();
  return { size, dark: (x, y) => q.isDark(y, x) };
}

/** An SVG path that fills the dark modules, offset by the quiet zone: runs of dark modules in a row are one rectangle. */
export function path(m) {
  const parts = [];
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.dark(x, y)) continue;
      let run = 1;
      while (x + run < m.size && m.dark(x + run, y)) run++;
      parts.push(`M${x + QUIET} ${y + QUIET}h${run}v1h-${run}z`);
      x += run - 1;
    }
  }
  return parts.join("");
}

/** An `<svg>` of the code for `text`, labelled `label` for screen readers. It scales to the box it is put in. */
export function svg(text, label) {
  const m = modules(text);
  const ns = "http://www.w3.org/2000/svg";
  const side = m.size + 2 * QUIET;
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", `0 0 ${side} ${side}`);
  s.setAttribute("class", "qr");
  s.setAttribute("role", "img");
  s.setAttribute("aria-label", label);
  s.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", String(side));
  bg.setAttribute("height", String(side));
  bg.setAttribute("fill", "#ffffff");
  const fg = document.createElementNS(ns, "path");
  fg.setAttribute("d", path(m));
  fg.setAttribute("fill", "#000000");
  s.append(bg, fg);
  return s;
}
