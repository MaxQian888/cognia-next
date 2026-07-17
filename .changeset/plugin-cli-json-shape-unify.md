---
"cognia-next": patch
---

`cognia plugin lint --json` now emits one payload shape across success and input-failure: both carry a camelCase `manifestPath` (was `manifest_path` on success — the lone snake_case key — and `path` on failure) and an always-present `stage` (`"validate"` or `"input"`), so a CI consumer reads the same keys either way. Separately, `cognia plugin info --json` no longer reports `ok: true` for a bundle whose signature it just proved invalid — `info --json | jq -e .ok` now fails on a tampered bundle, matching `verify` (info is an inspection, not a gate, but must not vouch for a bundle it flagged).
