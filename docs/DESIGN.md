# mesg: design

mesg is a small web messenger with end-to-end encryption between browsers. Identity is a
[rootcard](https://github.com/rootcard/rootcard) identity hosted by the mesg server itself. The server is a simple Rust
program that stores as little as possible: identity data that rootcard needs, public device keys, and a mailbox of
ciphertext that is deleted as soon as it is delivered.

This document is the protocol and data model. Threats are in [THREAT_MODEL.md](THREAT_MODEL.md), phases in
[PLAN.md](PLAN.md). Labels such as `[LGN-1]` refer to the rootcard specification.

---

## 1. Principles

1. **The server is a blind relay.** It never sees plaintext, private keys, contact lists or message history. It knows
   which device a stored ciphertext is for, and for how long it may keep it.
2. **Trust flows from the recovery key.** rootcard's log says which account key is current. The account key starts the
   device list of an instance, and from then on only existing devices can add devices. A stolen password therefore
   cannot add a device (§4).
3. **No search.** A conversation starts with an exact identifier (`Alice#3F9C`). There is no directory, no username
   search and no contact discovery. Lookups are rate limited so tags cannot be brute-forced cheaply.
4. **Consent before conversation.** The first message to someone is a *message request*. Nothing else from that sender
   is shown until the recipient accepts (§6).
5. **History lives on devices.** The server keeps no history and no files. Devices of the same account keep each
   other in sync, and a newly linked device receives the history from the device that approved it (§7). Local data is
   encrypted at rest under a key that the rootcard password unlocks, without putting E2E keys in the vault (§8).
6. **Small, auditable code.** No build step in the client, no third-party script, a handful of Rust crates on the
   server. The rootcard JS core is vendored at a pinned version.
7. **Files go live.** A file goes only to devices connected when the transfer starts, through an in-memory relay; an
   account's own devices can fetch it from each other later (§9).

## 2. Components

```
 browser (client/)                      mesg-server (server/)                     browser
 ─────────────────                      ─────────────────────                     ───────
 rootcard login (vendored core) ──────► /id/…        rootcard home (rootcard-host) 
 device keys (WebCrypto, IndexedDB)     /api/v1/…    device lists, prekeys, link requests
 encrypted local history                /api/v1/ws   authenticated mailbox + push   ◄──── same
 E2E envelopes ───────────────────────► SQLite: identities, sessions, device lists,
                                                     prekeys, mailbox (ciphertext + TTL)
```

The server is one binary. `MESG_ORIGIN` (for example `https://mesg.example`) is its public origin; the rootcard base
URL is `MESG_ORIGIN/id`, and `/.well-known/rootcard` points there ([HST-23]).

## 3. Identity and login

An identity is a rootcard identity at **this server's own home** (`MESG_ORIGIN/id`) or at **another allowed home**,
such as rootcard.org (`MESG_REMOTE_HOMES`). The login screen asks where the identity lives: "this server", or a
domain the user types, which the client resolves with the host pointer `/.well-known/rootcard` ([HST-23]).

- **Register** (this server only): the browser makes the recovery key, the log, the vault and the profile, shows the
  **recovery card** and requires the user to save it, and only then posts the registration. The recovery key is
  erased from memory. Identities elsewhere are created at their own home (for example on rootcard.org).
- **Login** (any home, rootcard GETTING_STARTED §2.2): handle and password; the vault is fetched from the home with a
  lock proof and unlocked in the browser; the login is signed with the account key. The password never leaves the
  browser, and for another home the mesg server never sees the login at all.
- The unlocked account key stays in memory only while it is needed: to sign the genesis of a device list (§4.2) and
  to prove the identity when requesting a link (§4.3). It is overwritten afterwards.
- High-power actions (password reset, moving, rotation) are never done in mesg. Users use rootcard's key tool.

### 3.1 Identities from other homes

- After logging in at another home, the client asks the mesg server to **connect** the identity
  (`POST /api/v1/accounts/{account}/connect { home }`). The server fetches the log from that home, verifies it itself
  (`verify_log`: every event is signed by the recovery key), checks that the log names that home, and stores it. It
  refreshes the log every few minutes when the identity is used, never moves back to an older version and refuses
  forks ([VER-4]).
- The server contacts **only allowlisted homes** (origins in `MESG_REMOTE_HOMES`; `*` allows any public https host
  that is not an IP literal). Clients therefore cannot make the server fetch arbitrary addresses.
- Clients never rely on the server's copy: they fetch every contact's log from the contact's own home and verify it.
  The page's CSP allows connections to this server and to the allowed homes only.
- Proofs instead of sessions: a link request carries a rootcard **proof** by the account key (SPEC §14) for a
  single-use challenge from the mesg server, addressed to the mesg origin. That works for every home, since the mesg
  server cannot check another home's sessions.

## 4. Devices

Every browser that uses an account is a **device**. A device has:

- a **device key**: Ed25519, generated with WebCrypto as a non-extractable key and kept in IndexedDB;
- **signed prekeys**: X25519 keys, also non-extractable, signed by the device key and rotated (§5.2).

`device id = base64url(SHA-256(device public key)[0..16])`.

### 4.1 Device list

An account's devices form an append-only, hash-chained list bound to the current rootcard instance. Every entry is a
canonical JSON object (rootcard's canonical JSON, [CJ-9]):

```json
{
  "v": 1,
  "account": "<account id>",
  "instance": "ed25519:<account key of the instance>",
  "seq": 0,
  "prev": "<hash of entry seq-1>",            // absent at seq 0
  "op": "add",                                // "add" | "remove"
  "device": { "id": "<device id>", "key": "ed25519:<device key>", "label": "Firefox on laptop" },
  "time": 1763150000,
  "signer": "account",                        // "account" at seq 0, otherwise a device id
  "sig": "<base64url Ed25519 signature>"
}
```

- `sig` signs `frame("mesg/devices/v1", canonical(entry without sig))`.
- `hash(entry) = base64url(SHA-256(frame("mesg/devices/v1", canonical(entry))))`, signature included. The **head** of
  a list is the hash of its last entry.
- **Entry 0** is an `add`, signed by the instance's account key (`signer: "account"`).
- **Entry n > 0** is signed by a device that is present after entry n-1. A device may remove itself.
- The list is valid only if `instance` equals the account key of the **current** instance in the verified rootcard
  log. A new instance (reset, restore, move: all need the recovery key) invalidates the list, and the account starts a
  new one. Contacts see that as a key change made by the owner with the recovery card.
- At most 32 entries live per list in v0; at most 8 devices present.

The server verifies every appended entry against the stored rootcard log and refuses anything that does not extend the
stored list. Clients verify the whole list themselves and never trust the server's word.

### 4.2 The first device

After the first login of an instance, the list is empty. The browser creates its device key and posts entry 0, signed
with the account key. The server accepts entry 0 only while no list exists for the current instance.

### 4.3 Linking another device

A password alone is not enough to add a device:

1. The new browser logs in with the password and creates its device key and a prekey.
2. It posts a **link request** with a rootcard proof by the account key (§3.1): its device key, label, signed prekey
   and a random request id. The server keeps link requests in memory for 10 minutes and pushes them to the account's
   connected devices.
3. Both screens show the same **link code**: six groups of four digits derived from
   `SHA-256(frame("mesg/link-code/v1", canonical({account, device key, request id})))`.
4. On an existing device the user compares the code and approves. That device signs an `add` entry and posts it.
5. The approving device sends the new device its contacts and history as E2E messages (§7).

A password thief can create link requests, which the owner sees and can decline; the thief cannot complete one.

### 4.4 Removing a device

Any present device can sign a `remove` entry for any device, including itself ("log out everywhere else" removes the
others). Contacts stop encrypting to removed devices as soon as they see the new head (§6.3).

## 5. Encryption

### 5.1 Envelope

A message is encrypted separately to each recipient device (the recipient's devices and the sender's own other
devices: client fan-out). For one recipient device with signed prekey `SPK`:

```
e          = fresh X25519 key pair (non-extractable)
shared     = X25519(e, SPK)
key        = HKDF-SHA256(ikm = shared, salt = E ‖ SPK, info = "mesg/box/v1")  → AES-256-GCM key
aad        = canonical({ v: 1, to: <device id>, spk: <prekey id>, epk: "x25519:<E>" })
envelope   = { v: 1, to, spk, epk, n: <12 random bytes>, ct: AES-GCM(key, n, plaintext, aad) }
```

The server stores `envelope` as an opaque string addressed to `to`.

### 5.2 Signed prekeys

```json
{ "v": 1, "account": "…", "device": "<device id>", "id": "<8 random bytes, base64url>",
  "key": "x25519:<public>", "time": 1763150000, "sig": "…" }
```

`sig` signs `frame("mesg/prekey/v1", canonical(prekey without sig))` with the device key. A device publishes a new
prekey every 7 days and deletes prekey private keys 21 days after replacing them; mailbox entries expire after 14 days.
This gives **forward secrecy with a window of about three weeks**: once a prekey's private key is deleted, recorded
ciphertext to it cannot be decrypted even with the device. Per-message forward secrecy and post-compromise security
come with the Double Ratchet in phase 2 (PLAN.md).

### 5.3 Plaintext

```json
{
  "v": 1,
  "id": "<16 random bytes>",
  "kind": "request",              // "request" | "accept" | "text" | "file" | "sync" | "history" | "receipt"
  "from": { "account": "…", "device": "…" },
  "to":   { "account": "…", "device": "…" },
  "conv": "<account id of the other party>",
  "time": 1763150000,
  "heads": { "<account>": "<device list head>" },
  "body": { … },
  "sig": "…"
}
```

- `sig` signs `frame("mesg/message/v1", canonical(message without sig))` with the sender's device key. The signature is
  inside the encryption, so the stored envelope does not name the sender ("sealed sender" towards storage).
- The recipient checks: the envelope `to` is itself; `to` in the plaintext is itself; `from.device` is present in the
  sender's verified device list; the signature; and that the sender and `conv` make a conversation the recipient is
  part of. A message re-encrypted to someone else fails these checks.
- `heads` gossips the device-list heads the sender knows (its own and the recipient's). A recipient that sees a head
  it does not have fetches the list from the server; a head that does not extend the pinned list is a **fork** and
  the conversation is blocked with a warning. Contacts thereby act as witnesses for each other.

## 6. Conversations and message requests

### 6.1 Starting

A conversation starts only from an exact identifier `Name#TAG` (or `Name#TAG@host` to pick the home). The client asks
the mesg server (`GET /api/v1/lookup?handle=…`), which answers only for identities it knows: its own and identities
from other homes that have connected (§3.1). The full handle is required and lookups are rate limited. The client
then fetches and verifies the identity's log from its home, verifies the device list, pins the account id and the
head, and sends a `request` message with an optional short note (at most 500 characters).

### 6.2 Receiving

- A `request` from an unknown account goes to **Requests**, at most one per sender. Nothing else from that account is
  shown or stored until the user accepts.
- **Accept** sends `accept` and opens the conversation on both sides. **Decline** deletes it locally; **Block**
  remembers the account id and drops everything from it.
- Acceptance is a client-side decision. The server cannot tell requests from other messages, which is deliberate: it
  learns no social graph. Spam is limited by per-sender rate limits on the authenticated connection and by the
  per-device mailbox quota.

### 6.3 Safety code

Each conversation shows a **safety code**: twelve groups of four digits from
`SHA-256(frame("mesg/safety/v1", canonical(sorted [ {account, head}, {account, head} ])))`. Comparing it in person
proves that neither server nor anyone else sits in between. The code changes when either side adds or removes a device.

### 6.4 Receipts: queued or delivered

The interface shows a ring on a sent message while the server holds it for the recipient, and a ring with a check
once one of the recipient's devices has it.

- The server tells the sender nothing about delivery (it would have to remember who sent what). Instead the
  recipient's device answers with a `receipt` message, `body: { ids: [<message id>, …] }`, end-to-end encrypted to the
  sender's devices like any message, a short moment after it stored the messages (several ids per receipt, at most
  200). It is never marked `notify`.
- Receipts are sent **only to accepted contacts**: a request is not answered, so a stranger learns nothing about
  whether or when a device read its mailbox. When a request is accepted, the `accept` marks it (and its note) as
  delivered. A blocked or declined sender gets no receipts.
- A text is acknowledged when it is stored; a file when its content is complete and checked on the device.
- A receipt says *arrived on a device*, not *read*. A contact thereby learns when one of the user's devices was
  connected, which the live file transfer already shows (THREAT_MODEL T21). To the server a receipt is one more
  envelope in the other direction.

## 7. Multi-device history

- Every message is also encrypted to the sender's own other devices, with `kind` unchanged and `to` set to that
  device. Own devices store it as outgoing.
- Contact state (accepted, blocked, pinned heads) is sent to own devices as `sync` messages.
- When a device approves a new device (§4.3), it sends the full local history and contacts as `history` messages in
  chunks of at most 48 KiB of plaintext.
- There is no server-side backup. If every device is lost, the history is gone; that is the price of keeping nothing
  on the server.

## 8. Keys at rest: what rootcard holds and what it does not

No extra password. The rootcard password unlocks local encryption, but the **private E2E keys never enter the rootcard
vault**:

- The vault (private data `app.mesg.localkey`) holds one random 32-byte **local secret** per account, created at the
  first mesg login. The vault is synced through the server, so every device of the account can get it after a
  password login.
- Each device derives its **local key** `HKDF(local secret, salt = random per-device salt, info = "mesg/local/v1")` and
  imports it as a non-extractable AES-256-GCM key, **in memory only**. A second key from the same secret
  (`…/index`, HMAC-SHA-256) turns contact and conversation ids into opaque record keys, so the database files do not
  reveal who the user talks to.
- Everything a device stores is encrypted with its local key: the device key and prekey private keys (PKCS #8,
  re-imported as non-extractable keys after unlock), contacts, messages and files.

Why not keep the E2E keys in the vault so that they follow the account automatically?

- The password would then be enough to read every message. A password thief, or a server that captures the password
  from the page it serves and already holds the vault, could decrypt all recorded traffic offline. With the split
  above, the password is worth nothing without a device's disk, and a device's disk is worth nothing without the
  password.
- It would undo §4.3: whoever has the vault would *be* every device.

What is federated between devices is therefore **trust** (the signed device list) and **content** (history, contacts
and files, sent device to device, §7), never private keys.

"Remember me on this device" stores the derived local key as a non-extractable `CryptoKey` in IndexedDB. Then the disk
alone unlocks the device, which is the trade-off the user picks.

### 8.1 IndexedDB

Database `mesg-<account>`:

| Store | Contents |
|---|---|
| `meta` | device id, public keys, wrapped (encrypted) private keys, optional remembered local key |
| `contacts` | encrypted contact records: handle, pinned device list, state (requested, accepted, blocked) |
| `messages` | encrypted messages, indexed by conversation and time |
| `files` | encrypted file contents, by file id |

**Retention per conversation.** A contact record can carry `retention` (seconds; 0 or absent: keep). Messages of
that conversation sent before *now − retention* are deleted from IndexedDB together with their files: when the
setting changes, every minute while the app runs, and at start. A message that is already older when it arrives (from
the mailbox or in a history hand-over) is not stored. The setting is synced to the account's own devices (`sync` with
`{ contact: { account, retention } }`) and travels with the contact records in a history hand-over. It applies only
to this account's devices: the other party decides about their copies, and nothing is sent to them.

## 9. Files

Files go live between connected devices. For devices that are not connected the server may keep the encrypted
chunks (the *file queue*), like the mailbox keeps envelopes; the sender can turn that off, and the operator can turn
it off for the whole server (`MESG_FILE_QUEUE_MB=0`).

1. The sender picks a file (at most 100 MiB). It makes a random file key and file id, hashes the file (SHA-256), and
   asks the server which of the recipient's devices and its own other devices are **connected right now**
   (`presence`).
2. It sends a `file` message through the mailbox to all devices of both accounts, as usual: name, type, size, hash,
   chunk count and the file key. Devices that were offline learn that the file exists.
3. It streams the file to the **connected** devices only, over the live **relay** (`relay` frames): 48 KiB chunks,
   each encrypted with the file key (AES-256-GCM, nonce from the chunk index). The server forwards relay frames in
   memory and stores nothing; a device that is not connected simply does not get them.
   With the file queue, the sender first asks how many bytes the server can keep for each device that is away
   (`relay-space`), so that a file is queued whole or not at all, and sends the chunks with `store: true`: the server
   forwards them to connected devices and stores them for the others (per device ≤ 150 MiB, in total ≤ 2 GiB by
   default, at most 14 days). A device reads its queued chunks after its queued envelopes and acknowledges them
   (`relay-ack`) once the file is complete and checked, or found broken.
   Devices that got neither are recorded on the sender's message (`missed`) and offered the file again whenever the
   sender is connected and they are too (every minute and on reconnect, for 14 days). The interface shows a file that
   no device of the recipient has yet as *not sent yet*.
4. Receivers check every chunk and the final hash, store the file encrypted locally and show images inline
   (PNG, JPEG, GIF, WebP; never SVG). Relay chunks are accepted only from the account's own devices and from contacts
   in state accepted or outgoing; others are dropped (and, if they came from the file queue, acknowledged so the server
   deletes them). Once the file key is known, every chunk is decrypted on arrival and a chunk that fails is dropped
   instead of spoiling the file. The file name and type in a `file` message are cleaned on receipt: control and
   bidirectional-formatting characters and path separators are removed (so `photo‮gpj.exe` cannot pose as a JPEG),
   and a type that is not a plain `type/subtype` becomes `application/octet-stream`. Files are always saved as
   `application/octet-stream`; user text is shown in bidi-isolated elements.
5. **Later federation between one account's devices:** a device that has the metadata but not the content can ask its
   own connected devices (`file-req` over the relay). A device that has the file streams it back the same way. Only
   devices in the account's own verified device list are served.

Relay frames carry `{ k: "chunk", f, i, n, c }` or `{ k: "file-req", f }` as base64url canonical JSON. Chunks are
authenticated by the file key from the signed `file` message and the final hash, so the relay needs no extra signature.

## 10. Server API (v1)

All bodies are canonical JSON. Errors are `{ "error": "<code>" }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| any | `/id/v0/…` | rootcard | rootcard host protocol (HOST_PROTOCOL.md) |
| GET | `/.well-known/rootcard` | – | host pointer |
| GET | `/api/v1/info` | – | origin, own home, realms, allowed homes, `build` (changes when the served client changes; an open page then offers a reload) |
| GET | `/api/v1/lookup?handle=` | – | exact identifier → account and home (no search) |
| POST | `/api/v1/accounts/{account}/connect` | – | fetch and verify an identity from an allowed home |
| POST | `/api/v1/challenge` | – | single-use challenge for a rootcard proof |
| GET | `/api/v1/accounts/{account}/devices` | – | device list and current prekeys |
| POST | `/api/v1/accounts/{account}/devices` | signatures | append entries `{ entries: [...] }` |
| POST | `/api/v1/accounts/{account}/link` | rootcard proof | create a link request |
| GET | `/api/v1/ws` | device challenge | WebSocket: mailbox, push, prekeys |

WebSocket frames (JSON):

| Direction | Frame |
|---|---|
| server → client | `{ t: "challenge", nonce }` |
| client → server | `{ t: "auth", account, device, sig }` with `sig` over `frame("mesg/ws-auth/v1", canonical({account, device, nonce, origin}))` |
| server → client | `{ t: "ready" }` then queued `{ t: "msg", id, env }` frames |
| client → server | `{ t: "send", id, to: [{ device, env }] }` → `{ t: "sent", id }` |
| client → server | `{ t: "ack", ids: [...] }` (deletes) |
| client → server | `{ t: "prekey", prekey }` |
| client → server | `{ t: "presence", devices, ref }` → `{ t: "presence", online, ref }` |
| client → server | `{ t: "relay", to, data, ref }` → forwarded as `{ t: "relay", from, account, data }` to connected devices only; `{ t: "relay-missed", devices, ref }` for the rest |
| server → client | queued file chunks `{ t: "relay", id, from, account, data }`, a few at a time after the envelopes |
| client → server | `{ t: "relay", to, data, ref, store: true }`: as above, and chunks for devices that are not connected are queued |
| client → server | `{ t: "relay-space", devices, bytes, ref }` → `{ t: "relay-space", ok, ref }` (room in the file queue) |
| client → server | `{ t: "relay-ack", ids }` (deletes queued chunks) |
| client → server | `{ t: "push-sub", endpoint?, ref }` → `{ t: "ok", ref }`: set or remove this device's push endpoint |
| client → server | `{ t: "ping" }` → `{ t: "pong" }` (the client's heartbeat; browsers drop sockets of background pages silently) |
| server → client | `{ t: "link", request }`, `{ t: "devices", account, head }` |

Limits (v0): envelope ≤ 64 KiB, ≤ 24 recipients per send, ≤ 2 000 queued envelopes per device, mailbox TTL 14 days,
60 sends per minute per device, 20 lookups per minute and 5 link requests per hour per network address.

Rate limits count per IPv4 address and per IPv6 /64. Counters are keyed by a hash of the address under a random
secret in the database (HKDF-SHA-256, 128 bits), never by the address itself. Windows of ten minutes or more
(registration, link requests, vault fetches, `connect`) are saved every minute and on shutdown, so restarting the
server does not reset them; nothing older than an hour is kept.

Behind a reverse proxy, `X-Forwarded-For` is read only when the connection comes from a proxy listed in
`MESG_TRUST_PROXY` (`1`: loopback and private networks). The hops are read from the right, skipping trusted proxies;
the first other address is the client. Anything further left was written by the client and is ignored.

### 10.1 Notifications

A device is woken when something arrives while its page is frozen or closed, unless the user turns that off: the
setting is on by default and the client asks for the browser's notification permission at the first click after login. Its service worker subscribes
with the browser's push service (Web Push, VAPID key from `info.push_key`) and the page sends the endpoint URL
(`push-sub`). The server accepts endpoints only on the push services in `MESG_PUSH_HOSTS` (no requests to arbitrary
addresses).

The sender marks recipients that should be notified (`notify: true` per recipient in `send`) for requests, texts and
files to the other party; never for its own devices or for receipts. If such an envelope is still unacknowledged after
a few seconds, the server posts an **empty** message (no payload, no encryption needed) to the endpoint, at most one per
device per 10 seconds. The service worker has no keys and does not connect to the mailbox: it shows "Nytt meddelande"
and the page fetches and decrypts when the user opens it. So a wake-up does not make the device look connected, and the
push service learns only that this browser got a wake-up from this server at that time. An endpoint that the push
service reports as gone (404/410) is deleted.

While the page runs in the background (not frozen), it shows the notification itself with the sender's handle, which
never leaves the device.

## 11. Data the server stores

| Data | Why | Retention |
|---|---|---|
| rootcard log, vault (encrypted), profile, sessions | rootcard home | while the account exists |
| logs of identities from other homes | verifying their devices | while the account is used here |
| device lists, current prekeys | others must encrypt to your devices | while the account exists |
| envelopes | delivery | until acknowledged, at most 14 days |
| link requests | linking | memory only, 10 minutes |
| relay frames (file chunks) | live transfer | not stored when the recipient device is connected |
| queued file chunks (ciphertext) | files for devices that are away (sender's choice) | until acknowledged, at most 14 days |
| push endpoint per device | notifications (the user's choice) | until turned off, logged out, or reported gone |
| VAPID key | signing push requests | while the server exists |
| network addresses | rate limits | keyed hashes only; in memory, and for windows of 10 minutes or more in the database, at most an hour |

No access logs with addresses are written by default (`MESG_LOG=info` logs no addresses or account ids).
