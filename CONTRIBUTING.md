# Contributing to Murmo

Thank you for wanting to help. Murmo is small and early, and issues, bug reports, translations and pull requests are
all welcome.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Security problems

**Do not open a public issue or pull request for a vulnerability.** Report it privately as described in
[SECURITY.md](SECURITY.md).

## Issues

- Search the existing issues first.
- For a bug: what you did, what you expected, what happened, and the browser, operating system and Murmo version or
  commit. Never paste passwords, recovery cards, paper keys or message contents.
- For a larger feature or a protocol change, open an issue to discuss it before writing code. Changes to the protocol
  must fit [docs/DESIGN.md](docs/DESIGN.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Development setup

Requirements: Rust 1.95+, Node 22+ and a modern browser.

```sh
git clone https://github.com/Hexagon/murmo.git
cd murmo
cargo run            # open http://127.0.0.1:8080
```

The client (`client/`) is plain ES modules with no build step: edit and reload. The layout of the repository is
described in the [README](README.md#development).

## Before you open a pull request

Run the same checks as CI:

```sh
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build && npm ci && npm test
npm run test:ui      # browser smoke test, see tests/ui-smoke.mjs for setup
```

Guidelines:

- **Keep it small.** One change per pull request, with a clear description of what and why.
- **Add or update tests** for what you change: Rust tests in `server/`, protocol and end-to-end tests in `tests/`.
- **No new dependencies without discussion.** The client deliberately has no dependencies and no build step besides
  the vendored, unmodified rootcard core (`client/vendor/rootcard`); do not edit it.
- **Keep the documentation in step.** A change to the protocol, to what the server stores or learns, or to the
  threat model updates [docs/DESIGN.md](docs/DESIGN.md) or [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) in the same
  pull request. Settings for server operators go in [docs/HOSTING.md](docs/HOSTING.md).
- **Texts in the interface** live in `client/js/lang/`. A new or changed text needs every language (`en`, `sv`, `de`,
  `es`) with the same placeholders; `tests/i18n.test.mjs` checks this. If you cannot translate it, use the English text
  and say so in the pull request.
- **Privacy first.** The server should keep as little as possible: no logs of who talks to whom, no plaintext, nothing
  beyond what [DESIGN.md §11](docs/DESIGN.md) lists.

## Translations

New languages and fixes to existing ones are very welcome. Copy `client/js/lang/en.js`, translate the values (keep the
`{placeholders}` and `<0>…</0>` marks as they are) and register it in `client/js/i18n.js` and `tests/i18n.test.mjs` next to the others.

## License

Murmo is licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option. Unless you say otherwise,
any contribution you submit is licensed the same way, without any additional terms or conditions.
