# Hosting Murmo

How to run your own Murmo server: with containers (below), or from source as described in the
[README](../README.md#from-source), behind a TLS reverse proxy (Caddy, nginx, …) with `MURMO_ORIGIN` set to the public
`https://` address.

## Quick start

On a machine with Docker and the compose plugin, whose ports 80 and 443 are reachable from the internet:

1. Point the DNS name of your server (`chat.example.org`) at the machine.
2. Get `deploy/` from this repository, `cp .env.example .env`, and set `MURMO_DOMAIN` in `.env`.
3. `docker compose up -d`

Caddy gets the certificate on first start, and Murmo answers at `https://chat.example.org`. The database and the host
key are in the volume `murmo-data` (or in `MURMO_DATA`, below). The image is `ghcr.io/hexagon/murmo`, for amd64 and
arm64, published for every release: `0.2.3`, `0.2` and `latest`. The compose file runs `0.2` (`MURMO_IMAGE`). Until a
release has been tagged, build the image yourself in the repository and point `.env` at it:

```sh
docker build --build-arg MURMO_COMMIT=$(git rev-parse HEAD) -t murmo .
echo MURMO_IMAGE=murmo >> deploy/.env
```

**Updating:** `docker compose pull && docker compose up -d`. Patches come with the pull. For a new minor version, read
its notes and then change `MURMO_IMAGE`. Pages that are already open offer a reload when the build changes.

**A proxy of your own:** if the machine already has nginx or Caddy on ports 80 and 443, leave the bundled Caddy out
and publish Murmo on `127.0.0.1:8080` (`MURMO_PORT` changes the port), as a binary would listen:

```sh
docker compose -f compose.yaml -f compose.own-proxy.yaml up -d murmo
```

`MURMO_TRUST_PROXY=1` is set, so `X-Forwarded-For` is taken from proxies on private networks, which includes the host
as the container sees it.

## Backups and updates

Two files hold everything: the database (`MURMO_DB`) and the host key (`MURMO_HOST_KEY_FILE`). The server prints
both at start, with what it serves:

```text
murmo-server 0.2.0 (commit 2517ee6…)
  origin      https://chat.example.org
  listening   0.0.0.0:8080
  database    /data/murmo.sqlite
  host key    /data/murmo-host.key   (back up these two: murmo-server backup <dir>)
  federation  open
  client      /app/client (build 0.2.0-…)
```

It warns when a setting looks wrong: an `http://` origin while it listens beyond loopback, no client where
`MURMO_CLIENT_DIR` points, or requests with `X-Forwarded-For` while `MURMO_TRUST_PROXY=0`. `murmo-server --version`
prints the version and commit.

**Backup:** `murmo-server backup <dir>` writes `murmo.sqlite` and `murmo-host.key` into a new or empty directory,
readable by their owner only. It is safe while the server runs: the database is copied in one read transaction
(`VACUUM INTO`), never torn. Run it with the server's environment, so that it finds the same files:

```sh
docker compose exec murmo murmo-server backup /data/backup-$(date +%F)   # in the container: lands in MURMO_DATA
MURMO_DB=… MURMO_HOST_KEY_FILE=… murmo-server backup /var/backups/murmo  # a binary
```

Copy the directory off the machine. Copying `murmo.sqlite` itself with `cp` while the server runs is not safe.
A backup holds the encrypted envelopes and file chunks that were waiting at the time, and the host key: keep it as
secret as the server, and not longer than you need it.

**Restore:** stop the server, put both files in place of the old ones (with their `-wal` and `-shm` files removed),
give them to the user the server runs as, start. Envelopes that arrived after the backup and were not yet fetched
are lost. History is on the devices, not in the database, so it is not affected.

**Updates:** before a start that changes the database's schema, the server copies the database to
`<db>.before-<version>` and says so. It keeps the newest two copies, each for at most a week (they hold waiting
envelopes, DESIGN.md §11). If the copy cannot be written (a full disk), the server changes nothing and does not
start. To go back after an update: stop the new version, put that copy in place of the database, start the old one.
What arrived in between is lost. A database from a newer version is warned about at start, not refused.

The server never asks anyone whether there is a new version. Watch the releases on GitHub (Watch → Custom →
Releases); every release says whether operators need to do anything.

## Without containers

Every release has static server archives for Linux, which need nothing installed, and a systemd service:

1. Download `murmo-<version>-x86_64-linux-musl.tar.gz` (or `aarch64` for arm64) and `SHA256SUMS` from the release on
   GitHub, and check it: `sha256sum -c SHA256SUMS --ignore-missing`. The sums are in the release notes too.
2. Unpack it to `/opt/murmo`:
   `sudo mkdir -p /opt/murmo && sudo tar -xzf murmo-*-linux-musl.tar.gz -C /opt/murmo --strip-components=1`
3. `sudo mkdir -p /etc/murmo && sudo cp /opt/murmo/deploy/murmo.env.example /etc/murmo/murmo.env`, and set
   `MURMO_ORIGIN` in it.
4. `sudo cp /opt/murmo/deploy/murmo.service /etc/systemd/system/ && sudo systemctl enable --now murmo`
5. Put your TLS proxy in front of `127.0.0.1:8080` (see "A reverse proxy of your own" below). `journalctl -u murmo`
   shows what the server printed at start.

The service runs as a user systemd makes for it (`DynamicUser`), with the database and host key in `/var/lib/murmo`,
and may write nowhere else. The client is found next to the executable, in `/opt/murmo/client`.

**Updating:** check and unpack the new archive in place of `/opt/murmo`, then `sudo systemctl restart murmo`. The
server copies its database first if the update changes it (see "Backups and updates").

**From a binary started by a script:** stop it cleanly, and copy its `murmo.sqlite` (with `murmo.sqlite-wal` if there
is one) and `murmo-host.key` to `/var/lib/murmo` before the first `systemctl start`. systemd gives them to the
service's user. Its `MURMO_*` settings go into `/etc/murmo/murmo.env`, except `MURMO_DB` and `MURMO_HOST_KEY_FILE`.
The rest is as in "Moving to the container" below: the same origin, the old files kept as the way back.

**Checking what a server serves:** the client archive `murmo-client-<version>.tar.gz` is made reproducibly
(`scripts/release-archives.sh --client-only` at the release's tag makes the same bytes). Its files are what a server
of that release serves under `/`. The app shows the version and commit, and for a release build it links the release
page ("Säkerhet och integritet").

## A reverse proxy of your own

Murmo listens on plain HTTP (`MURMO_BIND`, `127.0.0.1:8080` by default) and needs a proxy in front for TLS. The proxy
must pass the WebSocket upgrade on `/api/v1/ws`, allow request bodies of 6 MiB (rootcard's limit for identity logs;
deliveries from other servers take up to 3 MiB), and set `X-Forwarded-For`, which Murmo believes only with
`MURMO_TRUST_PROXY` (`1`: proxies on loopback and private networks).

Caddy:

```text
chat.example.org {
	reverse_proxy 127.0.0.1:8080
}
```

nginx (with a certificate already set up, for example by certbot):

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name chat.example.org;
    # ssl_certificate …; ssl_certificate_key …;

    client_max_body_size 6m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;   # the WebSocket stays open
    }
}

