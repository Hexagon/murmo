# Murmo Secure Messenger: design

Murmo is a small web messenger with end-to-end encryption between browsers. Identity is a
[rootcard](https://github.com/rootcard/rootcard) identity hosted by the Murmo server itself. The server is a simple Rust
program that stores as little as possible: identity data that rootcard needs, public device keys, and a mailbox of
ciphertext that is deleted as soon as it is delivered.

This document is the protocol and data model. Threats are in [THREAT_MODEL.md](THREAT_MODEL.md), phases in
[PLAN.md](PLAN.md). Labels such as `[LGN-1]` refer to the rootcard specification.

The project was called mesg before. Names that are part of signatures, key derivation or stored data keep that
name, so that existing devices, messages and local data stay valid: the protocol labels (`mesg/…/v1`), the vault
entry `app.mesg.localkey` and the IndexedDB databases (`mesg`, `mesg-<account>`).

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
 browser (client/)                      murmo-server (server/)                     browser
 ─────────────────                      ─────────────────────                     ───────
 rootcard login (vendored core) ──────► /id/…        rootcard home (rootcard-host) 
 device keys (WebCrypto, IndexedDB)     /api/v1/…    device lists, prekeys, link requests
 encrypted local history                /api/v1/ws   authenticated mailbox + push   ◄──── same
 E2E envelopes ───────────────────────► SQLite: identities, sessions, device lists,
                                                     prekeys, mailbox (ciphertext + TTL)
```

The server is one binary. `MURMO_ORIGIN` (for example `https://murmo.example`) is its public origin; the rootcard base
URL is `MURMO_ORIGIN/id`, and `/.well-known/rootcard` points there ([HST-23]).

## 3. Identity and login

An identity is a rootcard identity at **this server's own home** (`MURMO_ORIGIN/id`) or at **another allowed home**,
such as rootcard.org (`MURMO_REMOTE_HOMES`). The login screen asks where the identity lives: "this server", or a
domain the user types, which the client resolves with the host pointer `/.well-known/rootcard` ([HST-23]).

- **Register** (this server only): the browser makes the recovery key, the log, the vault and the profile, shows the
  **recovery card** and requires the user to save it, and only then posts the registration. The recovery key is
  erased from memory. Identities elsewhere are created at their own home (for example on rootcard.org).
- **Login** (any home, rootcard GETTING_STARTED §2.2): handle and password; the vault is fetched from the home with a
  lock proof and unlocked in the browser; the login is signed with the account key. The password never leaves the
  browser, and for another home the Murmo server never sees the login at all.
- The unlocked account key stays in memory only while it is needed: to sign the genesis of a device list (§4.2) and
  to prove the identity when requesting a link (§4.3). It is overwritten afterwards.
- High-power actions (password reset, moving, rotation) are never done in Murmo. Users use rootcard's key tool.

### 3.1 Identities from other homes

- After logging in at another home, the client asks the Murmo server to **connect** the identity
  (`POST /api/v1/accounts/{account}/connect { home }`). The server fetches the log from that home, verifies it itself
  (`verify_log`: every event is signed by the recovery key), checks that the log names that home, and stores it. It
  refreshes the log every few minutes when the identity is used, never moves back to an older version and refuses
  forks ([VER-4]).
- The server contacts **only allowlisted homes** (origins in `MURMO_REMOTE_HOMES`; `*` allows any public https host
  that is not an IP literal). Clients therefore cannot make the server fetch arbitrary addresses.
- Clients never rely on the server's copy: they fetch every contact's log from the contact's own home and verify it.
  The page's CSP allows connections to this server and to the allowed homes only.
- Proofs instead of sessions: a link request carries a rootcard **proof** by the account key (SPEC §14) for a
  single-use challenge from the Murmo server, addressed to the Murmo origin. That works for every home, since the Murmo
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

If no device is left (the only browser's data was cleared), nobody can approve. The client says so on the link screen
and when a request expires unanswered. With a **paper key** (§4.5) the user adds the new device on the spot; without
one, the way back is a new instance with the recovery card (§4.1), which starts a new list and loses the history (§7). Murmo does not do this itself (§3): for identities of this home it offers rootcard's
`keytool.html` (vendored, unmodified) as a download to open from disk; for identities of other homes it names the home.
While an account has a single device and no paper key, the start page and the device list say what losing it would
mean and offer to make a paper key.

### 4.4 Removing a device

Any present device can sign a `remove` entry for any device, including itself ("log out everywhere else" removes the
others). Contacts stop encrypting to removed devices as soon as they see the new head (§6.3).

### 4.5 Paper key

A paper key is a device that lives on paper: an entry in the device list like any other, whose private key is written
down instead of kept in a browser. It can approve one new device when no other device is left, without a new instance,
so the account, its device list and the trust contacts have pinned stay as they are.

- **Written form:** `MPK-` and nine groups of four Crockford base32 characters: 20 random bytes (160 bits) and a
  4-character checksum `base32(SHA-256(frame("murmo/paper-key/check/v1", paper)))[0..4]`. Typing is forgiven as for
  rootcard recovery keys (case, spaces, dashes, I/L/O).
- **Key:** `seed = HKDF-SHA256(ikm = paper, salt = local secret, info = frame("murmo/paper-key/v1", canonical({account})))`,
  an Ed25519 seed. The local secret is the one in the rootcard vault (§8), which only the password unlocks. **The paper
  alone is therefore worth nothing, and so is the password alone**: both are needed, and a server that holds the
  encrypted vault still needs the password. Seeds whose first byte is zero are drawn again ([CRY-9]).
- **In the list:** `add` of `{ id, key, label: "Pappersnyckel" }`, signed by the device that made it. The label is only
  for showing; a paper key never publishes a prekey, so nobody encrypts to it (senders skip devices without a prekey)
  and the server never queues anything for it. It counts as one of the 8 devices and is visible to contacts as a
  device, so the safety code changes when it is made or replaced.
- **Making one** (device list, or the single-device reminder): the user types the password, the client unlocks the
  vault again (no new login) to get the local secret, shows the key, and only after the user confirms it is saved
  appends `remove` of any earlier paper key and `add` of the new one in one change.
- **Using one** (link screen, "Jag har ingen annan enhet kvar"): after the password login the new browser has its
  device key, its prekey and the local secret. It derives the paper key's seed, checks that that device is present in
  the verified list, and signs the `add` of itself with it (`signer` = the paper key's device id). The server checks it
  as any entry (§4.1). The paper key stays valid; the client suggests removing the lost device and making a new key.
- What the paper key does **not** bring back: history and contacts (§7.1). Contacts who had accepted the user answer a
  new request from them with `accept` at once (§6.2), so conversations resume without a new acceptance.
- A paper key belongs to an instance: after a reset with the recovery card it is gone with the old list.

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
                                  // | "reaction" | "retract" | "edit" | "ephemeral" | "gifs" (own devices only)
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
the Murmo server (`GET /api/v1/lookup?handle=…`), which answers only for identities it knows: its own and identities
from other homes that have connected (§3.1). The full handle is required and lookups are rate limited. The client
then fetches and verifies the identity's log from its home, verifies the device list, pins the account id and the
head, and sends a `request` message with an optional short note (at most 500 characters).

### 6.2 Receiving

- A `request` from an unknown account goes to **Requests**, at most one per sender. Nothing else from that account is
  shown or stored until the user accepts.
- **Accept** sends `accept` and opens the conversation on both sides. A `request` from a contact that is already
  accepted means the sender has lost its data (a new device after a paper key, §4.5): it is answered with `accept` and
  changes nothing else. **Decline** deletes it locally; **Block**
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

### 6.5 Reactions

A reaction is a `reaction` message `{ id, e }` to the other party and the own other devices: `id` is a message of
that conversation (text or file), `e` one emoji (`""` takes the reaction back). Each account has at most one reaction
per message; the one with the latest message time wins, and a taken-back reaction is kept as `""` with its time so
that an older one arriving late does not come back. Reactions are stored on the message they belong to (§8.1), go
along with the history to a newly linked device, and are only taken from accepted contacts. They do not notify.

### 6.6 Taking messages back

End-to-end encryption means that what has reached a device is on that device: no protocol can take it back for
certain. Murmo therefore offers three things, and says in the interface what each can and cannot do.

- **Ångra (undo send).** A text waits 5 seconds before it is encrypted and sent. Meanwhile it is shown in the thread
  like a sent message, without a delivery mark (it is not on the server) and with an undo button where a sent
  message has its menu; undo removes it and puts the text back in the composer. It is then sent under the id it was
  shown with, so the message stays in place. This is the only way to be sure that nobody got it. It is a setting per device (on
  by default). When the page is hidden (another app on a phone, a closed tab) waiting texts are sent at once rather
  than lost. Files are sent at once.
- **Ta bort för alla (delete for everyone).** A `retract` message `{ id }` to the other party and the own other
  devices, not marked `notify`, for an own `text` or `file` at most 24 hours after it was sent. A receiving device
  takes it only from an accepted contact (or an own device) and only when:
  - message `id` is of that conversation and is a `text` or `file`;
  - the sender of the `retract` **is the author** of the message (the peer for an incoming message, the own account
    for an outgoing one): neither party can delete the other's messages;
  - the `retract` was sent at most 24 hours after the message (both times are signed by the author; 5 minutes of
    clock slack) and arrives at most 14 days + 24 hours after the message was stored on this device (the mailbox
    keeps it 14 days at most).

  The message is then replaced by a **tombstone** `{ id, conv, dir, time, kind: "retracted", by, rt }`: its text, its
  file (parts and anything still on its way), its reactions and its place in the list of files to offer again are
  deleted. The thread shows "Du tog bort det här meddelandet" or "<namn> tog bort ett meddelande", so the reader
  knows that something was there (a message is never made to vanish without a trace, which matters when the message
  was abusive). A tombstone keeps the id, so a late copy of the message (a send that is retried, a history hand-over,
  a file offered again) is not stored again, and it travels in history hand-overs instead of the message.

  A `retract` can arrive before its message (a newly linked device that gets the history later). It is then stored as
  a hidden tombstone (`pending: true`); when the message comes and the `retract` fits it (same conversation, same
  author, within the window) the message becomes a visible tombstone, otherwise the hidden one is dropped and the
  message is stored as usual.
- **Ta bort för mig (delete for me).** The message (or a placeholder) is replaced by a hidden tombstone `{ kind:
  "deleted" }` on this device and, through `sync` with `{ remove: [id] }`, on the account's other devices. The other
  party keeps its copy and is told nothing.

What it does not do: the server is not asked to drop a message it still holds (it does not know who sent what, and
must not learn it); the envelope is simply followed by the `retract` in the same mailbox. A device with an older
client keeps the message (§12), and so does a modified client. Whoever has seen the message has seen it. The OS
notification of a message never had content, so nothing is left there.

### 6.7 Editing

An `edit` message `{ id, text }` to the other party and the own other devices, not marked `notify`, replaces the
text of an own `text` message within 24 hours of sending it (the same window and checks as `retract`, §6.6: only
from an accepted contact or an own device, only the **author**, both times signed by the author). The text may not
be empty (deleting is the way for that). The stored message gets the new `text`, `edited` (the edit's time) and
`eid` (the edit message's id); the latest edit wins, by `edited` and then `eid`, so an older edit arriving late does
not undo a newer one. The thread shows "redigerat" by the time on both sides, with the edit's time as a tooltip.

Only the latest text is kept: earlier versions are not stored on any device. An edit of a message that was taken
back, or that this device does not have, is ignored (a device linked later gets the edited text in the history
hand-over). A device with an older client keeps showing the first text (§12), which the edit dialog says.

### 6.8 Disappearing messages

A disappearing message is an `ephemeral` message `{ text, ttl, wait }` to the other party and the own other devices:
`ttl` is its timer (15 s, 1 min, 5 min or 1 h in the interface), `wait` how long it may wait unread (7 days, or the
conversation's retention when that is shorter, §8.1). Both are inside the encryption.

A **disappearing picture** is an `ephemeral` message `{ file, ttl, wait }` whose `file` is the metadata of a `file`
message (§9: id, name, type, size, hash, chunk count, file key); its chunks travel like any file's. Only pictures that
are shown in the thread (PNG, JPEG, GIF, WebP within §9's limits) can be sent this way; a recipient drops one that
carries any other type. It is shown like a picture, without "Spara" in the thread or the viewer (and without dragging
out or "Save image as"); its countdown on the recipient's device starts once the picture is here and on the screen,
and its receipt (and so the sender's countdown) is sent once the picture is here, as for files. When the time is up
the picture's parts go with the message, as does anything of it still on its way, and a viewer showing it closes.
A screenshot cannot be stopped.

- **Countdown.** On the recipient's devices it starts when the message is on the screen of a visible page (each device
  for itself); on the sender's devices when a `receipt` says it arrived (§6.4: there are no read receipts). A message
  never seen, or never acknowledged, is gone `wait` seconds after it was sent; one that arrives later is not stored.
- **Removal.** When the time is up the message is replaced by a record without content that only keeps its id, so
  that a copy that comes again (a resend, a mailbox read twice) is not shown again; that record is deleted once no
  copy can be left in a mailbox. Deadlines are kept in an encrypted secret (`timed`) and swept by a timer, at start and
  when the page is visible again, so a countdown that ran while the app was closed is finished then. The interface
  fades the message for its last 3 seconds and folds its row away. Reactions go with the message. The record is
  one of the tombstones of §6.6 (`kind: "gone"`, hidden), so a late copy is ignored the same way.
- **Not copied.** Disappearing messages are left out of the history handed to a newly linked device (§7), and are not
  taken from one.
- **Server.** Its envelopes carry `to[].ttl = wait` (§10), so the server drops them unread after that, not after 14
  days; so do a disappearing picture's queued chunks (`relay` with `ttl`). The server thereby learns that an envelope is short-lived, never what it says.
- **Notifications** say "Försvinnande meddelande från …"; the push itself is empty as always (§10.1). The list of
  conversations never shows message text.
- **Taking back and editing.** "Ångra" holds a disappearing message like a text (§6.6), and "Ta bort för alla" and
  "Ta bort för mig" work on it like on a text (a taken-back one leaves the usual placeholder, which does not
  disappear). It cannot be edited (§6.7).
- **Composer.** The timer is chosen with a button by the composer and stays on for that conversation until it is
  turned off (kept in the contact record on that device, not synced). While it is on, pictures are sent as
  disappearing pictures; other files and GIFs from the collection cannot be sent.
- **Mixed versions.** A device that does not know `ephemeral` drops it (§12): the message is lost there rather than
  kept for good. No receipt comes from such a device, so the sender's copy is gone after `wait`. A device that knows
  disappearing texts but not pictures drops a picture the same way (its body has no `text`); the chunks it gets are
  forgotten as chunks without a `file` message (§8.1).

### 6.9 Search

A search button by the new-conversation button (or Ctrl+K / ⌘K) opens a search field in the sidebar; Esc empties
it, and an empty field closes. The server cannot search (it never has the texts) and the local store has no index
over them (records are encrypted, §8), so the client searches by decrypting each conversation's messages while a query
is typed. Matching is case-insensitive on the text of `text` messages and the name of `file` messages; disappearing
messages are not searched. Results are the conversations whose handle matches, then the matching messages, newest
first (at most 100). Choosing one opens the conversation with that message centred and briefly marked. What was
decrypted for a search is held in memory per conversation while the field has a query, is dropped for a
conversation when its messages change, and is forgotten when the field is emptied. Nothing about a search is
stored or sent.

### 6.10 Code in messages

A `text` message can hold code the way Markdown writes it, and nothing else of Markdown: `` `inline code` `` and
fenced blocks,

````
```rust
fn main() {}
```
````

Nothing in the protocol changes: the text is sent as written and only the recipient's client decides how to show it.
An older client shows the backticks as they are (§12), and search, editing and notifications see the plain text.

- **What is understood** (`client/js/code.js`, a subset of CommonMark):
  - *Inline code*: a run of backticks up to the next run of exactly as many on the same line; one space inside each
    end is dropped, so ``` `` a`b `` ``` shows `` a`b ``. A run with no partner stays text, so `` it`s `` is unchanged.
  - *Blocks*: a line of three or more backticks (at most three spaces before) opens a block. The first word after the
    backticks names the language. A line of at least as many backticks closes the block. As in many chat apps, a run
    at the end of the last code line also closes it (`` }``` `` closes and keeps `}`). An unclosed block runs to the end
    of the message. `` ```x``` `` on one line is inline code, as in CommonMark. Blank lines next to a block are not
    shown: the block has its own margins.
  - Nothing else: no emphasis, headings, lists, quotes, links, images or HTML. Without any of those there is nothing
    to strike by accident (`2*3*4`, `__init__.py`), and no formatting that could imitate the app's own notes (§6.6)
    or show one link while leading to another.
- **Showing it.** `parse` cuts the text into text, inline code and blocks. `highlight` cuts a block's code into
  `[class, text]` tokens. app.js makes elements from them with `h()`: text only ever goes into text nodes, and the
  only classes are the fixed token names (`code.CLASSES`, styled as `tk-*` in style.css). The CSP and `h()`'s checks
  (no markup properties, no foreign URLs) apply unchanged. A block shows its language and a *Kopiera* button that
  copies the code as written. It reads left to right (`dir="ltr"`) whatever the text around it, and scrolls
  sideways rather than wrapping. A message without backticks is drawn exactly as before.
- **Colours** only when the sender names a known language: JavaScript, TypeScript, JSON, Python, Rust, Go, C, C++,
  Java, Shell, SQL, CSS, HTML/XML, YAML, TOML and diff (with common aliases such as `js`, `py`, `sh`). The language is
  never guessed. Another name is shown as the block's label, uncoloured. The label is only taken if it is a plausible
  word (letters, digits and `_+#.-`, at most 24 characters), and it is shown as text. Each colour has at least 4.5:1
  contrast against the block's background in the light and dark themes.
- **Hostile text.** The text comes from others, so every scan is linear in its length: there are no regular
  expressions that can backtrack over the input, inline code is matched with one pass from each end, and the
  highlighter only moves forward. A block over 16 KiB is not coloured; messages are limited to 8000 characters
  anyway. Tests feed it pathological input (thousands of backticks, unclosed comments and strings, endless fences)
  and random text, and check that the tokens join to exactly the source and that only the fixed classes come out
  (`tests/code.test.mjs`).
- **Composer.** Enter sends, except inside an open block (an unclosed ```` ``` ```` fence before the cursor): there it starts a new line,
  so a block can be typed as it reads. On a touch screen (no `hover: hover`), where the keyboard has no Shift+Enter,
  Enter is always a new line and the send button sends; the keyboard shows a return key (`enterkeyhint`). Ctrl+Enter
  (⌘+Enter) sends anyway. Enter while an input method is composing text no longer sends.

## 7. Multi-device history

- Every message is also encrypted to the sender's own other devices, with `kind` unchanged and `to` set to that
  device. Own devices store it as outgoing.
- Contact state (accepted, blocked, pinned heads) is sent to own devices as `sync` messages.
- When a device approves a new device (§4.3), it sends the full local history and contacts as `history` messages in
  chunks of at most 48 KiB of plaintext.
- There is no server-side backup. If every device is lost, the history is gone; that is the price of keeping nothing
  on the server.

### 7.1 Can old messages be rescued when every device is lost?

Mostly not, by design. Where each copy of a message is, and why it cannot be read by a new device:

| Copy | Readable later? |
|---|---|
| Local history on the lost device | No: encrypted with that device's local key; the browser profile is gone. |
| Envelopes still in the mailbox for the lost device | No: sealed to that device's prekeys, whose private keys were only on it. They expire after 14 days, or go when the device is removed from the list. |
| Messages sent while no device was there | No: sealed to the devices in the list then; nothing is sealed to a paper key. |
| **The other party's devices** | **Yes, there**: each contact keeps the whole conversation, both directions. |

Options considered:

1. **Paper key that also receives** (a prekey derived from the paper key, so senders seal a copy to it and the server
   keeps it up to 14 days): would rescue at most the last 14 days, needs a prekey that is never rotated (breaking the
   three-week forward-secrecy window of §5.2 for everyone who writes to the user), doubles the mailbox and makes the
   server hold ciphertext that is never fetched. **Rejected.**
2. **Encrypted history backup on the server or in the vault**, under a key from the paper key or the password: the
   server would keep history, against principle 5 and G5, and a password plus the vault (or the paper) would read
   everything. **Rejected.**
3. **History from contacts** (a contact's device sends its copy of the conversation to the user's new device, on the
   contact's explicit choice): feasible, and the only source that exists. The copies would be the contact's account of
   the conversation, not signed by the user's old devices, so they must be shown as "återställt från X:s kopia".
   **A possible later feature**; not built.

The paper key therefore saves the account and its trust, not the history. The recommendation stays: link a second
device.

## 8. Keys at rest: what rootcard holds and what it does not

No extra password. The rootcard password unlocks local encryption, but the **private E2E keys never enter the rootcard
vault**:

- The vault (private data `app.mesg.localkey`) holds one random 32-byte **local secret** per account, created at the
  first Murmo login. The vault is synced through the server, so every device of the account can get it after a
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
| `files` | one header per complete file (`{ n, size }`), by file id; written last, after all its parts |
| `parts` | encrypted file contents in 48 KiB parts, each encrypted on its own (`<file tag>:<index>`: four digits below 10 000, then `~` and eight digits, so that keys sort in part order) |
| `incoming` | chunks that came before their `file` message, still encrypted with the file key (temporary) |

Files are never held in memory whole: a file being sent is read with `File.slice`, hashed incrementally and stored
part by part, then streamed from the parts; an incoming chunk is decrypted and stored as a part on arrival, and the
parts are hashed in order as they become contiguous. Chunks that come before their `file` message wait in `incoming`
(at most 16 MiB per sender account and 64 MiB in all; beyond that a chunk is refused and, if queued, not acknowledged
so it comes again) and are forgotten after 10 minutes without it. Parts without a header and incoming chunks older
than an hour are deleted at start. Files stored by version 1 (one record in `files`) are still read.
A file that does not fit on the device (`QuotaExceededError`) is deleted at once, on the sender before it is sent
(*no room on this device*) and on a receiver while it arrives (it can be fetched again later).

A file is put together in memory (as a `Blob`, built a batch of parts at a time) only to be shown or played in the
conversation: images up to 25 MiB, videos up to 100 MiB (`MAX_INLINE`). Larger files are offered for saving only, and
where the browser has `showSaveFilePicker` they are written to the chosen file part by part; elsewhere they are
handed to the browser as a `Blob` (Chromium keeps large ones on disk, other browsers may hold them in memory).

**Showing a long conversation.** A conversation opens with its newest 50 messages; the next 50 older ones are drawn
when the user scrolls near the top (or taps *Show older messages*), with what is on the screen kept in place, and a
search hit further back widens the window to it. A picture is put together from its parts only when it comes near
the screen; its size is read from the header first, so it has its place before it loads. The records of a
conversation are still all read and decrypted (the order is inside the encryption, so IndexedDB cannot give the newest
first without storing times in the clear), but side by side, and a record whose ciphertext is unchanged is not
decrypted again while the store is open.

**Retention per conversation.** A contact record can carry `retention` (seconds; 0 or absent: keep). Messages of
that conversation sent before *now − retention* are deleted from IndexedDB together with their files: when the
setting changes, every minute while the app runs, and at start. A message that is already older when it arrives (from
the mailbox or in a history hand-over) is not stored. The setting is synced to the account's own devices (`sync` with
`{ contact: { account, retention } }`) and travels with the contact records in a history hand-over. It applies only
to this account's devices: the other party decides about their copies, and nothing is sent to them.

## 9. Files

Files go live between connected devices. For devices that are not connected the server may keep the encrypted
chunks (the *file queue*), like the mailbox keeps envelopes; the sender can turn that off, and the operator can turn
it off for the whole server (`MURMO_FILE_QUEUE_MB=0`).

The queue has four byte budgets, checked together when a chunk is queued and when a sender asks for room
(`relay-space`, which also counts what it grants to one device against the totals for the next): per receiving device
(150 MiB), per sender account and receiving device of another account (50 MiB), per sender account over all devices
(300 MiB) and for the server (2 GiB). One account can therefore neither fill a device's share, blocking files from
real contacts, nor the whole server. Chunks to the sender's own devices count against its account budget only.
A file that does not fit is sent live later, when both devices are connected.

`/api/v1/info` advertises the budgets as `file_queue_limits: { file, device, sender, account }`, in queued bytes
(the encrypted chunks as sent: the payload of binary frames, or the text of JSON frames, §10.2): `device`, `sender` and `account` are the first
three budgets above, and `file` is the most one file can take for one device of another account, the smallest of
the four. They are upper bounds for a sender to compare a file against; whether it fits right now, with other
files queued, is still answered by `relay-space`. Without a file queue the field is absent.
The client compares a file against `file` before it sends it (a file of `size` bytes is counted as
`size + 96 × chunks` queued bytes with binary frames, and `ceil(size × 16/9) + 256 × chunks` as text: the
ciphertext is base64url inside JSON that is base64url again. Clients before this counted `1.4 ×`, so the server could
grant room in `relay-space` that the file then overran, and the transfer was refused partway): one that can never fit is not offered to the queue, its row above
the composer says so before the transfer starts, and account settings show the largest file the queue takes.

1. The sender picks a file (at most 1 GiB, `MAX_FILE`: files are read, stored and sent part by part, so the limit
   is not one of memory; the file queue usually takes less, see above, and a larger file then goes live only). It makes a random file key and file id, hashes the file (SHA-256), and
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
4. Receivers check every chunk and the final hash, store the file encrypted locally (§8.1) and show images inline
   (PNG, JPEG, GIF, WebP; never SVG) when their header gives at most 40 megapixels (for a GIF, also every frame in
   its first 256 KiB): a small file can otherwise decode to gigabytes. Larger or unreadable images are offered
   for saving only. Relay chunks are accepted only from the account's own devices and from contacts
   in state accepted or outgoing; others are dropped (and, if they came from the file queue, acknowledged so the server
   deletes them). Once the file key is known, every chunk is decrypted on arrival and a chunk that fails is dropped
   instead of spoiling the file. The file name and type in a `file` message are cleaned on receipt: control and
   bidirectional-formatting characters and path separators are removed (so `photo‮gpj.exe` cannot pose as a JPEG),
   and a type that is not a plain `type/subtype` becomes `application/octet-stream`. Files are always saved as
   `application/octet-stream`; user text is shown in bidi-isolated elements.
5. **Later federation between one account's devices:** a device that has the metadata but not the content can ask its
   own connected devices (`file-req` over the relay). A device that has the file streams it back the same way. Only
   devices in the account's own verified device list are served.

**Large files are taken, not pushed.** A file over 50 MiB (`ASK_ABOVE`) is not streamed or queued to any device,
since a phone on mobile data should not download hundreds of megabytes because a contact sent them. Its `file` message
carries `ask: true`, and the sending device keeps the file. The recipient's devices show it with *Ta emot*. The
device where that is pressed asks the device that sent the message for it (`{ k: "file-req", f }` over the relay,
only when that device is connected; otherwise the button says to try later). The sender streams it live to that
device only, and only after checking that the contact is accepted, the asking device is in the contact's verified
device list and the file was sent to that conversation with `ask`. It runs one stream per file and device at a
time. The recipient therefore chooses whether to receive the file at all, and on which device. Its other devices
can take it too, or fetch it from that one (step 5). The receipt is sent when the file has arrived, so the sender's
message says *waiting for the recipient* until then. The sender's own other devices are not pushed the file either,
and fetch it with step 5. A file below the limit behaves as before.

Relay frames carry `{ k: "chunk", f, i, n, c }` or `{ k: "file-req", f }` as base64url canonical JSON, or a chunk as
a binary frame (§10.2). Chunks are authenticated by the file key from the signed `file` message and the final hash,
so the relay needs no extra signature.

A device that asks for a file (*Ta emot* for an `ask` file, or step 5 from its own devices) first grants the device it
asks a budget of its own (`relay-grant`, §10.2): the file then comes as fast as the connections allow instead of
within the budget for chunks nobody asked for.

### 9.1 Emoji

Emoji are Unicode text in an ordinary `text` message; nothing in the protocol changes. The picker offers a fixed set
compiled into the client (`client/js/emoji.js`) and the system's own emoji font draws them: no images, fonts or
sprite sheets are loaded from anywhere, and text is still only ever set with `textContent`. A message of at most three
emoji and nothing else is shown larger (a CSS class; the text is unchanged). The recently used emoji are kept in the
device's encrypted store (§8.1, secret `recentEmoji`), not in `localStorage`.

### 9.2 GIFs

A GIF is an ordinary file (§9) and is shown inline like other images, within the same limits. There is no GIF search:
services such as GIPHY or Tenor would learn every search term and the user's address as it is typed, and an image
fetched from them would tell them when a conversation is open. The page's CSP would also have to allow them.
Instead each device keeps the user's own collection:

- New GIFs come from a file on the device (the GIF panel's *Välj GIF-fil…*, which also sends it) or from a GIF in a
  conversation (*Spara GIF* under it, or *Spara i mina GIF:ar* in the image viewer; a GIF already in the
  collection, by SHA-256, shows *✓ Sparad*). Only bytes that start with `GIF87a`/`GIF89a` are taken,
  whatever type the sender claimed, at most 8 MiB each and 60 in all, and only when the header's dimensions pass the
  same pixel limit as inline images. Duplicates (same SHA-256) are not stored twice.
- The collection is stored encrypted like message files (§8.1): the list in the secret `gifs`, each GIF in parts
  under the file id `gif:<random id>`, separate from message files, so a conversation's retention or deletion does
  not remove it.
- **Shared between the account's devices.** Saving or removing a GIF sends a `gifs` message `{ add: [entry] }` or
  `{ remove: [id] }` to the own other devices only (a `gifs` message from anyone else is ignored). An entry carries
  `id`, `size`, `n`, `width`, `height`, `sha256` and a file key of its own. The bytes are pulled, not pushed: a device
  that has an entry but not its bytes asks its connected own devices with `file-req` (on receipt, on every connect and
  every minute while some are missing), and they stream it over the file relay (§9) like any file. Pushing them
  would leave chunks on devices that do not know `gifs` yet (§12). Entries are checked again on receipt (size,
  dimensions, at most 60), and the bytes against `sha256`. A newly linked device gets the whole collection after the
  history (§7).
- Sending one is a new `file` message under the neutral name `animation.gif`; the recipient sees nothing that marks it
  as coming from a collection.

### 9.3 GIF search at GIPHY (optional)

When the operator sets `MURMO_GIPHY_KEY`, the GIF panel gets a *Sök på GIPHY* tab for filling the collection. (Tenor,
the other large service, closed its API to other platforms on 30 June 2026.) The trade-off is the user's, and the
panel says it every time, above the search field: the search and the GIFs are fetched by the browser directly from
GIPHY, which sees the user's IP address and search terms, and that traffic is protected by HTTPS only, not by the
end-to-end encryption.

- Only then does the CSP's `connect-src` list GIPHY's API and media hosts (`app::GIPHY_HOSTS`); without a key the page
  cannot reach GIPHY at all. `/api/v1/info` hands the key and the content rating (`MURMO_GIPHY_RATING`, default
  `pg-13`) to the client. The Murmo server never makes or sees a search.
- Nothing is asked before the user types (at least two characters, one request per pause in typing). Requests carry
  no cookies and no referrer; result URLs are used only when they are https on GIPHY's media hosts, with their query
  (tracking ids) removed. Previews are fetched as blobs, so no `<img>` points at GIPHY.
- A tap saves the GIF in the collection with the same checks as any other (§9.2); nothing is sent to the
  conversation until the user sends it from *Mina GIF:ar*, as an ordinary encrypted file.
- A beta key allows 100 requests an hour for the whole server; when GIPHY refuses, the panel says so.

### 9.4 Files view

*Filer* (the folder button in the sidebar, or the conversation's menu and top bar, there filtered to that contact)
shows every file of the conversations in the main pane, like a conversation (on a phone it covers the list, with the
same back button). It is drawn from the `file` messages the device already has (`Messenger.fileList`), decrypted while
the view is open and kept only in memory; nothing about it is stored or sent. Not in it: disappearing messages (§6.8),
messages taken back or deleted, declined contacts and the GIF collection; files of blocked contacts only under their
own filter (*Blockerade kontakter*), never among the others.

- Tabs *Alla*, *Bilder och video* (the types shown inline, §9; SVG never) and *Dokument* (the last choice is kept per
  device); filters by direction and conversation, a search on the file name, and *Nyast*/*Äldst*/*Störst*. Files are
  grouped by month (not when sorted by size): pictures and videos as square tiles, other files as rows with size,
  who (*Bob*, *Du → Bob*), day, status and an action (*Spara*, *Ta emot*, *Hämta från mina enheter*, *Hämta igen*).
  More are drawn as the end of the list nears the screen.
- A tile puts its picture together from the stored parts only when it nears the screen, at most four at a time, after
  the header's dimensions passed the pixel limit (§9); no thumbnail is stored. Pictures and videos open in a viewer
  with previous and next (buttons, arrow keys, a swipe). The `⋯` menu has *Öppna*, *Spara*, *Visa i konversationen*
  (the search's jump, §6.9), *Ta bort från den här enheten* and *Radera…* (the thread's menu, §6.6).
- **Transfers** under way show a bar with the per cent, the bytes so far of the whole, the speed over the last
  seconds and the time left (or *väntar på anslutningen…* when nothing has come for 10 seconds): more than the
  thread's percentage. Incoming ones follow `fileProgress`, outgoing ones the sending device's progress.
- **Ta bort från den här enheten** frees room on one device: the file's header and parts are deleted (with the message
  record updated in the same transaction), and the message stays with `have: false`, `freed` (when) and the status
  *borttagen från den här enheten*. Nothing is sent to anyone. The file id is kept in the secret `freedFiles`, and
  until the user asks for the file again (*Hämta igen*: `fetchFromOwnDevices`, or `acceptFile` for an `ask` file,
  which first clear the mark) chunks for it are refused, and queued ones acknowledged so the server deletes them: the
  sender's retry of `missed` devices or the file queue do not bring it back. `freed` is local like `have`: it is
  removed from messages handed over to a new device (§7), so no protocol or §12 change is needed. The confirmation
  says that the file can be fetched again only from an own device that still has it, or from the sender while they
  keep it, and warns separately about own files this device still has to serve (an `ask` file not yet taken, or a
  file some recipient devices have `missed`: `Messenger.serves`).
- *Välj* (or a long press on touch) selects several files, a month at a time if wanted; the bar at the bottom says how
  many and how much is on this device, and removes them together. *Frigör utrymme* in the footer opens the files that
  are here, largest first, in select mode, with what the browser reports for the site (`navigator.storage.estimate`).
  Nothing is chosen for the user.

## 10. Server API (v1)

All bodies are canonical JSON. Errors are `{ "error": "<code>" }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| any | `/id/v0/…` | rootcard | rootcard host protocol (HOST_PROTOCOL.md) |
| GET | `/.well-known/rootcard` | – | host pointer |
| GET | `/api/v1/info` | – | origin, own home, realms, allowed homes, `build` (changes when the served client changes; an open page then offers a reload), `file_queue` and, when it is on, `file_queue_limits` (§9) |
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
| client → server | `auth` may carry `caps: ["bin"]`: the connection takes binary relay frames (§10.2) |
| server → client | `{ t: "ready", relay: { bytes, peer, granted, store, frames, slow_frames, grant, binary, window } }` (the relay budgets below and in §10.2) then queued `{ t: "msg", id, env }` frames |
| client → server | `{ t: "send", id, to: [{ device, env }] }` → `{ t: "sent", id }` |
| client → server | `{ t: "ack", ids: [...] }` (deletes) |
| client → server | `{ t: "prekey", prekey }` |
| client → server | `{ t: "presence", devices, ref }` → `{ t: "presence", online, ref }` |
| client → server | `{ t: "relay", to, data, ref }` → forwarded as `{ t: "relay", from, account, data }` to connected devices only; `{ t: "relay-missed", devices, text?, ref }` for the rest (`text`: connected devices that take no binary frames, for a binary chunk) |
| client → server | binary relay frame (§10.2): the same, with the chunk as bytes |
| client → server | `{ t: "relay-grant", from, bytes, ref }` → `{ t: "ok", ref }`; the device `from` is told `{ t: "relay-grant", to, bytes, ttl }` (§10.2) |
| server → client | queued file chunks `{ t: "relay", id, from, account, data }`, a few at a time after the envelopes |
| client → server | `{ t: "relay", to, data, ref, store: true, ttl? }`: as above, and chunks for devices that are not connected are queued (for `ttl` seconds when given, at most 14 days) |
| client → server | `{ t: "relay-space", devices, bytes, ref }` → `{ t: "relay-space", ok, ref }` (room in the file queue) |
| client → server | `{ t: "relay-ack", ids }` (deletes queued chunks) |
| client → server | `{ t: "seen", ref }` → `{ t: "seen", devices: { device: seconds }, ref }`: when the account's own devices were last connected (`0`: now), for cleaning up the device list; never for other accounts |
| client → server | `{ t: "push-sub", endpoint?, ref }` → `{ t: "ok", ref }`: set or remove this device's push endpoint |
| client → server | `{ t: "ping" }` → `{ t: "pong" }` (the client's heartbeat; browsers drop sockets of background pages silently) |
| server → client | `{ t: "link", request }`, `{ t: "devices", account, head }` |

`to[].ttl` (seconds) is optional and shortens how long the server keeps that envelope (used for disappearing messages); the server learns that the envelope is short-lived, never its content.

Limits (v0): envelope ≤ 64 KiB, ≤ 24 recipients per send, ≤ 2 000 queued envelopes per device, mailbox TTL 14 days,
60 sends per minute per device, 20 lookups per minute and 5 link requests per hour per network address.

Relay (live file chunks and the file queue): bytes per minute (of chunk text, or of a binary frame's payload), with a
budget per route; each chunk is counted once for each recipient device it goes to, by where it goes:
- **live**, to a connected device that did not ask for it: 384 MiB per sending device and 96 MiB per sending account
  into any one recipient device, whichever of the account's devices sends;
- **granted**, to a connected device that granted the sending device more (§10.2): 1 GiB per sending device
  (`MURMO_RELAY_GRANTED_MB`), within what the grant has left;
- **queued**, into the file queue for a device that is away: 128 MiB per sending account (`MURMO_RELAY_STORE_MB`),
  besides the queue's own limits (§9);
- to a device that is neither connected nor queued for: nothing (it is only listed in `relay-missed`).

At most 24 000 relay frames per minute per device, of which 3 000 may go live without a grant or into the queue. A
frame that would go over any of its budgets is refused whole, with `{ t: "error", error: "rate_limited", id: ref,
retry }` (`retry`: seconds), and counts nothing. The budgets are announced in `ready`; the client paces a transfer
to stay under 90 % of them over any sliding minute, and a transfer whose chunk is refused anyway stops and is offered
again later, like one whose connection broke.

Rate limits count per IPv4 address and per IPv6 /64. Counters are keyed by a hash of the address under a random
secret in the database (HKDF-SHA-256, 128 bits), never by the address itself. Windows of ten minutes or more
(registration, link requests, vault fetches, `connect`) are saved every minute and on shutdown, so restarting the
server does not reset them; nothing older than an hour is kept.

Behind a reverse proxy, `X-Forwarded-For` is read only when the connection comes from a proxy listed in
`MURMO_TRUST_PROXY` (`1`: loopback and private networks). The hops are read from the right, skipping trusted proxies;
the first other address is the client. Anything further left was written by the client and is ignored.

### 10.1 Notifications

A device is woken when something arrives while its page is frozen or closed, unless the user turns that off: the
setting is on by default and the client asks for the browser's notification permission at the first click after login. Its service worker subscribes
with the browser's push service (Web Push, VAPID key from `info.push_key`) and the page sends the endpoint URL
(`push-sub`). The server accepts endpoints only on the push services in `MURMO_PUSH_HOSTS` (no requests to arbitrary
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

### 10.2 File relay: binary frames and grants

**Binary frames.** File chunks go as binary WebSocket frames; everything else, `file-req` included, stays JSON text.
A JSON chunk is base64url ciphertext inside canonical JSON that is base64url again: 1.78× the file, all of it
counted against the relay budgets and the file queue, and decoded twice by the receiver. A binary chunk is 1.0×, and
its ciphertext goes to `crypto.subtle` without decoding. The server still forwards bytes it cannot read.

*Client → server* (all integers big-endian):

| Bytes | Field |
|---|---|
| 1 | frame type `0x01`; any other value is refused (`bad_relay`) |
| 1 | flags: bit 0 `store`; other bits must be 0 |
| 1 | `k`, the number of recipient devices (1–24) |
| 16 × k | recipient device ids, raw (a device id is base64url of 16 bytes) |
| 8 | `ref`, random; echoed as base64url in `relay-missed` and `error` frames |
| 4 | `ttl` in seconds, 0 for none (only with `store`) |
| rest | payload, 1 to 64 KiB: `f` (1 byte length, 1–64, then the ASCII id), `i` (4), `n` (4), the AES-GCM ciphertext |

*Server → client:* type `0x02`, the sending device id (16 bytes), the sending account (1 byte length, then the id),
the queue id (8 bytes; 0 when live), then the payload unchanged.

- A connection takes binary frames only when it said so in `auth` (`caps: ["bin"]`); to one that did not, the server
  delivers nothing and lists the device in `relay-missed` under `devices` and `text`. The sender then sends that
  device text frames, and the file is offered again (§9, step 3). The server never turns a binary chunk into text: it
  would have to build the client's payload format. The server announces `binary: 1` in `ready`; a client sends binary
  frames only to such a server, and text otherwise.
- The server reads fixed offsets with checked bounds and refuses a frame that is truncated, has `k = 0` or `k > 24`,
  sets unknown flags, or has an empty or larger payload. A binary frame before `auth` closes the connection, as any
  unexpected frame does. `from` and `account` come from the authenticated connection, never from the frame.
  Duplicates are dropped, and the budgets are charged all or nothing, as for JSON frames. The fuzz target `ws_binary`
  runs in CI.
- The file queue keeps a binary chunk as a `BLOB` in the same column as text chunks, and delivers each in the form it
  came in. A queued binary chunk is held back from a connection that takes no binary frames (it stays until it
  expires); older pages last only until the next reload.
- The receiver's checks are those of JSON chunks (§9, step 4); only the decoding in front of them changed. No
  `permessage-deflate`: ciphertext does not compress.

**Grants.** The live budgets are there because nobody asked for those chunks. When a device asks for a file
(`file-req`), it first tells the server it wants it: `{ t: "relay-grant", from, bytes }` lets the device `from` send it
up to `bytes` (at most 2 GiB, the client asks for the file's size as text) in the next 30 minutes, and `bytes: 0` takes
it back. The server tells `from`, if it is connected, so that it can pace for the larger budget. While a grant has
room for a chunk, the chunk is counted against it and the granted budget (1 GiB per minute per sending device) instead
of the live ones. A grant is between two devices: the sending account's other devices, and other senders, are still
on the live budgets.
- It cannot be used to flood anyone: only the receiving device can grant, and only for chunks to itself. The granted
  budget bounds what one sending device costs the server in bandwidth.
- Grants are in memory, at most 16 per receiving device (a new one replaces the oldest), and gone on a restart; the
  transfer then falls back to the live budgets.
- The server learns that a device asked another for something, and roughly how large. It could already see that from
  the `file-req` frame's timing and the stream of chunks that followed.
- Measured end to end (two Node clients against a release build with the default budgets, one machine): a 120 MiB
  `ask` file took 125 s as text on the live budget, and 6.2 s as binary frames on a grant.

## 11. Data the server stores

| Data | Why | Retention |
|---|---|---|
| rootcard log, vault (encrypted), profile, sessions | rootcard home | while the account exists |
| logs of identities from other homes | verifying their devices | while the account is used here |
| device lists, current prekeys | others must encrypt to your devices | while the account exists |
| envelopes | delivery | until acknowledged, at most 14 days |
| link requests | linking | memory only, 10 minutes |
| relay frames (file chunks) | live transfer | not stored when the recipient device is connected |
| queued file chunks (ciphertext) | files for devices that are away (sender's choice) | until acknowledged, at most 14 days (a disappearing picture's: its unread limit) |
| relay grants (receiving device, sending device, bytes left), in memory | a faster transfer of a file the receiving device asked for (§10.2) | used up, taken back, 30 minutes, or a restart |
| push endpoint per device | notifications (the user's choice) | until turned off, logged out, or reported gone |
| VAPID key | signing push requests | while the server exists |
| network addresses | rate limits | keyed hashes only; in memory, and for windows of 10 minutes or more in the database, at most an hour |

No access logs with addresses are written by default (`MURMO_LOG=info` logs no addresses or account ids).

## 12. Mixed versions

Devices are updated when the page is reloaded (the client offers it when the server's build changes), so a
conversation can for a while have devices from before and after a change. The rule that keeps this safe: a device
checks `kind` against the kinds it knows (`KINDS` in `protocol.js`) before anything else, and acknowledges and drops a
message whose kind it does not know. Nothing is shown, stored or answered, and nothing breaks. So a new kind must
never be needed for an old one to work, and what a new kind adds is lost on devices that do not know it.

What clients from before emoji, reactions, the shared GIF collection and code formatting get from newer ones:

| From a newer device | On an older device |
|---|---|
| emoji in text | ordinary text, shown as before (not enlarged) |
| a GIF (from the collection or GIPHY) | an ordinary `file` message `animation.gif`; `image/gif` was already shown inline, within the same limits |
| `reaction` | dropped. The older device never shows it, also not after a later update (the message was acknowledged). The sender sees its reaction at once and cannot tell. Reactions do not notify, so nothing is woken for it either |
| `reactions` on messages in a history hand-over (§7) | stored with the message and not shown; shown once that device is updated |
| `retract` (§6.6) | dropped: the older device keeps showing the message, also after a later update. The sender is told so before choosing "Ta bort för alla" ("…använder en äldre version av Murmo kan det finnas kvar") |
| `edit` (§6.7) | dropped: the older device keeps the first text, also after a later update. The edit dialog says so |
| `edited` on messages in a history hand-over | stored, the edited text is shown without "redigerat" until the device is updated |
| tombstones (`retracted`, `deleted`) in a history hand-over | stored, shown as an empty message until the device is updated |
| `sync` with `remove` | the part it does not know is ignored: the message stays on the older own device |
| `ephemeral` | dropped, never shown or stored, and not acknowledged with a receipt: a disappearing message is lost on an older device rather than kept for good |
| a `file` message for a file over 100 MiB, and its chunks | dropped: clients before 1 GiB files took at most 100 MiB and 4096 chunks per file. The file is not shown there, also not after a later update; the sender cannot tell. Such clients last only until the page is reloaded (the server's `build` changes and an open page offers a reload) |
| a `file` message with `ask` (over 50 MiB) | shown as a file not received yet, with only *Hämta från mina enheter*: the older device cannot take it. Once updated, it can |
| `` `inline code` `` and ```` ``` ```` blocks in a text (§6.10) | the text with its backticks, as written; nothing is lost |
| `gifs` to an own older device | dropped; that device has no collection until it is updated, and then gets only GIFs saved after that. The bytes are pulled with `file-req` (§9.2), so no chunks are pushed to it; a `file-req` for `gif:…` sent to an older device finds no file message and is ignored |

| a file chunk as a binary frame (§10.2) | not sent to it: an older page does not ask for binary frames in `auth`, so the server lists it in `relay-missed` (`text`), and the sender sends it text frames and offers the file again. A binary chunk queued while it was away stays queued until it expires; such pages last only until the next reload |
| `relay-grant` | not sent by older devices, so a file they ask for comes on the live budgets as before; an older sender ignores the server's note and paces for the live budgets, which still leaves the transfer within the grant |

An older device sends nothing new, so a newer device has nothing to handle from it.

## 13. Ideas, not decided

Ideas kept here so they are not forgotten. None of them is built or promised, and none is part of the protocol above
until it is moved into its section (and into [PLAN.md](PLAN.md)). Each says why it could matter, how it could fit what
exists, and what has to be decided first. They must keep §1: the server stays blind, learns no social graph and
stores no more than it does now, unless an idea says otherwise and that is accepted.

### 13.1 Recovery and identity

**Remote wipe.** Partly there: a removed device that starts and connects finds itself missing from the list
(`unknown_device`), deletes its local store and forgets the account on the login screen (`logout(true)` in `app.js`),
and contacts stop encrypting to it (§4.4). What is missing:
- The owner learns nothing. The device could, before deleting, send a last message signed with its device key to the
  own devices ("wiped at …"); the server would have to let a just-removed device send this one message, or the
  device signs it and the server keeps it with the removal. Shown in the device list.
- A device that is never started again is never wiped. "Remember me" (T12) stores the derived key, so such a profile
  is readable offline. Nothing helps against that except not remembering; the removal dialog should say so.
- A device can be removed only by a device; the paper key could also remove one (today it can only add).
- Decide: is a "wipe" different from a removal (for example: remove and say "stolen", which also suggests a new paper
  key and rotating the password), or is removal enough with better wording?

**Proofs of linked accounts.** rootcard already has proofs (SPEC §14, `prove`, `verifyProof` and
`statementChallenge` in the vendored core): the account key (or recovery key) signs a challenge for a named
recipient, checked against the newest log. Murmo uses this only to ask for a link (§4.3). It could also let users:
- show statements such as "I am @alice on example.social" or "I control example.com", signed by the account key and
  published where the other account lives (a post, a `/.well-known` file), so someone who trusts that account can
  reach `Alice#3F9C` without any search (§1.3 holds: the user hands out the link, Murmo looks nothing up);
- answer a contact's or a website's challenge ("prove you are Alice#3F9C") from the app.
- Decide: are statements shown inside Murmo (on a contact's card, re-checked against their log), and how is a statement
  taken back? Does a proof made with the account key survive a reset with the recovery card (a new instance)?

**Social recovery of the paper key.** The paper key (§4.5) split k-of-n (Shamir, for example 3 of 5) among chosen
contacts, each share sent end to end and kept by their devices. With every device lost, the user logs in with the
password, asks the guardians (by identifier, a message request they already accept), and k shares rebuild the paper.
The paper alone is worth nothing without the password (§4.5), so guardians who join forces still cannot add a device.
- Decide: how does a guardian know the request really comes from the user and not from someone with the password?
  (A call or meeting, a safety code read out, a delay with notice to the old devices.) What happens to shares when a
  guardian loses their devices or the paper key is replaced (new shares to all)?

**Verify in person with a QR code.** Each screen shows a QR with the identifier, the device-list head and the safety
code (§6.3); scanning each other's codes accepts the request in both directions and marks the contact "verified in
person". Breaks if the head changes later, as the safety code does today.
- Decide: camera access in the browser (a permission, and a QR decoder in the client: a dependency or own code).

**Identity timeline.** The rootcard log and the device list drawn as a history: instance created, devices added and by
which device, paper key made or used, devices removed. A device nobody recognises stands out as an event. Only
showing what is already verified.

### 13.2 Fewer unwanted messages

**Aliases you can throw away.** Hand out `Alice-bike#81C2` instead of the real identifier, for a sale, a conference
badge, a dating profile. Requests to the alias land in their own list; turning it off stops them, and the real
identifier was never shown.
- Could be a separate rootcard identity per alias, owned by the same devices (heavy: logs, vaults), or a name the
  server maps to the account (the server then learns which aliases belong together: weaker than §1 today).
- Decide: which of the two, how a contact who later should know the real identity is moved over, and the limits.

### 13.3 Calm messaging

Murmo already has no typing indicator, no read receipts and no "online" status. The idea is to make calm the point:
- **Intent when sending:** *no rush* (never notifies), normal, *urgent* (notifies even in quiet hours). Inside the
  encryption; the server sees only `notify` as today (§2). Urgent limited per contact so it is not abused.
- **Delivery windows / quiet hours:** notifications batched on the user's own devices ("at 08:00 and 17:00"). The
  push is still empty; only when the device shows a notification changes.
- **Shared availability:** "usually answers in the evening", sent end to end to accepted contacts, instead of presence.
- **Waiting for my reply:** a list of conversations where the last message is from the other side and asked for an
  answer, instead of unread counters.
- **Letters / time capsules:** a message that opens on a date. Up to the queue's 14 days the content could be sent
  at once and its key later from a sender's device; beyond that it waits on the sender's devices.
- Decide: whether intents are a new kind (§12: lost on older devices) or a field older devices ignore.

### 13.4 Privacy

**What the server knows about me.** A page that shows, for the logged-in account, what the server holds right now
(§11): device list and prekeys, number and size of queued envelopes and file chunks per device, push endpoints,
rootcard data, with a delete button where deleting is safe (push endpoints, queued chunks this account sent).
Needs an authenticated `/api/v1/me` that reports counts and sizes, never more than the server already has.

**Duress password.** A second password, set on a device, that opens an empty profile, or deletes that device's local
data, instead of the real one. Local only: the vault and rootcard know nothing of it.
- Decide: an empty decoy is easy to tell apart from a used account; deleting is irreversible. Also what the duress
  login does with the server session (a real login would show on the user's other devices).

**Sealed sender and padding.** The server knows which device sends to which devices and when (AR3). The sender
could be hidden inside the envelope (the server only checks a delivery token per conversation instead of the sending
device), and envelopes padded to a few size buckets.
- Decide: rate limits and quotas today are per sending account (§9); they need another anchor (tokens issued per
  accepted contact, anonymous credentials).

**One-time secrets.** A text (a password, a door code) that can be opened once, is not kept in history, not handed to
new devices and not forwarded; the sender sees when it was opened. Built on `ephemeral` (§6.8) with "open once"
instead of a timer.

### 13.5 Inside a conversation

- **Shared objects:** a list (shopping, packing), a poll, a shared note, live location with a hard end. Kept as
  small CRDTs whose updates are messages, so the server sees ordinary envelopes. Becomes much more useful with groups.
- **Voice messages, transcribed on the device** (Web Speech, or a speech model in WASM/WebGPU, never a cloud service).
- **Translation and "catch me up" summaries on the device** with the browser's built-in translation and summary APIs
  where they exist, off where they do not. Nothing leaves the device; the app must say what the browser does with it.
- **Calls** over WebRTC, signalling inside envelopes, the DTLS fingerprint bound to the device keys and shown next to
  the safety code. Decide: a TURN server reveals both parties' addresses to its operator; is it offered, and by whom?

### 13.6 Murmo outside the app

**"Contact me securely" widget.** A few lines of HTML a journalist, lawyer or project puts on their site: the visitor
writes, the message is encrypted in their browser with a key made on the spot to the owner's devices, and arrives as a
message request (§6), with a one-time link for the visitor to read the answer. Like a small SecureDrop.
- Decide: abuse (anonymous senders, so rate limits and maybe a proof of work), whether senders without an account fit
  the device-list model, and that the widget's script must be served by Murmo, not copied (AR1).

**Alerts and bots.** `protocol.js` already runs in Node: a small CLI or HTTP sidecar (`murmo-send "backup failed"`)
for self-hosters who want encrypted alerts on their phone, and bots that are rootcard identities asking to be
contacts like anyone else. Decide: where a bot keeps its device key, and whether bots are marked as bots.

**An AI assistant (Claude) as a contact.** A worked plan for one such bot: an assistant that can read and send
messages in Murmo through tools (MCP). Nothing here is built.

*What already works.* The client engine runs headless: `tests/e2e.test.mjs` drives `core.js` in Node 22 against the
real server through registration, login, device setup, requests, acceptance and text (`id.login` → `setupDevice` →
`new Messenger(…)` → `request`, `sendText`, `messages`). The server accepts WebSockets without an `Origin` header
(`ws.rs`: not a browser, the device signs for one of the server's origins). So no protocol change is needed.

*Shape.*

```
assistant ──MCP tools──► murmo-bot (Node, long-running) ──HTTPS/WebSocket──► Murmo server ──► contacts' devices
                         its own rootcard identity, e.g. Claude#7K2Q
                         one device in its own device list
                         encrypted local store on disk
```

1. **Its own identity, never a device of the user's account.** The bot registers as an ordinary identity
   (`Claude#XXXX`); its owner keeps the recovery card offline. It reaches people only with a `request` they accept
   (§6.2), like anyone else. Linking it as a device of the user's own account is possible but rejected: it could
   then write as the user and would receive the whole history (§4.3, §7), against §4 and §8.
2. **A long-running sidecar** on a machine the owner controls (next to the Murmo server, or the owner's computer as a
   local MCP server). It must stay connected to receive replies, send receipts and rotate prekeys (§5.2: replaced
   every 7 days, private keys kept 21 days, mailbox 14 days). An ephemeral cloud container is a poor home: its device
   key is lost each time, every run would be a new device to link, and the list allows only 8 devices and 32 entries
   (§4.1).
3. **A small MCP server** around `Messenger`, with few tools: `list_contacts`, `read_messages(contact)`,
   `send_message(contact, text)`, `request_contact(handle, note)`. Files, reactions and edits later, if at all.

*What has to be built.*

| Part | Work |
|---|---|
| Persistent store | `Store` uses IndexedDB; the tests use `fake-indexeddb`, which is in memory only, so the device key would be lost on restart. Either an IndexedDB shim on disk, or a file-backed store with the same interface. Records are already encrypted with the local key (§8), so the files reveal nothing more than the browser's database does. |
| Unlocking at start | The local key comes from the local secret in the rootcard vault, which the password unlocks. Either the password is given at each start (a secret of the sidecar), or "remember me" (`store.remember`) keeps the key on disk, protected only by file permissions. |
| Updates | The web client reloads when the server's `build` changes; the sidecar runs a pinned commit and must be updated and restarted by its owner. §12 keeps this safe, but kinds it does not know are dropped. |
| MCP layer and a test | A few hundred lines; an e2e test in which the bot requests a contact, is accepted, sends, and receives a reply. |

*Trust and safety, to settle before building.*

- **The end of "end to end" is a third party.** Encryption reaches the bot; the plaintext then goes to the model
  provider. This must be a new row in [THREAT_MODEL.md](THREAT_MODEL.md), and contacts must be able to see it: this is
  the case for deciding that **bots are marked** (for example a flag in the profile or the device entry, shown with
  the request and next to the safety code).
- **Prompt injection.** Incoming messages are untrusted input to the assistant. The sidecar sends only to accepted
  contacts (the engine already refuses others with `not_accepted`); sending should need the owner's confirmation or an
  allowlist of contacts; message text is passed to the assistant as data, never as instructions.
- **A leak costs the bot, not the user.** A stolen bot device can speak only as the bot. Replacing it is a new device
  that contacts see (the safety code changes), and any device of the bot can `remove` it (§4.4).
- Limits are no obstacle: 60 sends per minute per device, 64 KiB per envelope (§10).

*Order of work.* 1) decide marking and add the threat-model row; 2) file-backed `Store` with tests; 3) the sidecar
(login, unlock, `Messenger`, reconnects) under `tools/murmo-bot/`; 4) the MCP tools with confirmation before sending;
5) an e2e test against the real server.

### 13.7 Trusting the client

**Check the served client.** Extend the "signed, reproducible client" item in [PLAN.md](PLAN.md): the installed app
compares the served files' hashes with a list signed by a release key (for example published in a rootcard log)
before running them, and warns otherwise. It answers AR1, the objection to every web messenger that the server can
serve other code. Decide: how a service worker can reliably hold back a page it does not trust, and how the release
key is replaced.

### 13.8 Faster file relay

Built: binary chunk frames, grants for files the recipient asked for, and a budget of its own for the file queue
(§10, §10.2). What is left of the plan:
- **Receiver batching:** write arriving parts to IndexedDB a few at a time (as the sender reads them with
  `PART_BATCH`) instead of one transaction per chunk; in the measurement in §10.2 this, and hashing, is now the limit.
- **A larger chunk size** (for example 256 KiB), for fewer frames, transactions and round trips. Older clients refuse
  a chunk larger than 48 KiB, so it needs a `chunk` field in the `file` message and a §12 row.
- **A larger live budget** for files that are pushed (below `ASK_ABOVE`)? It is now 1.78× more file per minute than
  before, since binary chunks are counted by their payload (T31).

### 13.9 A view of shared files

Built: the files view and removing files from one device (§9.4). What is left of the plan:
- **Stored thumbnails.** Tiles put each picture together from its parts when it nears the screen. A stored, encrypted
  thumbnail per picture (made on receipt) would make a grid of thousands of photos cheaper, but is new data at rest
  and a new step on every received picture: decide after measuring.
- **First frames of videos** on their tiles: the video would have to be put together to draw one.
- **"Keep it only on this computer":** removing a file from all own devices but one. It needs a new `sync` kind and a
  §12 row, so it waits until removing on one device has been used.
