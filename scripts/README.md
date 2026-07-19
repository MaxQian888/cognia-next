# `scripts/`

Repo maintenance and CI-gate scripts, grouped by function into subfolders.
Each entry below lists what the script does, how it is triggered (a
`package.json` command and/or a lifecycle hook), and its co-located test.

```
scripts/
  build/   asset copy + sidecar/CLI build steps (predev/prebuild)
  e2e/     reviewed E2E governance data
  gates/   read-only CI gates and audits
  sync/    file generators / mirrors that double as drift gates
  smoke/   standalone runtime smoke harnesses
  *.json   data + tsconfig consumed by the gate scripts (stay at root)
```

> One-shot migration scripts (e.g. the historical `add-wave*-i18n`,
> `merge-provider-i18n`, `compute-mac-vector` helpers) are **not** kept here.
> Once a migration has run, delete its script — it is recoverable from git
> history if ever needed again.

## `build/` — build / asset scripts

| Script                                    | Purpose                                                                                       | Trigger                                                                                    | Test                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `build/copy-monaco-assets.mjs`            | Copy Monaco's `min/vs` bundle into `public/monaco/vs` so Tauri can load it offline.           | `predev`, `prebuild` hooks; `pnpm monaco:copy`                                             | —                                                                      |
| `build/download-cubism-core.mjs`          | Download the Live2D Cubism Core runtime into `public/` (overridable via `CUBISM_CORE_URL`).   | `predev`, `prebuild` hooks                                                                 | `build/download-cubism-core.test.mjs`                                  |
| `build/build-vscode-ext-host-sidecar.mjs` | Install + `tsc`-build the out-of-workspace `sidecar/vscode-ext-host` Node sidecar.            | `prebuild` hook; `pnpm sidecar:vscode:build` / `sidecar:vscode:install` (`--install-only`) | —                                                                      |
| `build/clean-stale-turbopack-cache.mjs`   | Purge `.next/dev` when it exceeds `TURBOPACK_CACHE_MAX_GB` (default 10 GB); never aborts dev. | `predev` hook                                                                              | `build/clean-stale-turbopack-cache.test.mjs` (`pnpm clean:cache:test`) |
| `build/build-cli.mjs`                     | esbuild-bundle the standalone `cli/` agent into `cli/dist`.                                   | `pnpm cli:build`                                                                           | —                                                                      |

## `gates/` — gate / audit scripts

| Script                                 | Purpose                                                                                                              | Trigger                                                        | Test                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `gates/check-all.mjs`                  | Run every read-only CI gate in one command, continue-on-error, print a ✓/✗ summary. `--bail` stops at first failure. | `pnpm check:all`                                               | `gates/check-all.test.mjs` (`pnpm check:all:test`)                           |
| `gates/check-e2e-governance.mjs`       | Reject focused/vacuous E2E tests and require exact, time-bounded debt entries for skips, sleeps, and stub suites.    | `pnpm audit:e2e-governance`                                    | `gates/check-e2e-governance.test.mjs` (`pnpm audit:e2e-governance:test`)     |
| `gates/lint-i18n.ts`                   | Key-parity between `en.json`/`zh-CN.json` + hard-coded UI-string scan against `i18n-baseline.json`.                  | `pnpm lint:i18n`; `pnpm lint:i18n:baseline` (rewrite baseline) | `gates/lint-i18n.test.ts`                                                    |
| `gates/audit-plugin-slots.ts`          | Cross-check declared plugin extension-point contracts against actual `<PluginExtensionSlot>` mounts.                 | `pnpm audit:slots` (`--json` for machine output)               | `gates/audit-plugin-slots.test.ts`                                           |
| `gates/check-silent-failure-flags.mjs` | Enforce the `expected: !isTauri()` ↔ registered-Rust-handler contract for `plugin_*` invokes.                        | `pnpm audit:silent-flags`                                      | `gates/check-silent-failure-flags.test.mjs` (`pnpm audit:silent-flags:test`) |
| `gates/check-plugin-sdk-wit.mjs`       | Fail if the public `plugin-sdk` WIT mirror drifts from the canonical `src-tauri/wit` source.                         | `pnpm lint:plugin-sdk-wit`                                     | —                                                                            |

## `sync/` — sync / generation scripts

| Script                         | Purpose                                                                                                       | Trigger                                                             | Test                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| `sync/sync-models-dev.mjs`     | Download the models.dev catalog into `lib/ai/providers/models-dev-snapshot.json` (bundled fallback).          | `pnpm sync:models-dev`                                              | —                                                 |
| `sync/sync-plugin-sdk-wit.mjs` | Copy the canonical WIT contract into the `plugin-sdk` mirror (fixes drift flagged by `check-plugin-sdk-wit`). | `pnpm sync:plugin-sdk-wit`                                          | —                                                 |
| `sync/release-sync-keys.mjs`   | Propagate the Ed25519 release public key from `crates/cognia-cli` into its Rust + TS mirrors.                 | `pnpm release:sync-keys`; `pnpm release:sync-keys:check` (CI drift) | —                                                 |
| `sync/sort-i18n.mjs`           | Recursively key-sort `en.json`/`zh-CN.json` (values untouched, ICU-safe); `--check` for CI.                   | `pnpm i18n:sort`; `pnpm i18n:sort:check`                            | `sync/sort-i18n.test.mjs` (`pnpm i18n:sort:test`) |

## `smoke/` — smoke scripts

| Script                      | Purpose                                                                            | Trigger             | Test |
| --------------------------- | ---------------------------------------------------------------------------------- | ------------------- | ---- |
| `smoke/signaling-smoke.mjs` | Boot the standalone signaling server and drive WS clients through its guard paths. | `pnpm webrtc:smoke` | —    |

## Data / config files (kept at `scripts/` root)

These are data/config, not scripts, so they stay at the root where the gate
scripts and the `protect-generated-files` hook reference them by path.

| File                  | Used by                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `i18n-baseline.json`  | `gates/lint-i18n.ts` — snapshot of grandfathered hard-coded strings.                                                                      |
| `i18n-ignore.txt`     | `gates/lint-i18n.ts` — paths/patterns excluded from the hard-coded-string scan.                                                           |
| `tsconfig.audit.json` | `ts-node` project config for the TypeScript gates (`audit:slots`, `lint:i18n`); `include` globs `./**/*.ts` so it reaches the subfolders. |

`e2e/governance-exceptions.json` is the reviewed debt ledger consumed by
`gates/check-e2e-governance.mjs`. Counts are exact and entries expire for
review; it is not a general ignore file.

## Conventions

- `.mjs` scripts are plain ESM run under bare Node; co-located tests use
  `node --test` (not Jest).
- `.ts` scripts run via `ts-node --project scripts/tsconfig.audit.json`; their
  tests are Jest (`*.test.ts`).
- A script that mutates files should be **idempotent** and offer a `--check`
  mode so it can double as a CI drift gate.
- Scripts derive the repo root from their own location (`__dirname`); after the
  move that is two levels up (`../..`). Keep that in mind when adding a script.
