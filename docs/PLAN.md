# Murmo: plan

## Phase 0: foundation (this commit)

- [x] Design, threat model, plan
- [x] Rust server: rootcard home on SQLite, device lists, prekeys, link requests, WebSocket mailbox, rate limits,
      security headers, static client
- [x] Web client without build step: register (recovery card first), login, device setup and linking, message
      requests by exact identifier, 1:1 text, multi-device fan-out, history hand-over, encrypted local storage,
      safety codes, local encryption unlocked by the rootcard password (secret in the vault, E2E keys never there),
      live file transfer over an in-memory relay with automatic image display and later federation between own devices,
      login with identities from other rootcard homes (rootcard.org), light/dark/auto theme
- [x] Tests: Rust unit tests (device lists, prekeys, a fixture made by the JS client), protocol tests in Node, an
      end-to-end test against two running servers (one playing rootcard.org) with the real client engine, and a
      browser smoke test in headless Chrome that fails on any console error (CSP)

## Phase 1: hardening

- [x] Retention settings per conversation in the UI (own devices only, synced between them)
- [x] Relay chunks only from own devices and contacts; chunks checked on arrival; file names and types sanitized;
      bidi isolation of message text
- [x] Persistent rate limits behind a reverse proxy (`X-Forwarded-For` only from a trusted proxy)
- [x] Fuzz targets for the server parsers (`fuzz/`: JSON bodies and device lists, WebSocket frames, query/proxy/origin text; a minute each in CI)
- [x] Run the browser smoke test in CI
- [x] Per-sender quota in the file queue: per (sender account, device) and per sender account, checked by
      `relay-space` too (`MURMO_FILE_QUEUE_SENDER_MB`, `MURMO_FILE_QUEUE_ACCOUNT_MB`)
- [x] Version and commit shown under "Säkerhet och integritet" (`/api/v1/info`: `version`, `commit`, `source`)
- [x] Bounded memory for files: stored in IndexedDB in 48 KiB parts as they are read or arrive, hashed incrementally
      (pure-JS SHA-256), sent part by part; chunks before their `file` message wait in IndexedDB within 16 MiB per
      sender account and 64 MiB in all (`DESIGN.md` §8.1, §9)
- [x] Image decompression bombs: dimensions read from the PNG/GIF/JPEG/WebP header before an image is decoded;
      above 40 MP, or unreadable, it is shown as a file card with "Spara"
- [x] Paper key: a device on paper that, with the password, approves a new device when no other is left
      (`DESIGN.md` §4.5); a request from an accepted contact is answered with `accept`
- [x] Relay limited in bytes, not only frames: 384 MiB/min per sending device (once per recipient device) and
      96 MiB/min per sending account into one device; announced in `ready`, and the client paces transfers below them

Open, in order of priority:

- [x] **Separate limits for live transfer and the file queue.** The queue's per-file and per-device limits are
      advertised in `/api/v1/info` (`file_queue_limits`, `DESIGN.md` §9) and shown before sending; live transfer
      takes files up to 1 GiB (`MAX_FILE`), since files are read, stored and sent part by part. Files over 100 MiB
      are saved part by part where the browser allows it (`showSaveFilePicker`) and not shown inline (`DESIGN.md` §8.1)
- [x] Files over 50 MiB wait for the recipient: nothing is pushed or queued, and the recipient takes the file on the
      device of their choice, live from the sending device (`ask`, `DESIGN.md` §9)
- [x] Faster file relay: chunks as binary WebSocket frames (1.0× instead of 1.78× the file); a device that asks for
      a file grants the sender a budget of its own (`relay-grant`); queued chunks have a budget of their own; the
      file queue counts a file's real size (`DESIGN.md` §10.2, §13.8)
- [x] Code in messages: inline code and fenced blocks with colours for common languages, nothing else of Markdown
      (`DESIGN.md` §6.10)
- [x] Files view: every shared file in one place, by month and kind, with filters, a viewer with previous and next,
      detailed transfer progress, and removing files from one device to free room (`DESIGN.md` §9.4)
- Moved to phase 2, in its order there: signed, reproducible client release (items 3 and 8); history from
  contacts after every device is lost (item 7)

## Review 2026-11: improvement areas

A read-only review of five areas (documentation, error handling, security, federation, GUI and usability), checked
against the code at 0.2. Ordered by priority; within a priority, by area. Each item names where to start.

### P0: integrity and lost messages (before the next release)

