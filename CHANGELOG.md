# Changelog

What changed in each release, and what someone who runs a Murmo server has to do about it. The newest first. Every
release has a line **Operators: anything to do?**, also when the answer is no. The details of every change are in the
git history.

Before a release is tagged, "Unreleased" becomes `## <version> (<date>)`: the release workflow refuses a tag without
its section and puts the section in the release notes.

## Unreleased

## 0.3.1 (2026-11-26)

A patch release for servers that run the bridge: fixes from a security review. Nothing changes in the protocol, the
client or the database.

**For operators**

- **Bridge fixes from a security review.** Declining or blocking through the API now counts against a bot's 2 000
  contacts, as requests do, so a bot's state cannot grow without bound. A change by the owner (`owner_only`, accepting
  requests at once, retention, deleting the bot) now applies at once, also to a `GET /messages` that is already
  waiting. Bots made at the same moment by one owner can no longer pass `MURMO_BRIDGE_BOTS`. The documents now say
  that `MURMO_BRIDGE_OWNERS` takes account ids only and is checked at login: bots already made keep working when
  their owner is taken off the list.

**Operators: anything to do?** No. The image tag `…:0.3` gets this release; a server without `MURMO_BRIDGE=1` is not
affected.

## 0.3.0 (2026-11-24)

The bridge: programs, such as an AI assistant, can now write with Murmo users through bots, over HTTPS. It is off
unless the operator turns it on. Nothing changes in the protocol; the database gains a table only where the bridge is
on.

**For users**

- **Bots.** On a server that runs the bridge, a bot is an account like any other (`Name#TAG`): it asks before it
  writes, and you accept or decline as for anyone. Its device is named "Murmo Bridge" in its device list and safety
  code. What you write to a bot is read by the server that runs it and by the bot's program: end-to-end encryption
  ends there.

- **The help says what the server keeps about who writes to whom.** It keeps, as keyed hashes, the sender of each
  waiting message and, for 90 days, which account wrote to which (the terms already said so; the help and the FAQ
  said nothing was written down). The help also says that forward secrecy covers traffic older than about four weeks,
  that a reset with the recovery card logs out every device and the paper key, and that Microsoft's push service can
  be the one a browser uses. In all four languages.

**For operators**

- **The bridge (`MURMO_BRIDGE=1`, off by default).** Owners log in at `/bridge/` with a rootcard identity (a proof
  for a challenge, the password stays in the browser), make bots and get each bot's address and API key; programs
  send and receive messages at `/bridge/api/v1` (DESIGN.md §16, `docs/HOSTING.md` "The bridge"). Per bot: how long
  received messages are kept for the program (default: deleted as soon as it has them, or up to 30 days until it
  confirms them), whether it talks with its owner's account only, and whether it accepts requests at once. A new key
  or deleting a bot at any time. `MURMO_BRIDGE_OWNERS` limits who may make bots (account ids), `MURMO_BRIDGE_BOTS`
  how many each (5). Not yet: contacts on other servers, and files.
- The server is built with rootcard's `vault` feature (X25519, AES-GCM, Argon2id, from the same audited crates),
  which the bridge needs to register bots and to encrypt to devices.
- The compose file and `deploy/.env.example` run the `0.3` image.
- `docs/HOSTING.md`: how to get `deploy/`, that a `MURMO_DATA` directory must be owned by uid 65532, the backup
  command for the systemd service, removing the old client before unpacking an update, and a table of the settings
  the compose files read.

**Operators: anything to do?** No, unless you set `MURMO_IMAGE` to `…:0.2` yourself: change it to `…:0.3`. The
bridge stays off until you set `MURMO_BRIDGE=1`; read "The bridge" in `docs/HOSTING.md` first.

## 0.2.1 (2026-11-21)

A patch release for users: accessibility, a few things that were missing, and settings kept encrypted. Nothing
changes in the protocol, the server or its database.

**For users**

- **Easier with a screen reader and a keyboard.** Toasts and form errors are announced, and so is a new message, once
  (the whole app is no longer one live region). Dialogs are named by their headings, login and registration are real
  tabs, the safety code button has a name on phones, and a toast over a dialog is shown and read in it.
