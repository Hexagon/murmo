# Changelog

What changed in each release, and what someone who runs a Murmo server has to do about it. The newest first. Every
release has a line **Operators: anything to do?**, also when the answer is no. The details of every change are in the
git history.

Before a release is tagged, "Unreleased" becomes `## <version> (<date>)`: the release workflow refuses a tag without
its section and puts the section in the release notes.

## Unreleased

**For users**

- **Invite links and QR codes.** "Invite someone" gives a link with your address, a QR code, and a text to send.
  Opening the link fills in a new conversation, and nothing is sent without a tap. The help explains what a link
  shows and what it does not prove.
- **Messages that did not arrive are shown.** Texts are kept until they are delivered, held ones get a pending mark,
  and failed ones a "not delivered" mark. A lost connection shows a banner.
- **Questions before deleting** a conversation, blocking someone, or removing a device. Storage and background
  errors are shown instead of being lost.
- **Safer against a hostile server:** each device pins its own account's device list, a forked list stops
  receiving as well as sending, and senders refuse prekeys older than four weeks or older than one seen before.
- **The terms changed** (dated 2026-11-20). They now say what other servers learn when you send a file, that your
  server keeps in memory which devices on other servers you write to (a week after last use), and that a copy of the
  database made before an update is kept for at most a week.

**For operators**

- **Container image and compose file** with automatic TLS (`deploy/`, `ghcr.io/hexagon/murmo`), and **static
  archives** for x86_64 and arm64 with a systemd service and SHA-256 sums. See [HOSTING.md](docs/HOSTING.md).
- **`murmo-server backup <dir>`** copies the database and host key while the server runs. `murmo-server --version`.
- **A copy of the database before a start that changes it** (`<db>.before-<version>`, kept a week).
- **A summary at start**: what is served, where the two files to back up are, and warnings for settings that look
  wrong.
- **Abuse resistance:** each sender gets its own share of a device's mailbox; envelopes are acknowledged only when
  handled for good; sends are taken whole or not at all; federation has an outbox with backoff, a block list by
  host, budgets per sending server and account, bounded caches, throttled key fetches, and refuses internal
  addresses; dead connections are closed.

**Operators: anything to do?**

- **The first start changes the database** (new columns and a schema version), and copies it first to
  `murmo.sqlite.before-<version>`. That copy needs as much free space as the database. If it cannot be written, the
  server does not start and changes nothing.
- **A proxy that limits request bodies** must allow 6 MiB (rootcard's limit for identity logs), not 3 as HOSTING.md
  said before. Caddy does not limit them.
- If the server prints a warning about `X-Forwarded-For`, set `MURMO_TRUST_PROXY` (usually `1`).
- Ask users to reload open tabs and installed apps after the update; the app offers it.
- A device that has not been opened for more than four weeks gets no new messages until it is opened again (its
  prekey is too old, and senders refuse it). This is on purpose.

## 0.2.0 (2026-11-17): federation

Murmo servers exchange messages and files with each other (`Name#TAG@host`), with terms for a federated service and
an open beta notice.

**Operators: anything to do?**

- **The database** gets a column for the server an envelope came from (`mailbox.origin`), added at the first start.
  Envelopes waiting in mailboxes are kept. Nothing else is migrated, and no new file needs a backup.
- **Federation is on** (`open`) after the update. Anyone who knows a user's exact identifier can reach them from
  another server, as a message request that the user must accept. Nobody can search for them. If your server was
  meant to be private, set `MURMO_FEDERATION=off` (or a list) before you start the new version.
- **Users** see their identifier as `Name#TAG@your.host`, and that is what "Kopiera identifierare" copies. The short
  form still works on your server, and the old form for identities from rootcard.org (`Name#TAG@rootcard.org`) still
  means what it meant.
- **Existing contacts and conversations** stay as they are: a contact without a server is on this server.
- **Pages opened before the update** do not know about other servers. Until they are reloaded (the app offers it when
  the build changes), a message from another server is lost on that device, and a contact on another server added from
  another own device does not work there. Ask users to reload open tabs and installed apps after the update.
- **The terms** ("Villkor och integritet") are new, dated, and apply from the day they took effect. Existing users
  see them under the login, in the help and in the settings.