- [x] **Pin the account's own device list.** `checkPinned` runs only for other accounts (`core.js:402`); a server can
      serve an older, validly signed own list that still holds a removed (stolen) device, which then gets a copy of every
      message and can push `history`/`sync`/`names`. Keep `{head, length}` for the own list in the encrypted store,
      refuse lists that do not extend it or that lack this device (T3, G1, G3)
- [x] **A fork must also stop receiving.** A list that fails `extendsPinned` is still cached (`core.js:400`) and
      incoming messages never check `c.fork`; only sending is blocked. Do not cache a forked list, verify against the
      pinned one, quarantine messages from a forked account (G2, T24)
- [x] **Do not ack envelopes on temporary failures.** `handleEnvelope` (`core.js:888-902`) acks when a device-list
      lookup fails on the network, and `finally` acks when `handleMessage` throws (IndexedDB quota). Ack only final
      results (bad decryption or signature, not for this device); leave the rest for the next connection
- [x] **SSRF to internal hosts.** `public_origin` (`federation.rs:199`) and `any_home` (`remote.rs:33`) refuse only
      what `Ipv4Addr` parses; `127.1`, `10.1`, `0x7f.0.0.1`, `localhost.` pass and resolve internally, and
      `/federation/deliver` fetches `{from}/api/v1/info` before any signature check. Resolve and refuse private,
      loopback and link-local addresses (or pin the checked IP); require a host name with a letter (T23, T40)
- [x] **Unthrottled key refetch.** A bad signature always forces a fresh fetch (`federation.rs:395-399`), failed
      fetches are not cached (`:281`), each takes up to 10 s on the shared blocking pool, at 1200 req/min per address.
      Negative cache, at most one forced refetch per origin a minute, a low per-address budget for failed verifications

### P1: abuse resistance and delivery

- [x] **Undelivered messages are invisible.** The client ignores `sent.failed` (`net.js:326`); federation tries a
      server once for 10 s and reports everything as failed (`federation.rs:437-452`), servers one after another.
      Client outbox with retry and a "not delivered" mark; server-side federation outbox with backoff; deliver to
      servers in parallel
- [x] **Mailbox flooding.** `MAX_QUEUE` (2000 per device, `ws.rs:25`) is shared by all senders; a local device fills an
      offline victim in about 2 min, a remote server in about 3.5 min (600/min per device), for 14 days. Per-sender and
      per-origin shares, a smaller share for non-contacts
- [x] **Partial sends.** A bad envelope or rate limit for recipient N fails the whole frame after 1..N-1 were queued
      (`ws.rs:434-494`, `federation.rs:492-497`); a resend duplicates. Validate all first or report per device; record
      the outgoing message as pending before sending
- [x] **Block list is exact-string.** `MURMO_FEDERATION_BLOCK` compares origins verbatim (`federation.rs:214`) and
      `:443`, other ports and subdomains are distinct origins (each with its own `PER_SERVER` budget). Normalise origins
      and block by host and subdomains
- [x] **Remote relays claim any account.** `sender.account` in `/federation/relay` is trusted (`federation.rs:836-931`)
      and keys local budgets and file-queue quotas; a hostile server can exhaust a local user's. Key on `from` + account,
      refuse accounts homed here
- [x] **Unbounded federation caches.** `routes` and `lists` (`federation.rs:154-159, 624-644`, `ws.rs:461`) grow with
      ids named by clients and remote answers up to 4 MiB. Cap per account, cap prekeys, LRU
- [x] **Reset leaves old devices connected.** Stale devices are dropped but only `removed` are disconnected
      (`api.rs:476-490`)
- [x] **Prekey freshness.** `verifyPrekey` (`protocol.js:254`) ignores `time`; a server can serve an old prekey whose
      private key it obtained. Refuse prekeys older than rotation + keep, or older than one already seen (T13, G8)
- [x] **Client HTTP without timeout.** `api.js:25`; one hanging `list()` stalls the serial envelope queue. Add
      `AbortSignal.timeout` and map network errors to a readable `ApiError`
- [x] **Dead connections stay registered.** Pings without pong check (`ws.rs:259`): presence, push and live relay act
      on half-open sockets. Close after about two missed pongs

### P1: usability and accessibility

- [x] **Connection loss is nearly invisible.** Only small "Connecting…" text in the sidebar, hidden inside a
      conversation on mobile (`app.js:1453`); held messages look sent (`app.js:2552`). Topbar banner and a pending mark
- [x] **Destructive actions without confirmation.** "Delete the conversation" removes history on all devices
      (`app.js:3618`, `core.js:557,1039`); block and device removal (`app.js:3800`) too
