# Validation scope — 2026-10-07

## Production change boundaries

- `lib/account-sync/data/pusher.ts`: move the existing 512-row limit into the IndexedDB query, retaining the bulk-read path when there are no skipped rows and applying the skip filter before the limit otherwise.
- `crates/cognia-companion-bus/src/event_batcher.rs`: borrow the frames while serializing the same WS envelope. JSON object property order can change; decoded content, field names, byte lengths and frame order remain equivalent.
- All other additions are tests, opt-in experiments, baseline evidence or reports. No schema, endpoint, feature flag, timer, encryption, batching policy, authority or UI change.

## Reviewed compatibility cases

| Boundary                                                            | Evidence                                                                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Bounded outbox result                                               | New 1/300/600-row tests; 600-row case was observed failing before the source edit                                                   |
| Oversized prefix does not starve later valid data                   | New 513-oversized-row prefix test                                                                                                   |
| Concurrent local edit during a push survives settlement             | Existing pusher test retained and passed                                                                                            |
| Lost acknowledgment / sequence already stored                       | Existing pusher and sync-round tests retained and passed                                                                            |
| Encrypted replica convergence                                       | Existing sync integration suite retained and passed                                                                                 |
| Event payload compatibility and routing privacy                     | New parsed-envelope parity test: empty/single/multiple, nested escaped Unicode, numeric boundaries, omitted device-routing metadata |
| Event ordering, immediate first frame, window and byte/frame bounds | Existing EventBatcher tests retained and passed                                                                                     |
| Benchmark data integrity                                            | Native browser decrypts every operation; reducer checks all sample counts, operation counts and byte equality                       |

Two read-only scoped reviews found no actionable compatibility regression; the dedicated test-gap audit found no missing co-located tests. The scope contains no frontend `.tsx`, translation edits, new app route, production Node import, model call, or new runtime initializer. The corresponding i18n/static-export/PII/wiring change audits have empty trigger sets.

## Executed focused checks

- Account pusher / sync-round / sync integration: **37 passed, 1 opt-in benchmark skipped**. Output: `account-sync/correctness.log`.
- Companion bus release suite: **141 passed, 1 manual benchmark ignored**; event-specific tests: **12 passed**. Release Clippy across crate targets with `-D warnings` and source rustfmt check passed. Details: `event-batching/report.md`.

## Broader gates (run after timing finished)

| Command / scope                                                                                                                             | Actual result                                                                                                         | Evidence              |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Jest: Companion WS/RTC transports, sync orchestration/base handler/history, remote messages/attachments, HostState store/service (9 suites) | `Test Suites: 9 passed, 9 total` / `Tests: 661 passed, 661 total`                                                     | `regression.log`      |
| `pnpm typecheck`                                                                                                                            | Exit 2; main TypeScript check failed in an unchanged transport test, so the later sidecar typecheck stage did not run | `typecheck.log`       |
| `pnpm lint`                                                                                                                                 | Exit 1; `4934 problems (82 errors, 4852 warnings)` in two paths outside this task                                     | `lint.log`            |
| ESLint on the changed pusher source/test and three report helper scripts, `--max-warnings=0`                                                | Exit 0, no output                                                                                                     | `scoped-lint.log`     |
| `pnpm lint:i18n`                                                                                                                            | Exit 0; key parity and referenced keys pass; hardcoded strings `75 (≤ baseline 370)`                                  | `i18n-lint.log`       |
| `pnpm i18n:sort:check`                                                                                                                      | Exit 0; both generated locale files `ok`                                                                              | `i18n-sort.log`       |
| Prettier on changed TS and helper scripts                                                                                                   | `All matched files use Prettier code style!`                                                                          | Executed scoped check |
| `git diff --check` on the three changed source/test paths                                                                                   | Exit 0, no findings                                                                                                   | Executed scoped check |

Exact workspace type failure:

```text
lib/tauri/transport-companion.test.ts(3006,73): error TS2353: Object literal may only specify known properties, and 'sent' does not exist in type 'Promise<string>'.
```

The same mock expression exists in the initial baseline revision, verified with `git show afae6923dc9d4a579d11eb8c07a23d977e0dc6a3:lib/tauri/transport-companion.test.ts`. The runtime suite passes, but that does not make its TypeScript error disappear.

The full lint failures are `components/chat/composer.tsx:2928` (`react-hooks/refs`, ref assignment during render) and generated `src-tauri/resources/plugins/cognia-office/dist/index.js` (vendor-bundle errors/warnings). Neither was edited by this task. The composer changed concurrently relative to the initial baseline. These failures are recorded, not suppressed or repaired as unrelated work.

The shared branch advanced to `5f6760382213f58cf9614caa1c7d0f3ea90a9709` during this task. Task-owned source hunks remained present after validation. No commits were made by this task. Coverage was not requested and was not run.

## Unverified surfaces

No physical paired-device run, WAN/relay packet-loss test, Tauri/Capacitor package build, phone thermal/battery measurement, complete Next.js production build, deployed sync service load test or UI-render benchmark was run. The native browser test measures the real pusher with native IndexedDB/WebCrypto and a minimal isolated schema; the separate fake-indexeddb test exercises CogniaDB and captured writes. Neither alone proves end-to-end network latency or every shell's performance.
