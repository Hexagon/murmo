# mesg: backlog

The work queue from the review of mesg 0.1 (functions, interface, documentation, agent instructions, security).
[PLAN.md](PLAN.md) holds the phases; this file holds the concrete findings, in the order they should be done.

Every item was found by reading the code; none was reproduced as an attack or a failing run. Tick an item when it is
fixed, and update [DESIGN.md](DESIGN.md) and [THREAT_MODEL.md](THREAT_MODEL.md) in the same change when it touches a
promise made there.

Priorities: **P1** before any public deployment · **P2** dead ends and server hardening · **P3** documentation and
tooling · **P4** polish.

## P1: the client checks less than the threat model promises

- [ ] **S1. The account's own device list is not pinned.** `Messenger.list()` calls `checkPinned` only for other
      accounts (`client/js/core.js`). A server that has captured the password can sign a new entry 0 with the account
      key and serve it; the user's devices then fan out every message to the attacker's "device" and accept its
      `sync` and `history`. Contradicts T19. *Fix:* pin the own head like a contact's, require that the list extends
      it and that this device is present.
- [ ] **S2. Gossiped heads are not verified.** `handleMessage` only drops the cached list when a gossiped head
      differs; the list is then fetched again from the same server, with no check that it reaches the gossiped head.
      A server that hides an added or removed device is not caught. Contradicts T3. *Fix:* after a refetch, require
      that the gossiped head is in the fetched chain (or that the chain extends it); otherwise warn and stop sending.
- [ ] **S3. The file relay bypasses consent.** The server forwards and queues `relay` frames to any known device
      (`relay`, `queue_chunk` in `server/src/ws.rs`), and `onRelay` buffers chunks from anyone. Chunks of a file
      without a known `file` message are never acknowledged, so the server sends up to 150 MiB again at every
      connect for 14 days, and the device's file queue stays full. Contradicts G6; T29 says "a contact", but any
      account can do it. *Fix:* the client drops and acknowledges chunks from senders that are not accepted contacts
      or own devices, and chunks whose file stays unknown; consider a server-side cap per sender.
- [ ] **S4. The file queue stores the sender in the clear.** `relay_queue` has `sender` and `account` columns
      (`server/src/db.rs`), so who sent a file to whom is on disk for up to 14 days. Contradicts G5 and T9 ("no
      social graph", "sealed sender towards storage"). *Fix:* move the sender inside the encrypted payload, or
      document it as an accepted risk.
- [ ] **S5. Messages from a contact marked as forked are still accepted.** `peerTargets` refuses to send, but
      `handleMessage` does not look at `c.fork`, so messages signed by a device of the forked list are stored and
      shown. *Fix:* hold or drop them until the fork is resolved (see F1).

## P2: dead ends

- [ ] **F1. A contact that resets with the recovery card is locked for good.** A new instance has a new device list,
      which never extends the pinned one, so `checkPinned` sets `fork`; nothing clears it, `request()` resets
      `pinned` but not `fork`, and the interface offers no way out. DESIGN §4.1 says contacts "see that as a key
      change". *Decision needed.* Proposal: tell a new instance (verified through the rootcard log) apart from a
      fork of the same instance, and show it as a key change the user approves after comparing the safety code.
- [ ] **F2. The device list runs out.** `verify_list` refuses more than 32 entries and there is no compaction
      (`server/src/devices.rs`, `MAX_ENTRIES` in `client/js/protocol.js`). After 32 additions and removals an account
      can change its devices only by a recovery reset. *Fix:* a signed checkpoint entry, or a larger limit with a
      compaction rule.
- [ ] **F3. Logging out does not remove the device.** It stays in the list, still receives ciphertext and counts
      towards the limit of 8. `logout(forget)` in `client/js/app.js` is only ever called with `false`, so "forget
      this device" (delete the local data) cannot be reached. *Fix:* offer "log out and remove this device" (signs a
      `remove`, deletes local data) next to the plain logout.

## P2: server hardening

