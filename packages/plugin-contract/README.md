# @cognia/plugin-contract

The Cognia plugin contract: the plugin manifest, the `ctx.*` API surfaces and
the domain types they carry.

- The host implements it. Its `types/**` modules re-export from here.
- `@cognia/plugin-sdk` re-exports it to plugin authors.
- It imports no host source. `pnpm plugin:sdk:standalone` holds that line
  against a shrink-only baseline.

Module paths mirror the host paths the contract was extracted from, for
example `@cognia/plugin-contract/types/plugin/plugin`.
