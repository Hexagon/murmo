# Changelog

What changed in each release, and what someone who runs a Murmo server has to do about it. The newest first. Every
release has a line **Operators: anything to do?**, also when the answer is no. The details of every change are in the
git history.

Before a release is tagged, "Unreleased" becomes `## <version> (<date>)`: the release workflow refuses a tag without
its section and puts the section in the release notes.

## Unreleased

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
