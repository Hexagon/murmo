# mesg: plan

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

- [ ] Retention settings per conversation in the UI
- [ ] Signed, reproducible client release with published hashes; installable copy not served by the server
- [x] Persistent rate limits behind a reverse proxy (`X-Forwarded-For` only from a trusted proxy)
- [ ] Fuzz targets for the server parsers
- [ ] Run the browser smoke test in CI

## Phase 2: protocol

- [ ] Double Ratchet per device pair (per-message forward secrecy, post-compromise security), keeping the envelope
      format versioned
- [ ] Hybrid post-quantum prekeys (X25519 + ML-KEM-768)
- [ ] Group conversations (sender keys first, MLS later)
- [ ] Resumable file transfers and transfers larger than 100 MiB

## Phase 3: beyond one server

- [x] Identities whose rootcard home is another host (logs fetched from allowlisted homes)
- [ ] Server-to-server delivery (contacts on other mesg servers)

## Open questions

- Should acceptance of a request be enforced by the server (needs the social graph) or stay client-side (current)?
- How long should a pinned head be trusted without a message from that contact?
