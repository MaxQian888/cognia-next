---
"cognia-next": patch
---

`cognia plugin new --yes` now works as documented. Previously `--yes` ("pre-confirm every interactive prompt … required for CI") was ignored by the scaffolder, so on a TTY it still asked all six questions. It now resolves every field from its default without prompting — kind `wasm`, a generated description, the git author name — and, crucially, follows the non-TTY default of **not** generating a signing key, so `--yes` never mints an Ed25519 key you didn't ask for. The plugin name still must be passed explicitly (it has no sensible default).
