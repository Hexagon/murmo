# Security policy

Murmo Secure Messenger is end-to-end encrypted software, so we take reports about weaknesses seriously, and we are
grateful for them.

> **Status:** Murmo 0.1 and rootcard 0.3 are early versions that have not been reviewed by anyone outside the project.
> Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for what Murmo is meant to protect, against whom, and what it
> accepts.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub: on the repository page, open **Security → Report a vulnerability** (a private
security advisory). Only the maintainers can see it.

Please include, as far as you can:

- what is affected (client, server, protocol, or rootcard) and which version or commit;
- what an attacker can do, and under which conditions (for example a malicious server, a network attacker, another
  user, or someone with access to a device);
- steps or code to reproduce it.

Write in English or Swedish.

## What happens next

- We aim to acknowledge a report within **7 days**.
- We keep you informed while we confirm the problem and work on a fix.
- We publish a fix and an advisory together, and credit you unless you ask us not to. We ask you to wait with public
  disclosure until a fix is available, or 90 days after the report, whichever comes first; we can agree on another
  timeline together.

## Scope

In scope:

- the Murmo client (`client/`) and server (`server/`);
- the protocol described in [docs/DESIGN.md](docs/DESIGN.md): device lists, prekeys, message encryption and
  signatures, safety codes, device linking and file transfer;
- anything that lets the server, the network, or another user read or forge messages, add a device, learn more than
  [docs/DESIGN.md §11](docs/DESIGN.md) says the server learns, or bypass the message-request rules.

Limits that the threat model already accepts — for example that a web app is delivered by its server, or that an
unlocked, compromised device can read its messages — are not vulnerabilities in themselves, but ideas for narrowing
them are welcome as ordinary issues.

Problems in rootcard itself belong to the rootcard project; if you are unsure where a problem lies, report it here and
we will pass it on.

## Supported versions

Murmo is pre-1.0: only the latest commit on `main` receives security fixes.