- [x] **Sidebar header overflows** the conversation title on desktop (needs about 352 px of 280 px, `style.css:191`)
- [x] **Form fields without accessible names**: labels are siblings without `for` (`app.js:670-673, 715-717, 949, 3858`)
- [x] **Show storage and background errors.** The messenger's `error` events only reach `console.warn`
      (`app.js:1047`); quota exhaustion is silent

### P2: documentation and privacy statements

- [x] **Correct what other servers learn.** §14.5 and `federation.rs:8` say "never which account or device", but
      `/federation/relay` sends `sender: {account, device}` and `/federation/space` the account. Fix §14.5, AR5
- [x] **Declare the federation route map.** Local account → contacts' remote devices, 7 days in memory
      (`federation.rs:54,110,180`): missing from §11 stored data (and so the terms), and at odds with G5, T9, AR3.
      Declared in §11, §14.5, the terms (de/en/es/sv, dated 2026-11-20), G5, T9, AR3, AR5
- [x] **Threat model claims unbuilt protections**: T6 lists reproducible client and published hashes (still open above)
- [x] **Host key compromise** is not a threat entry; `retired_keys` is always empty (`lib.rs:358`), so no rotation.
      Now T47; rotation itself (a setting for retired keys, and what it means for receipts) is still open
- [ ] **Operator guide in HOSTING.md** (done by A4 and A6): backups and restore of the live SQLite file and `murmo-host.key`; reverse proxy
      (WebSocket upgrade, bodies up to 3 MiB, `MURMO_TRUST_PROXY`); service example, health, what is printed; upgrades;
      Unix only
- [x] Facts that disagree with the code: envelope limit is 96 KiB, not 64 (`DESIGN.md:790,1132`); `MURMO_LOG` does not
      exist (`DESIGN.md:916`); T13 window is up to 4 weeks, not 3
- [ ] API reference (§10) is missing the log and federation routes, `link-decline`, `remote-lookup`/`remote-devices`,
      `ready.remote`, and most `info` fields; README misses the `ws_binary` fuzz target and fmt/clippy in CI;
      `lib.rs` module docs miss 8 variables; the component diagram lacks federation, file queue and push
- [ ] English docs use Swedish UI labels ("Säkerhet och integritet"); split §12 table (T18 is now in order)

### P2: robustness and federation details

- [x] A refused login (`unknown_device`, `bad_signature`) reconnects forever, without jitter (`net.js:237-251`);
      unhandled rejection when `auth()` fails (`net.js:189-193`). Refusals for good are retried every few minutes
      and shown; a device wipes itself only when its signed list confirms the removal
- [x] One user can rate-limit the whole server at a remote one (lookups and `fresh` lists share one IP's budget,
      `ws.rs:541-545`); per-server budget on the sending side, dedupe `fresh`
- [x] Presence is open to any federated server at 6000 req/min (`federation.rs:952-973`); limit to contacts or lower.
      Lowered: 1 200 questions and 4 000 devices a minute per server, 120 a minute about one device
- [x] A declined contact comes back with a replayed `request` (`core.js:916-925`); require a newer `time`
- [x] Check that a remote lookup answers for the requested `Name#TAG` (`identity.js:149-152`); every lookup does
- [x] Log push failures and `fork` in `refresh_if_remote` (`push.rs:180-235`, `remote.rs:140-144`); scheduled pushes
      are lost on restart. Logged at most every 10 minutes per push service and hourly per fork; pushes due at a stop
      are sent after the restart
- [x] Poisoned mutexes disable the database and hub for good (`db.rs:180-184`, `app.rs:171`): recover with
      `into_inner` as `federation.rs` does (`Locked::locked` in `app.rs`, used for every server mutex)
- [x] Spec: §14.3 `req` lacks `kind`; "fetched again once" is unbounded; replay nonces are lost on restart (requests
      signed before the server started are refused as `stale`)
- [x] Federation tests: replay (also across a restart), stale time, wrong `to`/`kind`, a signature by another key,
      block-list variants, a peer that is down, spoofed relay account, mailbox flooding, IDN addresses
- [ ] Federation tests still missing: open mode (needs public addresses), key rotation of a peer, a slow peer

### P3: polish

