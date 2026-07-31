---
"cognia-next": minor
---

New `cognia plugin doctor [--fix] [--json]` command — a one-shot health check of the build toolchain (`cargo-component`, `wasm32-wasip2`, `node`), the desktop bridge, and — inside a plugin directory — the signing-key gitignore invariant and a manifest lint. Toolchain gaps are advisory unless the current project actually needs them (a `wasm` plugin missing its toolchain hard-fails); an exposed private signing key or a manifest with lint errors always fails. `--fix` runs the safe idempotent remedies (`rustup target add`, gitignore the key) and surfaces the exact command for the rest. Every template's next-steps now points at it, and the wasm template's next-steps no longer skip `lint`.
