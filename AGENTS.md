# Instructions for coding agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) first: the checks, the rules of the code, texts and documents, and how
commits, the plan and the changelog are kept apply to agents as to everyone. This file adds only what is specific to
agents. What to work on is in [docs/PLAN.md](docs/PLAN.md).

- **Run the checks before you say a change is done**, and report them as they came out: `cargo fmt --all --check`,
  `cargo clippy --all-targets -- -D warnings`, `cargo test`, `cargo build && npm test`. For a change to texts only,
  `node --test tests/i18n.test.mjs tests/code.test.mjs` is enough. Say which you did not run and why.
- **Check a fact in the code before you write it** in a document or a UI text, and give `file:line` (or the constant)
  in the commit message or pull request, so that a reviewer can check it too. Do not copy numbers from one document
  to another: they have been wrong before.
- **A text change is four edits**, one per language in `client/js/lang/`. Translate the meaning, keep the numbers,
  and keep the key on the same line in every file.
- **Privacy and security statements** (what the server keeps or learns, forward secrecy, recovery) are decisions of
  the maintainer: propose the wording and wait for approval before changing what the app promises.
- **Never edit `client/vendor/`**, and do not add dependencies to the client or the server without asking.
- **Do not change the protocol or the database schema** (envelope versions, signed structures, SQL tables) unless the
  task is about that; such changes go through `docs/DESIGN.md` first.
- Write in the project's style: plain words, short sentences, no marketing; English documents use English UI labels.