# In the http block:
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

The server warns, at most once an hour, when requests carry `X-Forwarded-For` while no proxy is trusted.

## Moving to the container

From a server that runs the binary from a script or a service. What must come along is the **database**
(`murmo.sqlite`, with its `murmo.sqlite-wal` if there is one), the **host key** (`murmo-host.key`), and the
**origin**. The origin is in every user's signed identity log, and the host key signs this server's federation
requests and rootcard receipts. A new database or a new key is a new server: accounts, devices and waiting
messages are gone, and other servers see a different key. Settings stay as they were.

1. **Write down the settings** the script sets (`MURMO_*`). `MURMO_DOMAIN` is the host of today's `MURMO_ORIGIN`
   (only `https://` on port 443 works with the compose file). Put everything else into `.env`, except `MURMO_ORIGIN`,
   `MURMO_DB`, `MURMO_HOST_KEY_FILE`, `MURMO_BIND` and `MURMO_CLIENT_DIR`: the image has its own paths.
2. **Stop the old server** (SIGTERM or Ctrl-C, not `kill -9`). It closes the database, so that everything is in
   `murmo.sqlite` and the `-wal` file is gone. Never copy the database while a server is running: the copy can be
   torn. Make sure that the script, or a service manager, does not start the server again.
3. **Copy, do not move**, into the data directory, and give it to the user the server runs as (uid 65532):

   ```sh
   sudo mkdir -p /srv/murmo
   sudo cp -p murmo.sqlite murmo.sqlite-wal murmo-host.key /srv/murmo/   # the -wal file only if it exists
   sudo chown -R 65532:65532 /srv/murmo && sudo chmod 700 /srv/murmo && sudo chmod 600 /srv/murmo/murmo-host.key
   ```

   Files still named `mesg.sqlite` and `mesg-host.key` (from before the rename) get the new names in the copy. The
   old files stay where they are, as the way back.
