<p align="center">
  <img src="client/icon.svg" alt="" width="72" height="72">
</p>

<h1 align="center">Murmo Secure Messenger</h1>

<p align="center">
  End-to-end encrypted messaging in the browser, with no phone number and no e-mail address.<br>
  <strong><a href="https://murmo.org">Try the demo at murmo.org</a></strong> ·
  <a href="docs/DESIGN.md">Design</a> ·
  <a href="docs/THREAT_MODEL.md">Threat model</a> ·
  <a href="docs/HOSTING.md">Hosting</a> ·
  <a href="SECURITY.md">Security</a>
</p>

---

Murmo is a small web messenger. Messages are encrypted on your device, separately for each of the recipient's
devices, and only those devices can read them. Your identity is a [rootcard](https://rootcard.org) identity: you
reach someone only with their exact identifier (`Alice#3F9C`), and the device lists behind the encryption are rooted
in rootcard's verifiable key log rather than in trust in the server. The server is a single Rust binary that stores
as little as possible.

> **Status: early.** Murmo 0.2 builds on rootcard 0.3.5. Neither has had an external security review. Read the
> [threat model](docs/THREAT_MODEL.md) before trusting it with anything sensitive, and report vulnerabilities
> privately as described in [SECURITY.md](SECURITY.md).

## Features

- **Federated.** Anyone can run a server, private or open; people on different servers write to each other as
  `Name#TAG@server`. [murmo.org](https://murmo.org) is a demo server to try it on.
- **No phone number, no search.** Log in with a rootcard identity, created here or at another home such as
  rootcard.org. The password never leaves the browser.
- **Message requests.** A stranger's first message is a request; block and decline are local decisions.
- **Invite by link or QR code.** Send a link with your address, show its code, or print it; the person who opens it
  gets the form filled in, ready to send.
- **Several devices.** A new device is approved on an existing one (compare a code), and gets the history from it.
  A paper key replaces a lost last device.
- **Safety codes** to compare in person; changes to a contact's devices are detected and forks refused.
- **Files and images**, encrypted end to end, sent live or queued on the server for at most 14 days.
- **Edit, undo, delete for everyone**, reactions, emoji, GIFs and highlighted code blocks.
- **Installable app (PWA)** with notifications that reveal nothing but "New message".
- **German, English, Spanish and Swedish**, light and dark themes, works on phones.

The server keeps no message history, no contact lists and no access logs: only ciphertext waiting for delivery,
public device keys and what rootcard needs. Full list in [DESIGN.md §11](docs/DESIGN.md).

## Run your own server

With Docker: point a DNS name at the machine, set it in `deploy/.env`, and start Murmo with automatic TLS:

```sh
cd deploy && cp .env.example .env    # set MURMO_DOMAIN=chat.example.org
docker compose up -d                 # update: docker compose pull && docker compose up -d
```

Your server exchanges messages with other Murmo servers by default; make it private with `MURMO_FEDERATION=off` or a
list of servers. All settings, how to move an existing server into the container, and how to move to a new domain are
in [docs/HOSTING.md](docs/HOSTING.md).

Without Docker, each release has static archives for Linux (x86_64 and arm64) with a systemd service and SHA-256
sums: see [docs/HOSTING.md](docs/HOSTING.md#without-containers).

What changed in each release, and what operators have to do about it, is in [CHANGELOG.md](CHANGELOG.md).

### From source

Requirements: Rust 1.95+ and a modern browser.

```sh
git clone https://github.com/Hexagon/murmo.git
cd murmo
cargo run --release
# open http://127.0.0.1:8080
```

For a public server, put a TLS reverse proxy in front and set `MURMO_ORIGIN=https://your.domain` (choose it once: it
goes into users' signed identity logs).

## Development

The client is plain ES modules with no build step and no dependencies besides the vendored rootcard core and a QR
encoder: edit and reload. `client/vendor/rootcard` is rootcard 0.3.5 from npm, unmodified; `client/vendor/qrcode` is
qrcode-generator 2.0.4 from npm, unmodified (version and hashes in its README).

```
server/   the Rust server: rootcard home, device lists, WebSocket mailbox, file relay
client/   the web client (js/protocol.js protocol, js/core.js engine, js/app.js interface, js/lang/ texts)
docs/     DESIGN.md (protocol), THREAT_MODEL.md, HOSTING.md, PLAN.md
tests/    protocol, end-to-end and browser smoke tests
fuzz/     cargo-fuzz targets
```

```sh
cargo test                           # server tests
cargo build && npm ci && npm test    # protocol and end-to-end tests (Node 22+)
npm run test:ui                      # browser smoke test, see tests/ui-smoke.mjs for setup
cd fuzz && cargo +nightly fuzz run ws_frame   # fuzzing (also json_body, http_text)
```

Contributions are welcome: open an issue or a pull request. Security issues go through
[SECURITY.md](SECURITY.md), not public issues.

## License

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
