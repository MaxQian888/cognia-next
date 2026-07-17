---
"cognia-next": patch
---

`cognia plugin lint`'s capability↔field cross-check now matches the app. The Rust CLI's `CAPABILITY_FIELDS` table had drifted from the TS `PLUGIN_CAPABILITY_CONTRACTS`: it emitted a bogus `field_missing` warning on the api-only `themes` capability (which the app suppresses), and silently missed the four `balance-adapter` / `limits-source` / `im-rate-source` / `compaction-strategy` capabilities the app flags. Reconciled to the contract and pinned by a parity test so the fourth whitelist can no longer drift unguarded.
