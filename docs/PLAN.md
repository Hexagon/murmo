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

Open, in order of priority:

- [ ] **Bounded memory for incoming files.** Chunks that arrive before their `file` message are buffered without a
      byte limit (only 64 such files, swept after 10 minutes), and assembly holds the file about three times
      (chunks, plaintext parts, joined copy) before one large IndexedDB write: a 100 MiB file can exhaust a phone.
      Cap buffered bytes per sender, store chunks in IndexedDB as they arrive and hash incrementally.
- [ ] **Image decompression bombs.** Inline images are limited by byte size only (25 MiB); a small PNG/WebP with huge
      dimensions can freeze or crash the tab. Check dimensions (`createImageBitmap` in a worker, or the header)
      before showing inline; above ~40 MP offer only "Spara".
- [ ] Rate limit relay bytes, not only frames (3000 frames/min ≈ 190 MiB/min per device into one recipient).
- [ ] **Separate limits for live transfer and the file queue.** Today one client constant (100 MiB) governs both.
      Advertise the queue's per-file and per-device limits in `/api/v1/info`, show before sending whether a file can be
      queued, and let live transfer go further once it no longer needs the whole file in memory (Phase 2).
- [ ] Signed, reproducible client release with published hashes; installable copy not served by the server

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