- [ ] **S6. Rate limits count a whole IPv6 address.** `Limiter::by_addr` uses the full address
      (`server/src/app.rs`); a /64 gives an attacker 2^64 keys, which defeats every per-address limit, including the
      one against guessing tags (T11). *Fix:* count IPv6 by /64 (or /56).
- [ ] **S7. The mailbox has no total limit.** 2 000 envelopes of up to 96 KiB per device, about 190 MiB per device,
      with no server-wide cap (the file queue has one). *Fix:* a total quota like `MESG_FILE_QUEUE_TOTAL_MB`.
- [ ] **S8. A removed device is cleaned up only in part.** `swap_device_list` deletes its prekeys and mailbox but not
      its queued file chunks or its push endpoint (`drop_devices` does both). *Fix:* use the same clean-up.
- [ ] **F4. No graceful shutdown on SIGTERM.** `main.rs` waits for Ctrl-C only, so systemd and Docker cut
      connections hard. *Fix:* also wait for `SIGTERM`.
- [ ] **S9. CI gaps.** The browser smoke test does not run in CI (it is what catches CSP violations; also in PLAN
      phase 1), actions are pinned by tag instead of commit, and no dependency audit runs (`cargo audit`,
      `npm audit`).

## P3: documentation

- [ ] **D1. `MESG_LOG` does not exist.** DESIGN §11 refers to it; the code has no such setting.
- [ ] **D2. Envelope size.** DESIGN §10 says 64 KiB; `MAX_ENVELOPE` in `server/src/ws.rs` is 96 KiB.
- [ ] **D3. "No files on the server" is no longer true.** DESIGN's introduction and principles 5 and 7, and "What the
      server stores" in the README (which contradicts itself in one paragraph), predate the file queue (§9).
- [ ] **D4. PLAN.md is stale.** "Phase 0 (this commit)"; push notifications, the file queue and receipts are not
      listed.
- [ ] **D5. Threat numbering is out of order** (T18 last, T19 after T17).
- [ ] **D6. Configuration tables differ.** The table in `server/src/main.rs` lacks the file-queue and push
      variables; the README lacks `MESG_LIMIT_SCALE` (which its test instructions use).
- [ ] **D7. No operator guide.** TLS reverse proxy, backup of the host key and the database, upgrades, what a lost
      host key means.
- [ ] **D8. No `SECURITY.md`** (how to report a vulnerability) and no changelog.
- [ ] **D9. The checksum of the vendored rootcard core is abbreviated** in the README (`433607bb…b1c92b`) and cannot
      be checked. Give it in full, with the command that reproduces it.
- [ ] **D10. Update the threat model** for S1–S5 as they are fixed or accepted (T3, T9, T19, T29, G5, G6).

## P3: agent instructions

- [ ] **A1. There are none.** Add a short `CLAUDE.md` (or `AGENTS.md`) with the rules that are easy to break here:
      no build step and no dependencies in the client; the vendored rootcard core is never edited; no `innerHTML`
      and no inline styles (CSP); `server/src/devices.rs` and `client/js/protocol.js` verify the same formats and
      change together; a protocol change updates DESIGN.md and THREAT_MODEL.md; the server stores nothing new
      without a row in DESIGN §11; how to run the three test suites, including the browser smoke test.

## P4: interface

- [ ] **U1. No confirmation** for "Ta bort" (device), "Ta bort konversationen" and "Blockera".
- [ ] **U2. Labels are not tied to their fields** (`label` next to `input` without `for`/`id`), and the tabs have
      `role="tablist"` without `role="tab"` and `aria-selected`.
- [ ] **U3. One language, hard-coded.** The interface is Swedish only, strings are spread over `app.js` and `sw.js`,
      and the recovery card mixes Swedish and English. Collect the strings and add English.
- [ ] **U4. The fork warning offers no action** (depends on F1).
- [ ] **U5. Unread marks are lost on reload** (kept in memory only).

## P4: functions

- [ ] **F5. Delete a single message**, and retention per conversation (the latter is in PLAN phase 1).
- [ ] **F6. Search in one's own local history.**
- [ ] **F7. Receipts from old clients.** A recipient running a client from before receipts sends none, so the ring
      stays until they reload. Goes away by itself; only worth handling if clients stay old for long.
