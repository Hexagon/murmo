# Hosting Murmo

How to run your own Murmo server. Build and run it as described in the [README](../README.md#run-your-own-server); put a
TLS reverse proxy (Caddy, nginx, …) in front of it and set `MURMO_ORIGIN` to the public `https://` address.

## Configuration

Set in the environment:

| Variable | Default | Meaning |
|---|---|---|
| `MURMO_ORIGIN` | `http://127.0.0.1:8080` | public origin; must be `https://` except on loopback |
| `MURMO_OLD_ORIGINS` | empty | earlier public origins that still reach this server after a move of domain (comma-separated), see below |
| `MURMO_BIND` | `127.0.0.1:8080` | listen address (put a TLS reverse proxy in front) |
| `MURMO_DB` | `murmo.sqlite` | SQLite database |
| `MURMO_HOST_KEY_FILE` | `murmo-host.key` | rootcard host key, created on first start (back it up, keep it secret) |
| `MURMO_CLIENT_DIR` | `client` | static client to serve (empty: none) |
| `MURMO_REALM` | `global` | rootcard realm for identities registered here |
| `MURMO_REMOTE_HOMES` | `https://rootcard.org` | other homes whose identities may log in (comma-separated origins, `*` for any https host, empty for none) |
| `MURMO_REALMS` | `global` | realms accepted from other homes |
| `MURMO_TRUST_PROXY` | `0` | proxies whose `X-Forwarded-For` is believed: `0` none, `1` loopback and private networks, or a list of addresses and CIDR ranges (`10.1.2.3,fd00::/8`) |
| `MURMO_FILE_QUEUE_MB` | `150` | encrypted file chunks kept per device that is away (`0`: files only go live) |
| `MURMO_FILE_QUEUE_TOTAL_MB` | `2048` | file chunks kept in total |
| `MURMO_FILE_QUEUE_SENDER_MB` | `50` | file chunks one account may queue for one device of another account |
| `MURMO_FILE_QUEUE_ACCOUNT_MB` | `300` | file chunks one account may queue in total |
| `MURMO_RELAY_GRANTED_MB` | `1024` | MiB per minute one device may stream to devices that asked it for a file (`0`: no grants, everything on the live budgets) |
| `MURMO_RELAY_STORE_MB` | `128` | MiB per minute one account may put into the file queue |
| `MURMO_PUSH_HOSTS` | the push services of Chrome, Firefox, Safari, Edge | push-service hosts accepted for notifications (`*.` for subdomains, empty: no push) |
| `MURMO_PUSH_CONTACT` | `MURMO_ORIGIN` | contact sent to push services (`mailto:` or `https:` URL) |
| `MURMO_GIPHY_KEY` | empty | GIPHY API key; lets users search GIPHY to fill their GIF collection, directly from the browser (empty: no search). A beta key allows 100 searches an hour for the whole server |
| `MURMO_GIPHY_RATING` | `pg-13` | GIPHY content rating for searches (`g`, `pg`, `pg-13`, `r`) |
| `MURMO_BETA` | `1` | mark the service as an open beta in the client (`0`: no mark) |
| `MURMO_DEMO` | `0` | mark this server as a demo (`1`): a "Demo" mark, a notice on the login screen and a section in the terms saying that identities, messages and files may be wiped at any time, with a link to running one's own server. murmo.org runs with it |

Murmo was called mesg before. The old variable names (`MESG_…`) still work when the new ones are not set, and an
existing `mesg.sqlite` / `mesg-host.key` is used when the new default files do not exist yet.

The version shown in the app ("Säkerhet och integritet") is the commit the server was built from: `MURMO_COMMIT` or
`GITHUB_SHA` at build time, otherwise `git rev-parse HEAD`.

The `MURMO_ORIGIN` goes into users' signed rootcard logs as their home address: choose it once.

## Terms, privacy and the open beta

The client has a page "Terms and privacy" (in the page footer, at `#villkor`, on the login screen, in the account
settings and in the help): that Murmo is federated and the terms cover this server only, an open beta notice (and a
demo notice with `MURMO_DEMO=1`), a disclaimer of warranty and liability, rules of use, and what personal data the
server processes and why (the same list as [DESIGN.md §11](DESIGN.md#11-data-the-server-stores)).
The texts are written for any operator and any country: they name no person, contact or law.

Without `MURMO_BETA=0` the service is marked "Open beta" (next to the logo, on the login screen and in the terms),
which suits Murmo as long as it has not been reviewed externally. The texts are in `client/js/lang/*.js` (`beta.*`,
`terms.*`); the date they took effect is `TERMS_DATE` in `client/js/app.js`. Change both together, and check the texts
against the law where you run the server: they are a starting point, not legal advice.

## Moving to a new domain

The page's origin must be one the server knows: proofs and the WebSocket are signed for it, and the browser keeps
each origin's data (devices, conversations) apart. To move, keep the old domain pointing at the same server and set:

```sh
MURMO_ORIGIN=https://new.example          # new identities get their home here
MURMO_OLD_ORIGINS=https://old.example     # still answered: old devices keep working, old identities keep their home
```

Identities registered under the old domain keep `https://old.example/id` as their home for good (it is in their
signed log), so the old domain must keep reaching the server, at least `/id` and `/.well-known/rootcard`. Each user
moves their conversations by logging in on the new domain and approving that device on a device on the old domain:
the history is handed over as for any new device. Identities from other homes (rootcard.org) are not affected.
