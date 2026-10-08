# Follow-up verification — 2026-10-08

## Retained scope

- `lib/sync/host-state-service.ts`: use the existing pending/sending status index for optimistic projection, retaining protocol/channel checks, action validation and primary-key order for equal client sequences.
- `lib/sync/host-state-service.test.ts`: two ordering/filtering regression cases, including exact queue preservation and confirmed versus optimistic state.
- `lib/sync/host-state-dispatcher.test.ts`: repair an existing stale mock and call expectation so the dispatch gate can run against the current transcript-preparation contract. No production dispatch change.
- Evidence under this report directory. The account-applier key-cache experiment was rejected and its source/test hunks completely removed. The deletion shortcut was rejected before implementation because it would remove old-body authentication.

The shared dirty tree began at `5f6760382213f58cf9614caa1c7d0f3ea90a9709`. Prior-round and concurrent changes were preserved. No commit, schema migration, dependency, protocol, UI or storage-encryption-policy change was made by this follow-up.

## Passing checks

Final combined Jest: **9 suites / 181 tests passed**, exit 0, 16.551 seconds:

```sh
rtk proxy pnpm exec jest lib/sync/host-state-service.test.ts lib/sync/host-state-store.test.ts lib/sync/host-state-dispatcher.test.ts lib/sync/host-state-intent-settlement.test.ts lib/db/mobile-outbound-queue.test.ts lib/account-sync/data/applier.test.ts lib/account-sync/data/op-origin.test.ts lib/account-sync/data/sync.integration.test.ts lib/account-sync/data/sync-round.test.ts --runInBand
```

Log: `/tmp/cognia-sync-round4-tests-final.log`. This includes the restored account-applier implementation, not the discarded key-cache candidate. The candidate's earlier 41-test result must not be added to this total.

The initial broader run had 180 passes and one failure: `prepareTranscriptRuntimeSend is not a function` in the dispatcher fixture. That test mocked only the older `buildSendOptions` export and expected an older `sendPrompt` options shape. The fixture now supplies transcript preparation, asserts its session/message context and the prepared-send flag, and checks that unsupported runtimes never invoke it. Production code for this path was unchanged. Initial log: `/tmp/cognia-sync-round4-tests.log`.

- Scoped ESLint on all three retained files: exit 0.
- Scoped Prettier check on all three retained files: exit 0.
- Scoped `git diff --check`: exit 0.
- `rtk proxy pnpm lint:i18n`: exit 0; parity, referenced keys and the hardcoded-string gate passed. Log: `/tmp/cognia-sync-round4-i18n.log`.
- `rtk proxy pnpm i18n:sort:check`: exit 0. Log: `/tmp/cognia-sync-round4-sort.log`.
- Read-only co-located-test audit: no blocking gap, including the repaired dispatcher test.
- Native HostState benchmark: one warmup and ten alternating measured samples per variant/workload, plus lock/cancellation guards. Exact visible/durable state, template parameters, full queue digest, RPC count and wire-byte parity pass. See [report](host-state-pending/report.md).
- Final retained production source is byte-identical to the measured frozen source; SHA-256 `7852228c36c7acaa89dd0695ac3289abef9a31b1928ec4720079758e345cf9ee`. Account applier and its test have no retained Git diff.
- Dedicated browser sessions and loopback servers were closed. Isolated benchmark databases were removed after each sample.

## Global gates still blocked

The repository's full high-memory typecheck script was rerun after the dispatcher fixture repair and exited 2 with the same unrelated diagnostic:

```text
lib/tauri/transport-companion.test.ts(3006,73): error TS2353: Object literal may only specify known properties, and 'sent' does not exist in type 'Promise<string>'.
```

Command: `rtk proxy pnpm typecheck`. Final log: `/tmp/cognia-sync-round4-typecheck-final.log`. No retained-file diagnostic appeared; the following sidecar typecheck did not execute after main TypeScript failed.

`rtk proxy pnpm lint` exited 1 with **82 errors / 4,852 warnings**, including previously observed composer and generated Office plugin errors. Log: `/tmp/cognia-sync-round4-lint.log`. Scoped lint was rerun after the only subsequent edit, the dispatcher test fixture, and passed.

No coverage run, production/native package build, physical device pairing, Tauri/Capacitor, WAN/relay, UI-rendering, battery, peak-memory or tail-latency validation was performed. No whole-repository green claim is made. These are local apply-path improvements; neither transfer bandwidth nor network latency was reduced.