- [ ] `aria-live` on all of `#app` (`index.html:80`); toasts and form errors without `role="status"`/`"alert"`
- [ ] Safety code button unnamed on mobile (`app.js:1534`, `style.css:637`); consider a "verified" state
- [ ] Contrast: focus ring 1.75:1 (`--focus`), `--faint` text 2.7–3:1 (`style.css:15,23,44`)
- [x] (A1) Mobile empty state hides "share your identifier" and the paper-key warning
- [ ] Dialogs without `aria-labelledby` (`app.js:217`), nested `main`, tablist without `role="tab"` (`app.js:578`)
- [ ] Recovery card screen has no back; registration never offers "remember"; toasts drawn under modal backdrops
- [ ] PWA: offline screen, maskable icon, manifest description in English; spinner ignores `prefers-reduced-motion`
- [ ] Per-account settings in plain `localStorage` (`app.js:299,307`), against T12

## Adoption: setup, updates and invites

Murmo works, but every new user starts alone and every new server starts with a Rust toolchain. Contacts are only
reachable by exact identifier, and the only way to pass one on is "Kopiera identifierare" (`app.js:233`). A server
needs Rust 1.95+, a build, a `client/` directory next to the working directory, and a hand-made TLS proxy. murmo.org is
a demo that may be wiped (`MURMO_DEMO`), so lasting use needs servers people can run. Items A1–A6 are ordered by
benefit for the work. They use no new protocol, and they run alongside phase 2 items 1–2. A5 does phase 2 item 3. A4
and A6 do the operator guide in review P2. A1 does the P3 item on the mobile empty state.

1. [x] **A1 Invite links** (S, client only). The largest effect: every user, nothing to deploy. Done, with one change:
   "Invite someone" always opens the dialog (with "Share…" in it where `navigator.share()` exists), so the QR code (A3)
   has a place on phones too
   - Format: `https://<MURMO_ORIGIN>/#add=<encodeURIComponent(Name#TAG@host)>`, with the full federated address
     (the same text `fullAddress()` copies). It goes in the fragment, so the server never sees whom a link points to,
     and nothing new is stored (§11 unchanged). No token, no expiry: the link carries an address, not trust
   - "Invite someone" is the main button of the welcome card (`renderWelcome`, `app.js:1724`) and of the mobile empty
     state, next to "Copy". It opens `navigator.share()` where the browser has it, otherwise a dialog with the link,
     "Copy link" and the QR code (A3). A suggested text in the four languages: "Write to me on Murmo: <link>"
   - Opening a link: the hash router (today only `#villkor`, `app.js:627`) reads `#add=`, keeps the address in
     `sessionStorage`, and takes it out of the address bar with `history.replaceState`
     - Logged out: login and register say "You opened a link to write to Alice#3F9C@host". They never say "Alice
       invited you", because the link is not signed and anyone can make one. The address is shown exactly, as text and
       bidi-isolated, as in requests. Registration does not change; after it, go on as below
     - Logged in: an existing contact opens its conversation. Otherwise the new-conversation form is filled in, with
       the note "Hi, it's <my name>" ready to edit. **Nothing is sent without a tap**: a link must not make a request
       on someone's behalf
     - A user whose account is on another server (or an iOS user whose installed app keeps its storage apart from
       Safari) gets "Have an account elsewhere? Copy the address" to paste where they use Murmo
   - Tests: `tests/ui-smoke.mjs` opens an `#add=` link logged out, registers, and checks the filled-in form;
     logged in with an existing contact; a link to an invalid or self address; the fragment is gone afterwards
   - Docs: a paragraph in DESIGN §6.1 (format, no server involvement, no trust conveyed). THREAT_MODEL: links are
     attacker-made input (lookalike names, a fake "from"); the request flow and the safety code still decide.
     README features: "Invite by link or QR code"
2. [ ] **A2 Container image and a compose file with automatic TLS** (S). Running a server becomes three steps:
   point DNS, set the domain, `docker compose up -d`. Operators bring their whole group, so this is worth more than
   another feature
   - `Dockerfile` in the repo root: a multi-stage build (`rust:1.95` → distroless, non-root), the client at
     `/app/client`, data in the volume `/data` (`MURMO_DB=/data/murmo.sqlite`,
     `MURMO_HOST_KEY_FILE=/data/murmo-host.key`), `MURMO_BIND=0.0.0.0:8080`, and `MURMO_COMMIT` passed as a build
     argument so the app shows the commit
   - `deploy/compose.yaml` + `deploy/Caddyfile` + `deploy/.env.example` (`MURMO_DOMAIN=chat.example.org`).
     `MURMO_ORIGIN=https://${MURMO_DOMAIN}` and `MURMO_TRUST_PROXY=1`. Caddy gets the certificate and passes the
     WebSocket through. Bodies up to 3 MiB are allowed by default
   - Published by a release workflow on each `v*` tag: `ghcr.io/hexagon/murmo:0.2.3`, `:0.2`, `:latest`, amd64 and
     arm64 (a Raspberry Pi is a likely home server). The compose file pins `:0.2`: patches come with a pull, and a minor
     version waits until its notes are read
   - Updating: `docker compose pull && docker compose up -d`. Open pages already offer a reload when the build
     changes (`app.js:1257`)
   - Docs: README "Run your own server" leads with these three steps; "From source" stays below. HOSTING.md gets
     "Quick start" at the top
   - CI: build the image on pull requests (no push); start it and fetch `/api/v1/info` once
