# Vendored: qrcode-generator

`qrcode.mjs` is `dist/qrcode.mjs` of [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 by
Kazuhiko Arase (MIT, see `LICENSE`), from npm, unmodified. It has no dependencies and does not touch the DOM; Murmo
uses only `qrcode(type, level)`, `addData`, `make`, `getModuleCount` and `isDark`, and draws the code itself as SVG
(`client/js/qr.js`).

- npm tarball: `qrcode-generator-2.0.4.tgz`, integrity
  `sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==`
- SHA-256 of `qrcode.mjs`: `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0`

To check: `npm pack qrcode-generator@2.0.4 && tar xzf qrcode-generator-2.0.4.tgz && cmp package/dist/qrcode.mjs qrcode.mjs`.
