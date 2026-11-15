# Murmo: threat model

What Murmo protects, against whom, and what it accepts. It builds on rootcard's threat model
(`docs/THREAT_MODEL.md` in rootcard), whose identifiers appear as `rootcard T13`. Protocol details are in
[DESIGN.md](DESIGN.md).

## 1. Goals

| # | Goal |
|---|---|
| G1 | **Confidential messages.** Only the devices of the two parties can read a message. |
| G2 | **Authentic messages.** A message shown as from Alice was written on one of Alice's current devices. |
| G3 | **Controlled devices.** Only the owner's existing devices (a paper key with the password counts as one), or after a reset the recovery key, can add a device. |
| G4 | **Detectable key changes.** A change of the other party's devices is visible, and a fork is refused. |
| G5 | **Minimal server data.** The server holds no plaintext, no history, no contact list and no social graph. |
| G6 | **Consent.** Nobody can make a message appear in a conversation without the recipient accepting a request. |
| G7 | **No enumeration.** Users cannot be found by search; an identifier must be known exactly. |
| G8 | **Bounded exposure in time.** Recorded ciphertext becomes undecryptable once the prekeys involved are deleted. |

Non-goals in v0: hiding who talks to whom from the server **at the time of sending** (it sees the authenticated
connection and the recipient devices), anonymity towards the server, protection of a device controlled by an attacker,
per-message forward secrecy and post-compromise security (phase 2), and availability against a server that refuses
service.

## 2. Actors

| # | Actor | Can |
|---|---|---|
| X1 | Network attacker | Read and modify traffic, but not break TLS |
| X2 | Other user | Register, send requests, guess identifiers, flood |
| X3 | Server operator or full server compromise | Everything stored, every connection, **serves the client code** |
| X4 | Password thief | One user's password |
| X5 | Device thief (offline) | A copy of a browser profile, without the user's OS session |
| X6 | Malicious script in the page (XSS, malicious extension) | Run code in the Murmo origin |
| X7 | Recovery-card thief | The recovery key |

## 3. Threats

