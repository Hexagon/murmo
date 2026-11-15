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

- [ ] **Separate limits for live transfer and the file queue.** Today one client constant (100 MiB) governs both.
      Advertise the queue's per-file and per-device limits in `/api/v1/info`, show before sending whether a file can be
      queued, and let live transfer go further once it no longer needs the whole file in memory (Phase 2).
- [ ] Signed, reproducible client release with published hashes; installable copy not served by the server
- [ ] History from contacts after every device is lost: a contact sends its copy of a conversation on request,
      shown as the contact's copy (`DESIGN.md` §7.1, option 3)

## Phase 2: protocol

- [ ] Double Ratchet per device pair (per-message forward secrecy, post-compromise security), keeping the envelope
      format versioned
- [ ] Hybrid post-quantum prekeys (X25519 + ML-KEM-768)
- [ ] Group conversations (sender keys first, MLS later)
- [ ] Resumable file transfers and transfers larger than 100 MiB (streaming from `File.slice` and to IndexedDB in
      chunks; the live limit can then exceed the queue's)

## Phase 3: beyond one server

- [x] Identities whose rootcard home is another host (logs fetched from allowlisted homes)
- [ ] Server-to-server delivery (contacts on other Murmo servers)

## Open questions

- Should acceptance of a request be enforced by the server (needs the social graph) or stay client-side (current)?
- How long should a pinned head be trusted without a message from that contact?