3. [x] **A3 QR code for the invite link** (S, client only). In person, in a group chat on another app, or on paper.
   Done with the vendored qrcode-generator 2.0.4; `tests/qr.test.mjs` reads the drawn codes back with jsQR (a dev
   dependency only), and the smoke test reads the code the page draws and checks the printed page
   - Encoder: vendor qrcode-generator (Kazuhiko Arase, MIT, one file, no dependencies), unmodified, in
     `client/vendor/qrcode/`, with version and hash noted, as for rootcard. Or write a small byte-mode encoder,
     ECC M, versions 1–10, if a review prefers less vendored code. Drawn as inline SVG with the DOM, which CSP allows,
     always dark on light with a quiet zone, whatever the theme
   - Shown in the invite dialog (A1), large enough to scan from a phone held at arm's length, with "Print" (a print
     stylesheet with only the code, the address and one line of text)
   - Scanning needs nothing in the app: the phone's camera opens the link, and A1 handles the rest. An in-app scanner
     (`BarcodeDetector`, not in Safari or Firefox) is left for later
   - README: "no dependencies besides the vendored rootcard core" becomes "…rootcard core and a QR encoder"
4. [ ] **A4 Safe updates and a readable first start** (S, server)
   - `murmo-server --version`; `murmo-server backup <file>` takes a consistent copy of the live database
     (`VACUUM INTO`) next to the key file. This is the backup half of the operator guide
   - Before a start that changes the schema (`db.rs:191-224` adds columns), write `<db>.before-<version>` with
     `VACUUM INTO`, keep the last two, and print that it did. An update then always has a way back
   - Print one summary at start: the address it listens on, the origin, database and key paths ("back up these two
     files"), federation mode, the client directory and its build. Add warnings: an `http://` origin outside
     loopback, a missing client directory, and `X-Forwarded-For` seen while `MURMO_TRUST_PROXY=0`
   - `MURMO_CLIENT_DIR` (default `client`) also looks next to the executable when the working directory has none, so
     the release archive (A5) runs from anywhere
   - No automatic update check: the server does not phone home. Operators watch GitHub releases (documented)
5. [ ] **A5 Release archives with checksums, and systemd** (S). For servers without containers. Does phase 2 item 3
   - The same workflow as A2 builds `murmo-<version>-x86_64-linux-musl.tar.gz` and `…-aarch64-…`: the binary,
     `client/`, the licences and `deploy/`. It also builds a client-only archive made reproducibly (`tar --sort=name
     --mtime=@0 --owner=0 --group=0 --numeric-owner`, `gzip -n`) and one `SHA256SUMS` for all of them, in the release
     notes. "Säkerhet och integritet" links them next to the commit
   - `deploy/murmo.service`: `DynamicUser`, `StateDirectory=murmo`, `EnvironmentFile=/etc/murmo/murmo.env`,
     `NoNewPrivileges`, `ProtectSystem=strict`. HOSTING.md gives the steps: download, `sha256sum -c`, extract to
     `/opt/murmo`, edit the env file, `systemctl enable --now murmo`. To update, replace `/opt/murmo` and restart
   - No `curl | sh` installer: the people this is for rightly distrust one, and the steps above are short
6. [ ] **A6 The rest of the documentation** (S). Mostly moving and shortening, with little new text
   - HOSTING.md in the order an operator needs it: Quick start (A2), Updating, Backups and restore (A4: stop or
     `backup`, both files, restore = put them back), Without containers (A5), Reverse proxy without Caddy (WebSocket
     upgrade, 3 MiB bodies, `MURMO_TRUST_PROXY`), then Configuration, Federation, Terms, Moving to a new domain
   - `CHANGELOG.md`, with an "Operators: anything to do?" line for every release. "Upgrading to the federation
     release" moves there from HOSTING.md
   - In the app's help: "Invite someone" (A1), in de/en/es/sv
   - Out of these items' scope: the P2 corrections of facts, which stay where they are

Later, not before A1–A6 have been used:

- **Signed invites** (M, protocol): the inviter's device signs `{address, invite id, expiry}` into the link. A first
  message that carries it skips the request queue, and the inviter can revoke unused ones. It needs a DESIGN section
  and federation support, so it comes only when people ask for it after using A1
- **QR verification**: scanning a contact's code compares the safety code (DESIGN §13), and combined with A3, adding
  and verifying become one step
- **In-app scanner** with `BarcodeDetector` where it exists
- **A list of public servers** at murmo.org that operators can ask to be on, linked from the demo notice

## Phase 2: next, in order

Ordered by benefit for the work, and so that what users notice is never held back by protocol work: a feature that is
ready goes out, whatever its place below. Items 1–2 run alongside the rest, and so does adoption (A1–A6 above), which
comes first among new work. Effort: S days, M one to three weeks,
L longer.

1. [x] **What the documents promise** (S, review P2): §14.5 and the route map in §11, T6 claiming unbuilt protections,
       host key compromise as a threat. Users and operators decide on these texts; they must be true first
2. [ ] **Accessibility and polish** (S each, review P3): direct benefit for every user, no protocol risk
3. [ ] **Published release hashes** (S, done by A5): every release a reproducible client archive and its SHA-256 list in the release
       notes; the "Säkerhet och integritet" view links them next to the commit it already shows. The first, cheap half
       of T6: anyone can check what a server serves
4. [ ] **Hybrid post-quantum envelope** (M, `DESIGN.md` §15.2): ML-KEM-768 next to X25519 in signed prekeys,
       envelope `v: 2`. Small change, nothing for the user to do, and it only protects traffic recorded after it ships,
       so it comes early. Downgrade is prevented by the existing rule never to go back to an older prekey
5. [ ] **Resumable file transfers** (M): a receiver that has some parts asks for the rest; saving large files part by
       part in browsers without `showSaveFilePicker` (a service worker that streams the download)
6. [ ] **Group conversations** (L): sender keys carried in the existing per-device envelopes, so groups do not wait for
       the Double Ratchet and get its protection later without a format change; a sender key ratchets forward per
       message and is replaced when a member or device leaves. MLS later (item 10)
7. [ ] **History from contacts** after every device is lost (M): a contact sends its copy of a conversation on request,
       shown as the contact's copy (`DESIGN.md` §7.1, option 3)
8. [ ] **Installable client not served by the server** (L): a packaged app (or extension) that runs only releases
       signed by a release key published in a rootcard log, and warns otherwise (`DESIGN.md` §13.7). Closes AR1, the
       largest remaining risk, and users get an app. Before the ratchet, because the ratchet protects little against
       a server while that server serves the code
9. [ ] **Double Ratchet per device pair** (L, `DESIGN.md` §15.3): per-message forward secrecy and post-compromise
       security, envelope `v: 3`, started with item 4's handshake, announced by `caps` in the signed prekey
10. [ ] **Later** (`DESIGN.md` §15.1 step C): one-time prekeys; a post-quantum step in the ratchet; MLS for groups;
        ML-DSA signatures, with rootcard

## Phase 3: beyond one server

- [x] Identities whose rootcard home is another host (logs fetched from allowlisted homes)
- [x] Server-to-server delivery (contacts on other Murmo servers): `Name#TAG@host`, signed deliveries, open, listed or
      no federation, terms for a federated service, murmo.org as a demo (`DESIGN.md` §14)
- [x] Files between servers (live, queued, presence, room in the queue), within the smaller of both servers' limits
      (`DESIGN.md` §14.6)

## Ideas, not decided

Kept in [DESIGN.md §13](DESIGN.md#13-ideas-not-decided) to be decided later: remote wipe, proofs of linked accounts,
social recovery of the paper key, QR verification, identity timeline, aliases, calm messaging, "what the server
knows about me", duress password, sealed sender, one-time secrets, shared objects, voice, on-device translation,
calls, a contact widget, alerts and bots (with a worked plan for an AI assistant as a contact), checking the served
client, what is left of the faster file relay (receiver batching, larger chunks, §13.8), and what is left of the files
view (stored thumbnails, keeping a file on one device only, §13.9).

## Open questions

- Should acceptance of a request be enforced by the server (needs the social graph) or stay client-side (current)?
- How long should a pinned head be trusted without a message from that contact?