| # | Threat | Actor | Mitigation | Remaining |
|---|---|---|---|---|
| T1 | Read messages on the server | X3 | E2E per device; server stores ciphertext only, deleted on delivery | Metadata at send time (T9) |
| T2 | Server substitutes a device key (MITM) | X3 | Device lists start from the account key named by the recovery-signed rootcard log; additions need an existing device signature; clients pin heads; safety codes | A user who never compares safety codes trusts the first list they saw (TOFU) |
| T3 | Server hides a newly added or removed device | X3 | Heads gossiped inside every message; a stale view is corrected by the next message | Until a message arrives, the sender may still encrypt to a removed device |
| T4 | Password thief adds a device | X4 | Link needs approval on an existing device (§4.3); entry 0 only when no list exists for the instance | Accounts that never created a device; a careless user approving a request they did not start (the code comparison is the defence) |
| T5 | Script in the page reads keys or plaintext | X6, X3 | Strict CSP, no third-party code, no inline script, plain-text rendering only, non-extractable keys | Code in the origin can use keys and read plaintext while it runs (accepted: web delivery, AR1) |
| T6 | Server serves a modified client | X3 | Reproducible static client; published hashes; option to run the client from a local copy | Accepted for the hosted client (AR1) |
| T7 | Forge or replay a message | X2, X3 | Ed25519 signature by the sender device inside AES-GCM; recipient device and conversation bound in the signature; message ids remembered | – |
| T8 | Forward a signed message to a third party | X2 | `to` and `conv` are signed; recipients check both | – |
| T9 | Server learns the social graph | X3 | No contact lists on the server; requests indistinguishable from messages; sealed sender towards storage | The live connection reveals sender device and recipient devices at send time |
| T10 | Spam and harassment | X2 | Message requests; one pending request per sender; block list; rate limits; mailbox quotas | A flood of new accounts, each sending one request (rate limits per address) |
| T11 | Enumerate users | X2 | No search; lookup needs the full handle; lookups rate limited per address | Tag brute force of a known username at the rate limit (rootcard AR7) |
| T12 | Offline reading of a stolen browser profile | X5 | All local data, private keys included, encrypted under a key derived from a secret in the rootcard vault; the derived key lives in memory only | "Remember me" stores the derived key on the device (user's choice); a weak password lets someone with the profile *and* the vault guess |
| T13 | Decrypt recorded traffic later with a stolen device | X3+X5 | Prekeys rotated weekly, private keys deleted after 21 days | Messages from the last three weeks; per-message forward secrecy in phase 2 |
| T14 | Recovery-card thief | X7 | Out of Murmo's hands: the thief can make a new instance, and a new device list | Contacts see a reset; rootcard AR3 |
| T15 | Malformed or huge input to the server | X2 | Size limits before parsing, rootcard's strict JSON reader, entry and device limits, per-connection limits | – |
| T16 | Unauthenticated mailbox access | X2 | WebSocket requires a fresh challenge signed by a device present in the list | – |
| T17 | Link-request spam to an account | X2 | Requires a fresh rootcard proof by the account key (the password), rate limited, at most 3 pending, kept 10 minutes | A password thief can annoy the owner (and is then visible) |
| T19 | Password thief (or server capturing it) reads messages | X4, X3 | E2E private keys are never in the vault; the vault only holds the local secret, useless without a device's disk | A server serving modified code can read what the page shows (AR1) |
| T20 | Server stores or inspects files | X3 | Chunks encrypted with a per-file key that only the signed `file` message carries; live relay frames are never written to disk; the file queue (for devices that are away) holds ciphertext only, until acknowledged or 14 days, and can be turned off by the sender and the operator | Chunk sizes and timing reveal approximate file size; a queued file's ciphertext is on disk until fetched |
| T21 | Presence probing: who is online | X2 | Presence answers only for device ids, which are public in device lists; rate limited | Anyone who knows an identifier can see when its devices are connected (accepted for live transfer) |
| T22 | Malicious image or file | X2 | Images decoded by the browser in `<img>` only (no SVG, no HTML), and only when the header gives at most 40 MP (decompression bombs); other files only downloaded on request; strict CSP; files stored and hashed in parts, never whole in memory; chunks before their `file` message limited per sender | Browser image-decoder bugs; an animated GIF's later frames are not checked |
| T23 | A client makes the server fetch internal addresses (SSRF) through `connect` | X2 | Only allowlisted home origins are contacted; `*` admits only https hosts with a domain name; no redirects, 10 s, 4 MiB | With `*`, a public name that resolves to an internal address (configure an allowlist instead) |
| T24 | A home (or the server) serves an old or forked log of a remote identity | X3, other home | Logs are self-certifying; the server keeps the newest it saw and refuses forks; clients fetch from the home themselves and pin device-list heads | A party that never saw the newer version (rootcard AR4) |
| T25 | Linking a device for an identity from another home without its password | X2 | Link requests need a fresh rootcard proof by the account key, verified against the identity's log; approval on an existing device is still required | – |
| T26 | The page leaks data to third parties | X6 | CSP `connect-src` lists only this server and the allowed homes (all of https with `*`); no emoji images (system-font text); GIF search only if the operator sets a GIPHY key, then only GIPHY's hosts are allowed, nothing is asked before the user types, and the panel warns that GIPHY sees the address and search terms (DESIGN.md §9.1–9.3) | With `*`, a script running in the page could reach any https host (AR1 already covers running script). With a GIPHY key, GIPHY learns the address, search terms and times of users who search (accepted: the user's choice, warned in the panel) |
| T27 | Push reveals activity | X3, push service | Pushes carry no payload; only messages to the other party are marked; at most one push per device per 10 s; needs the browser's notification permission and can be turned off per device | The push service (Google, Mozilla, Apple) learns when a browser is woken by this server; the server learns that a device asked for push |
| T28 | Push endpoints used to make the server send requests (SSRF) | X2 | Endpoints accepted only on configured push-service hosts (exact host or `*.` suffix, https), no redirects, 10 s | – |
| T29 | File queue used to fill the server's disk | X2 | Only devices in a verified list; quotas per device, per sender account and device, per sender account and in total; asked before sending; 14 days | Three accounts can fill one device's quota (150 MiB) and seven the server's, until the chunks are read or expire |
| T30 | Paper key stolen or guessed | X4, X3, X2 | The paper key's device key is derived from the paper (160 bits) *and* the local secret in the vault, which only the password unlocks: the paper alone or the vault alone adds nothing; it never has a prekey, so it reads nothing; replacing or removing it is one device-list change on any device | Paper and password together can add a device, like an existing device can (visible to the owner and to contacts as a new device) |
| T31 | Live relay used to flood a device or the server's bandwidth | X2 | Clients use chunks only from their own devices and contacts; 3 000 frames per minute per device; bytes per minute per sending device (384 MiB, once per recipient) and per sending account into one device (96 MiB); a refused frame counts nothing | Several accounts together can still send a connected device up to 96 MiB per minute each; the recipient can block the sender |
| T32 | A message taken back ("Ta bort för alla") stays readable | X2, X3 | Only the author can take a message back (the `retract` is signed and checked against the message's author); the recipient's devices delete text, file and reactions and keep a tombstone so that late copies are not stored again; "Ångra" holds a text for 5 s before it is encrypted, the only certain way; the interface says what deletion cannot do (DESIGN.md §6.6) | A recipient who has seen, copied or photographed it; a modified client or a device with an older client that ignores `retract`; the ciphertext in the server's mailbox until it is fetched (as for every message) |
| T33 | Taking back used to destroy evidence of abuse | X2 | A visible placeholder "… tog bort ett meddelande" is always left; only within 24 hours of sending | A modified client can claim an earlier sending time for the `retract` (times are the author's); a recipient who wants to keep evidence must save it before it is taken back |
| T34 | An edit changes what was said | X2 | Only the author, only text, only within 24 hours; "redigerat" is shown on both sides; the signature binds the edit to the author's device | Earlier versions are not kept, so a reader who did not see the first text cannot see what changed; a device with an older client keeps the first text |
| T35 | A disappearing message outlives its timer | X2 (the other party), X3, X5 | Timer and unread limit inside the encryption; a new kind that older clients drop rather than keep; the countdown, removal and a content-free tombstone (against a copy that comes again) on every device; deleted at start and on focus if the app was closed mid-countdown; never in a history hand-over; the server drops the envelope when the unread limit passes (`to[].ttl`); notifications say only "Försvinnande meddelande" (DESIGN.md §6.8) | The recipient can copy, photograph or keep the page open: it is a courtesy, not a guarantee. The server learns which envelopes are short-lived and roughly how long they may wait. A device that is off when the time is up removes the message when it next starts |
| T18 | Quantum adversary records traffic | future | – (X25519 and Ed25519 only) | Hybrid ML-KEM prekeys in a later phase |

## 4. Accepted risks

- **AR1: Web delivery.** Whoever serves the page can change it. The client is static, has no build step and no
  dependencies outside the vendored rootcard core, so it can be reviewed and pinned. A later phase adds a signed
  release and an installable copy that is not served by the Murmo server.
- **AR2: TOFU without comparison.** Users who never compare safety codes get protection only against later changes.
- **AR3: Metadata at send time.** The server sees which device sends to which devices when it happens. It does not
  store it.
- **AR4: Lost devices, lost history.** Without any device left, history is gone by design. A paper key (DESIGN.md §4.5)
  keeps the account and its device list, not the history (DESIGN.md §7.1).