- **Easier to see.** The focus ring and the faintest text have enough contrast, in light and dark.
- **The recovery card screen has a way back**, and registering offers "Remember this device", as logging in does.
- **The installed app** has a screen of its own when it is opened without a connection, and an icon that fills the
  shape the phone gives it. The spinner turns slowly when the system asks for less motion.
- **Your settings on a device are encrypted** with everything else of your account. They are moved out of the
  browser's plain storage at your next login.
- Pictures sent within the same second load newest first, like all others.

**Operators: anything to do?** No.

## 0.2.0 (2026-11-20)

The first tagged release, with container images, release archives and checksums. Federation is new since 0.1, and so
is everything below.

**For users**

- **Federation.** Murmo servers exchange messages and files with each other: you can write to `Name#TAG@other.host`,
  and people on other servers can write to you, as a message request that you accept or not. Nobody can search for
  you.
- **Invite links and QR codes.** "Invite someone" gives a link with your address, a QR code, and a text to send.
  Opening the link fills in a new conversation, and nothing is sent without a tap. The help explains what a link
  shows and what it does not prove.
- **Messages that did not arrive are shown.** Texts are kept until they are delivered, held ones get a pending mark,
  and failed ones a "not delivered" mark. A lost connection shows a banner.
- **Questions before deleting** a conversation, blocking someone, or removing a device. Storage and background
  errors are shown instead of being lost.
- **Pictures in a conversation come quicker**, those on the screen first.
- **Safer against a hostile server:** each device pins its own account's device list, a forked list stops
  receiving as well as sending, and senders refuse prekeys older than four weeks or older than one seen before.
- **Terms and privacy** ("Villkor och integritet", dated 2026-11-20), with an open beta notice: what this server
  keeps and for how long, what other servers learn, and that each server has its own terms.

**For operators**

- **Container image and compose file** with automatic TLS (`deploy/`, `ghcr.io/hexagon/murmo:0.2`), and **static
  archives** for x86_64 and arm64 with a systemd service and SHA-256 sums. See [HOSTING.md](docs/HOSTING.md).
- **`murmo-server backup <dir>`** copies the database and host key while the server runs. `murmo-server --version`.
- **A copy of the database before a start that changes it** (`<db>.before-<version>`, kept a week).
- **A summary at start**: what is served, where the two files to back up are, and warnings for settings that look
  wrong.
- **Federation settings:** `MURMO_FEDERATION` (`open`, `off` or a list of servers) and `MURMO_FEDERATION_BLOCK`.
- **Abuse resistance:** each sender gets its own share of a device's mailbox; envelopes are acknowledged only when
  handled for good; sends are taken whole or not at all; federation has an outbox with backoff, a block list by
  host, budgets per sending server and account, bounded caches, throttled key fetches, and refuses internal
  addresses; dead connections are closed.

**Operators: anything to do?**

- **Federation is on** (`open`) after the update. Anyone who knows a user's exact identifier can reach them from
  another server, as a message request that the user must accept. If your server is meant to be private, set
  `MURMO_FEDERATION=off` (or a list of servers) before you start this version. An open server must be reachable at
  `MURMO_ORIGIN` over https from other servers, and makes outgoing https requests to them.
- **The first start changes the database** (new columns and a schema version), and copies it first to
  `murmo.sqlite.before-0.2.0`. That copy needs as much free space as the database. If it cannot be written, the
  server does not start and changes nothing. Envelopes waiting in mailboxes are kept.
- **A proxy that limits request bodies** must allow 6 MiB (rootcard's limit for identity logs). Caddy does not limit
  them. If the server prints a warning about `X-Forwarded-For`, set `MURMO_TRUST_PROXY` (usually `1`).
- **Ask users to reload** open tabs and installed apps after the update; the app offers it. Until then, a page from
  before does not know about other servers: a message from another server is lost on that device.
- **Users** see their identifier as `Name#TAG@your.host`, and that is what "Kopiera identifierare" copies. The short
  form still works on your server, and `Name#TAG@rootcard.org` still means what it meant. Existing contacts and
  conversations stay as they are.
- **A device that has not been opened for more than four weeks** gets no new messages until it is opened again (its
  prekey is too old, and senders refuse it). This is on purpose.
- **Moving to the container or to systemd** is optional: HOSTING.md says how, with the database, the host key and
  the same origin, and the way back.