4. **Point `.env` at it:** `MURMO_DATA=/srv/murmo`. A directory is easier to back up and inspect than a named
   volume. To use the volume instead, copy the files into it with a throwaway container.
5. **Start**: `docker compose up -d` (or with `compose.own-proxy.yaml`, if the old proxy stays). Then check that
   the move worked: `federation.key` and `push_key` in `https://<domain>/api/v1/info` must be the same as before
   the move. If they are new, the server started without the old files: stop it and check the path and the owner.

The server is away for as long as it takes to copy the files. Clients reconnect on their own. Other servers keep
what they could not deliver and try again (§14.3 in DESIGN.md).

**The way back**, if something is wrong: `docker compose down`, then start the old script again. If the new server
has run for a while, stop it first, then copy the database and key back from `/srv/murmo` (and give them back to
the user the script runs as), so that what came in meanwhile is not lost. That is only safe if the image is the same version as the binary. A newer version can change the database at start
(it copies it first, see above), and an older binary might not understand the change. So for the move itself, use
the image of the version the binary already runs, and update afterwards.

## Configuration

Set in the environment:

| Variable | Default | Meaning |
|---|---|---|
| `MURMO_ORIGIN` | `http://127.0.0.1:8080` | public origin; must be `https://` except on loopback |
| `MURMO_OLD_ORIGINS` | empty | earlier public origins that still reach this server after a move of domain (comma-separated), see below |
| `MURMO_BIND` | `127.0.0.1:8080` | listen address (put a TLS reverse proxy in front) |
| `MURMO_DB` | `murmo.sqlite` | SQLite database |
| `MURMO_HOST_KEY_FILE` | `murmo-host.key` | rootcard host key, created on first start (back it up, keep it secret) |
| `MURMO_CLIENT_DIR` | `client` | static client to serve (empty: none); unset, `client` in the working directory, else next to the executable |
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
| `MURMO_FEDERATION` | `open` | other Murmo servers this one exchanges messages with: `open` (any public https server with a domain name), `off`, or a comma-separated list of origins (DESIGN.md §14) |
| `MURMO_FEDERATION_BLOCK` | empty | servers never to exchange messages with (comma-separated origins or host names; each also blocks its other ports and subdomains) |
| `MURMO_DEMO` | `0` | mark this server as a demo (`1`): a "Demo" mark, a notice on the login screen and a section in the terms saying that identities, messages and files may be wiped at any time, with a link to running one's own server. murmo.org runs with it |

Murmo was called mesg before. The old variable names (`MESG_…`) still work when the new ones are not set, and an
existing `mesg.sqlite` / `mesg-host.key` is used when the new default files do not exist yet.

The version shown in the app ("Säkerhet och integritet") is the commit the server was built from: `MURMO_COMMIT` or
`GITHUB_SHA` at build time, otherwise `git rev-parse HEAD`.

The `MURMO_ORIGIN` goes into users' signed rootcard logs as their home address: choose it once.

## Federation

Murmo servers exchange messages with each other: a user on your server writes to `Name#TAG@other.example`, and your
server delivers the encrypted envelopes there ([DESIGN.md §14](DESIGN.md#14-federation)). Nothing needs to be set up
for it: the server signs its deliveries with a key derived from `murmo-host.key` and publishes it in `/api/v1/info`.
Your server must be reachable at `MURMO_ORIGIN` over https from the other servers, and it makes outgoing https
requests to them.

- `MURMO_FEDERATION=open` (the default): any public https server. Block abusive ones with `MURMO_FEDERATION_BLOCK`.
- A list of origins, for a group of servers that know each other (a family's, a club's).
- `off`: a private island, as before federation.

Files go between servers too. Your server's file limits (`MURMO_FILE_QUEUE_*`, `MURMO_RELAY_STORE_MB`) apply to
what comes from other servers as to your own users, and are announced in `/api/v1/info`, so that senders elsewhere
keep within the smaller of both servers' limits.

What changed for servers that ran a version before federation is in [CHANGELOG.md](../CHANGELOG.md) (0.2.0), as is
what to do for every release.

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
