# `scripts/`

Repo maintenance and CI-gate scripts. Each entry below lists what the script
does, how it is triggered (a `package.json` command and/or a lifecycle hook),
and its co-located test.

> One-shot migration scripts (e.g. the historical `add-wave*-i18n`,
> `merge-provider-i18n`, `compute-mac-vector` helpers) are **not** kept here.
> Once a migration has run, delete its script — it is recoverable from git
> history if ever needed again.

## Build / asset scripts

| Script                              | Purpose                                                                                       | Trigger                                                                                    | Test                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `copy-monaco-assets.mjs`            | Copy Monaco's `min/vs` bundle into `public/monaco/vs` so Tauri can load it offline.           | `predev`, `prebuild` hooks; `pnpm monaco:copy`                                             | —                                                                |
| `build-vscode-ext-host-sidecar.mjs` | Install + `tsc`-build the out-of-workspace `sidecar/vscode-ext-host` Node sidecar.            | `prebuild` hook; `pnpm sidecar:vscode:build` / `sidecar:vscode:install` (`--install-only`) | —                                                                |
| `clean-stale-turbopack-cache.mjs`   | Purge `.next/dev` when it exceeds `TURBOPACK_CACHE_MAX_GB` (default 10 GB); never aborts dev. | `predev` hook                                                                              | `clean-stale-turbopack-cache.test.mjs` (`pnpm clean:cache:test`) |

## Gate / audit scripts

| Script                           | Purpose                                                                                                              | Trigger                                                        | Test                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `check-all.mjs`                  | Run every read-only CI gate in one command, continue-on-error, print a ✓/✗ summary. `--bail` stops at first failure. | `pnpm check:all`                                               | `check-all.test.mjs` (`pnpm check:all:test`)                           |
| `lint-i18n.ts`                   | Key-parity between `en.json`/`zh-CN.json` + hard-coded UI-string scan against `i18n-baseline.json`.                  | `pnpm lint:i18n`; `pnpm lint:i18n:baseline` (rewrite baseline) | `lint-i18n.test.ts`                                                    |
| `audit-plugin-slots.ts`          | Cross-check declared plugin extension-point contracts against actual `<PluginExtensionSlot>` mounts.                 | `pnpm audit:slots` (`--json` for machine output)               | `audit-plugin-slots.test.ts`                                           |
| `check-silent-failure-flags.mjs` | Enforce the `expected: !isTauri()` ↔ registered-Rust-handler contract for `plugin_*` invokes.                        | `pnpm audit:silent-flags`                                      | `check-silent-failure-flags.test.mjs` (`pnpm audit:silent-flags:test`) |
| `check-plugin-sdk-wit.mjs`       | Fail if the public `plugin-sdk` WIT mirror drifts from the canonical `src-tauri/wit` source.                         | `pnpm lint:plugin-sdk-wit`                                     | —                                                                      |

## Sync / generation scripts

| Script                    | Purpose                                                                                                       | Trigger                                                             | Test                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| `sync-models-dev.mjs`     | Download the models.dev catalog into `lib/ai/providers/models-dev-snapshot.json` (bundled fallback).          | `pnpm sync:models-dev`                                              | —                                            |
| `sync-plugin-sdk-wit.mjs` | Copy the canonical WIT contract into the `plugin-sdk` mirror (fixes drift flagged by `check-plugin-sdk-wit`). | `pnpm sync:plugin-sdk-wit`                                          | —                                            |
| `release-sync-keys.mjs`   | Propagate the Ed25519 release public key from `crates/cognia-cli` into its Rust + TS mirrors.                 | `pnpm release:sync-keys`; `pnpm release:sync-keys:check` (CI drift) | —                                            |
| `sort-i18n.mjs`           | Recursively key-sort `en.json`/`zh-CN.json` (values untouched, ICU-safe); `--check` for CI.                   | `pnpm i18n:sort`; `pnpm i18n:sort:check`                            | `sort-i18n.test.mjs` (`pnpm i18n:sort:test`) |

## Smoke scripts

| Script                | Purpose                                                                            | Trigger             | Test |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------- | ---- |
| `signaling-smoke.mjs` | Boot the standalone signaling server and drive WS clients through its guard paths. | `pnpm webrtc:smoke` | —    |

## Data / config files

| File                  | Used by                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `i18n-baseline.json`  | `lint-i18n.ts` — snapshot of grandfathered hard-coded strings.                    |
| `i18n-ignore.txt`     | `lint-i18n.ts` — paths/patterns excluded from the hard-coded-string scan.         |
| `tsconfig.audit.json` | `ts-node` project config for the TypeScript scripts (`audit:slots`, `lint:i18n`). |

## Conventions

- `.mjs` scripts are plain ESM run under bare Node; co-located tests use
  `node --test` (not Jest).
- `.ts` scripts run via `ts-node --project scripts/tsconfig.audit.json`; their
  tests are Jest (`*.test.ts`).
- A script that mutates files should be **idempotent** and offer a `--check`
  mode so it can double as a CI drift gate.
