# Murmo Secure Messenger

A small web messenger with end-to-end encryption between browsers, **built on [rootcard](https://rootcard.org) for
identity**.

You need no phone number or e-mail address: you log in with a rootcard identity, one at the Murmo server's own
rootcard home, or at another home such as rootcard.org. rootcard gives the identity a verifiable log of keys, an
encrypted vault and a recovery card, and Murmo roots its device lists, and with them the end-to-end encryption, in
that log rather than in trust in the server. The server is one Rust binary that stores as little as possible.

> **Status: early.** Murmo 0.1 is a working first version built on rootcard 0.3.4 (pre-1.0, not externally reviewed).
> Neither has had a security review. Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) before trusting it with anything.
> Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## What it does

- **rootcard login.** Register here (the recovery card is shown and must be saved *before* the account is created),
  or log in with an identity from another rootcard home (`rootcard.org`). The password never leaves the browser.
- **No search.** You reach someone only with their exact identifier, `Alice#3F9C` (or `Alice#3F9C@rootcard.org`).
- **Message requests.** The first message is a request; nothing else from that sender appears until it is accepted.
  Decline and block are local decisions, so the server learns no social graph.
- **End-to-end encryption per device**, with signed device lists rooted in the rootcard log: a password alone cannot
  add a device; a new device must be approved on an existing one (compare the code on both screens).
- **Queued or delivered.** A sent message shows a ring while the server holds it for the recipient and a ring with a
  check once one of their devices has it. The receipt comes end-to-end encrypted from the recipient's device, only
  between accepted contacts; the server reports nothing.
- **Safety codes** to compare in person; device-list changes are gossiped inside messages and forks are refused.
- **Several devices.** Messages go to all your devices; a newly linked device receives the history from the device
  that approved it.
- **Files.** Files go live, encrypted, to connected devices through an in-memory relay. For devices that are away the
  server can keep the encrypted chunks until they are fetched (at most 14 days; the sender can turn this off, and so
  can the operator); otherwise the file is sent when both are connected. Images (PNG, JPEG, GIF, WebP) show inline.
  Your own devices can later fetch a file from each other.
- **Notifications** in the browser and the installed app (PWA), on by default once the browser's permission is given (and a setting per device): an empty Web Push wakes the browser,
  the notification says only "Nytt meddelande", and being woken does not make the device look connected.
- **Encrypted local storage** unlocked by the rootcard password: a secret in the rootcard vault unlocks each device's
  local data, but the E2E private keys never enter the vault (docs/DESIGN.md §8).
- **Calm interface** with light, dark and automatic themes; works on phones.

## What the server stores

rootcard data for its own identities (log, encrypted vault, profile), verified logs of connected identities from
other homes, device lists and current prekeys, ciphertext addressed to devices until it is delivered (at most
14 days), encrypted file chunks for devices that are away (same limit, can be turned off), and push endpoints of
devices that asked for notifications. No message history, no contact lists, no files, no access logs with addresses. Details:
[docs/DESIGN.md §11](docs/DESIGN.md).

## Run it

Requirements: Rust 1.95+, a modern browser (WebCrypto Ed25519 and X25519).

```sh
cargo run --release
# open http://127.0.0.1:8080
```

Configuration (environment):

| Variable | Default | Meaning |
|---|---|---|
| `MURMO_ORIGIN` | `http://127.0.0.1:8080` | public origin; must be `https://` except on loopback |
| `MURMO_BIND` | `127.0.0.1:8080` | listen address (put a TLS reverse proxy in front) |
| `MURMO_DB` | `murmo.sqlite` | SQLite database |
| `MURMO_HOST_KEY_FILE` | `murmo-host.key` | rootcard host key, created on first start (back it up, keep it secret) |
| `MURMO_CLIENT_DIR` | `client` | static client to serve (empty: none) |
| `MURMO_REALM` | `global` | rootcard realm for identities registered here |
| `MURMO_REMOTE_HOMES` | `https://rootcard.org` | other homes whose identities may log in (comma-separated origins, `*` for any https host, empty for none) |
| `MURMO_REALMS` | `global` | realms accepted from other homes |
| `MURMO_TRUST_PROXY` | `0` | proxies whose `X-Forwarded-For` is believed: `0` none, `1` loopback and private networks, or a list of addresses and CIDR ranges (`10.1.2.3,fd00::/8`) |
| `MURMO_FILE_QUEUE_MB` | `150` | encrypted file chunks kept per device that is away (`0`: files only go live) |
| `MURMO_FILE_QUEUE_TOTAL_MB` | `2048` | file chunks kept in total |
| `MURMO_FILE_QUEUE_SENDER_MB` | `50` | file chunks one account may queue for one device of another account |
| `MURMO_FILE_QUEUE_ACCOUNT_MB` | `300` | file chunks one account may queue in total |
| `MURMO_PUSH_HOSTS` | the push services of Chrome, Firefox, Safari, Edge | push-service hosts accepted for notifications (`*.` for subdomains, empty: no push) |
| `MURMO_PUSH_CONTACT` | `MURMO_ORIGIN` | contact sent to push services (`mailto:` or `https:` URL) |

Murmo was called mesg before. The old variable names (`MESG_…`) still work when the new ones are not set, and an
existing `mesg.sqlite` / `mesg-host.key` is used when the new default files do not exist yet.

The version shown in the app ("Säkerhet och integritet") is the commit the server was built from: `MURMO_COMMIT` or
`GITHUB_SHA` at build time, otherwise `git rev-parse HEAD`.

The `MURMO_ORIGIN` goes into users' signed rootcard logs as their home address: choose it once.

## Layout

```
server/        murmo-server (Rust): rootcard home (rootcard-host), device lists, link requests, WebSocket mailbox,
               live relay, remote homes, rate limits, security headers
client/        the web client: plain ES modules, no build step, no dependencies besides the vendored rootcard core
  js/protocol.js   device lists, prekeys, envelopes, signatures, codes, file chunks (pure, also runs in Node)
  js/core.js       the messenger engine (requests, sync, history, files)
  js/app.js        the interface
  vendor/rootcard  rootcard 0.3.4 from npm, unmodified (npm tarball SHA-256 433607bb…b1c92b)
docs/          DESIGN.md (protocol), THREAT_MODEL.md, PLAN.md
tests/         protocol tests, end-to-end test (two servers, real client engine), browser smoke test
```

## Tests

```sh
cargo test                    # server unit tests, incl. a device list made by the JS client
cargo build && npm ci && npm test        # protocol tests + end to end against two running servers
# Browser smoke test (headless Chrome, fails on any console error such as a CSP violation):
MURMO_ORIGIN=http://127.0.0.1:18100 MURMO_BIND=127.0.0.1:18100 MURMO_LIMIT_SCALE=10 cargo run &
CHROME=/path/to/chrome npm run test:ui
# Fuzzing (nightly, cargo install cargo-fuzz): json_body, http_text, ws_frame
cd fuzz && cargo +nightly fuzz run ws_frame
```

## License

MIT OR Apache-2.0.
