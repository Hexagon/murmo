# Contributing to Murmo

Issues and pull requests are welcome. Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

This file is how the project works, for people and for coding agents alike ([AGENTS.md](AGENTS.md) adds only what is
specific to agents). What is planned, and in which order, is in [docs/PLAN.md](docs/PLAN.md).

## Where things are

```
server/   the Rust server: rootcard home, device lists, WebSocket mailbox, file relay, federation, bridge (optional)
client/   the web client: js/protocol.js protocol, js/core.js engine, js/app.js interface, js/lang/ texts;
          bridge/ the bridge's pages (texts in bridge/lang.js)
docs/     DESIGN.md (protocol), THREAT_MODEL.md, HOSTING.md (operators), PLAN.md (roadmap)
deploy/   compose files, Caddyfile, systemd service
tests/    protocol, end-to-end, federation and browser smoke tests (Node)
fuzz/     cargo-fuzz targets
scripts/  release archives
```

## Checks

CI (`.github/workflows/ci.yml`) runs these, and a change is ready when they pass locally:

```sh
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build && npm ci && npm test       # Node 22+; the end-to-end tests start the debug server
```

The browser smoke test needs Chrome and a running server; the setup is at the top of `tests/ui-smoke.mjs`
(`npm run test:ui`). CI also builds the container image. Fuzzing: `cd fuzz && cargo +nightly fuzz run ws_frame`.

## Rules of the code

- **The client has no build step and no dependencies.** Plain ES modules: edit and reload. Dev dependencies in
  `package.json` are for tests only.
- **Vendored code stays unmodified.** `client/vendor/rootcard` is rootcard from npm, `client/vendor/qrcode` is
  qrcode-generator from npm; versions and hashes are in their READMEs. Update them whole, never patch them.
- **The server stores as little as possible.** Anything new it keeps, even in memory, is declared in `DESIGN.md` §11,
  in the threat model where it matters, and in the terms (`terms.privacy.*` in every language, with `TERMS_DATE` in
  `client/js/app.js` moved).
- **No `unsafe`** in the server (forbidden by its lints), and **no `unwrap`** (a clippy warning, which CI turns into
  an error): handle the error, or use `expect` with a reason in tests.

## Texts and documents

- **Every user-visible text is in all four languages**, `client/js/lang/{en,sv,de,es}.js`, with the same meaning and
  the same numbers. The files keep the same keys on the same lines. `tests/i18n.test.mjs` checks keys and
  placeholders, not meaning.
- **Documents state what the code does.** DESIGN, THREAT_MODEL, HOSTING, the README, the in-app help and the terms
  are what users and operators decide on: a claim about limits, retention or what the server learns is checked
  against the code, and changes with it. Name the place in the code (`ws.rs:36`, `WRITES_TTL`) when it helps a
  reviewer.
- **Settings are documented twice:** the table in `docs/HOSTING.md` ("Configuration") and the module docs of
  `server/src/lib.rs`. Change both.
- English documents use the English UI labels ("Security and privacy"), not the Swedish ones.

## Commits, pull requests, plan and changelog

- **One topic per pull request.** The title says what changes for users or operators, in plain words, and names the
  plan item when there is one: `Accessibility and polish: … (phase 2 item 2)`. Pull requests are squash-merged.
- **`docs/PLAN.md`:** tick the item a change completes, in the same pull request, with a short note of how; add what
  a review finds and leaves open.
- **`CHANGELOG.md`:** anything users or operators notice goes under "Unreleased", sorted into "For users" and
  "For operators". Every release says **Operators: anything to do?**, also when the answer is no.

## Releases

1. Set the version in `Cargo.toml` (and `Cargo.lock`: `cargo build`).
2. Turn "Unreleased" in `CHANGELOG.md` into `## <version> (<date>)`.
3. Merge, then tag `v<version>` on `main` (or make the release on GitHub, which makes the tag).

The release workflow refuses a tag that is not the version in `Cargo.toml` or has no CHANGELOG section. It publishes
the server archives, the reproducible client archive, `SHA256SUMS` and the container image (`<version>`,
`<major>.<minor>`, `latest`).

## License

Contributions are under the project's licenses, [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at the user's
option.
