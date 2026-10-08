# Follow-up verification — 2026-10-08

Scope: `lib/collab/shared-chat-sync.ts`, `lib/collab/shared-chat-sync.test.ts`, `lib/db/session-attachment-uploads.ts`, `lib/db/session-attachment-uploads.test.ts`, and the two follow-up experiment directories. Existing account-sync/WebSocket changes from the first round and unrelated shared-tree edits were preserved. Current HEAD during final validation: `5f6760382213f58cf9614caa1c7d0f3ea90a9709`. No commit, push, schema migration, production setting change or deployment was performed.

## Correctness

```sh
rtk pnpm exec jest lib/collab/shared-chat-sync.test.ts lib/db/session-attachment-uploads.test.ts lib/companion/attachment-upload-client.test.ts lib/account-sync/data/capture-middleware.test.ts lib/db/message-sync-revision.test.ts lib/db/encrypted-content-middleware.test.ts lib/plugin/api/session-api.test.ts lib/collab/shared-chat-conversion.test.ts lib/db/collab-chat-mirror.test.ts lib/db/message-media-refs.test.ts --runInBand
```

Observed output:

```text
Test Suites: 10 passed, 10 total
Tests:       239 passed, 239 total
Snapshots:   0 total
Time:        12.786 s
```

After correcting two test-only TypeScript assertions for the middleware-added `syncRevision` property, the complete shared-chat suite was rerun:

```text
Test Suites: 1 passed, 1 total
Tests:       70 passed, 70 total
Time:        5.673 s
```

The 70 tests are a subset of the 239, not additional unique coverage. Raw command output is retained at `/tmp/cognia-transfer-followup-tests.log` and `/tmp/cognia-transfer-followup-shared-final.log`.

New regression cases cover bounded catch-up batches and exact event/revision order; intermediate metadata capture with and without hooks; hook-observed intermediate database snapshots; failure of a later batch rolling back earlier messages, clocks, account outbox, field clocks, events, references and cursor; adjacent concurrent attachment chunks; and overlapping abort without resurrection. Baseline batch-budget and concurrent-append tests failed before their respective changes. An intermediate candidate failed transaction-lifetime/rollback tests and was corrected before the accepted benchmark.

Native Chromium additionally exercised encrypted CogniaDB catch-up, creating-hook row mutations, repeated corrections/redaction, second-batch rollback, byte-for-byte attachment transfer, reopen/resume, adjacent appends and overlapping abort. These checks use isolated synthetic databases, never the user's application database. Raw evidence lives in the corresponding experiment directories.

Independent read-only correctness review and the co-located-test auditor found no unresolved blocking finding in the four-file scope. No new UI, production module, Node dependency, route, model call or Rust source was added in this follow-up; their specialized auditor triggers are absent. Coverage was not requested and was not run.

## Static checks

- Scoped ESLint across all four changed source/test files: exit 0.
- Scoped Prettier: `All matched files use Prettier code style!`
- Scoped `git diff --check`: exit 0.
- `pnpm lint:i18n`: key parity, referenced-key validation and hardcoded-string baseline passed.
- `pnpm i18n:sort:check`: both generated locale files passed; this task did not edit translations.

The initial `rtk pnpm typecheck` shortcut exited 134 with a JavaScript heap exhaustion at roughly 4 GiB. Its compact output incorrectly said `No errors found`; the exit code and raw tee log were inspected and that attempt was **not** counted as passing. The repository script was rerun through `rtk proxy env NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck`, allowing its configured 16 GiB TypeScript stage to run. The first complete diagnostic found two new test-assertion typing errors; both were corrected and the check was repeated. Final diagnostics are retained at `/tmp/cognia-transfer-followup-typecheck-final.log`.

The final typecheck exited 2, with no diagnostic in this task's changed files:

```text
lib/db/mobile-outbound-queue.test.ts(9,3): error TS2305: Module '"./mobile-outbound-queue"' has no exported member 'countByStatus'.
lib/tauri/transport-companion.test.ts(3006,73): error TS2353: Object literal may only specify known properties, and 'sent' does not exist in type 'Promise<string>'.
```

The mobile-outbound test was concurrently modified outside this task and this diagnostic appeared in the final run. The transport-companion expression is present in HEAD, independently verified with `git show`, and was already recorded in the first round. The script's webclone build precheck reported up-to-date outputs; its later sidecar typecheck was not reached because the main TypeScript stage failed. Neither full typecheck nor full lint is claimed to pass.

Full repository lint remains blocked outside this task:

```text
components/chat/composer.tsx:2928 — Cannot access refs during render
src-tauri/resources/plugins/cognia-office/dist/index.js — generated vendor-code lint errors
✖ 4934 problems (82 errors, 4852 warnings)
```

These same failures were recorded in the first round. No global autofix or unrelated edits were made. The full log is `/tmp/cognia-transfer-followup-lint.log`.

## Bounds of the result

Accepted timings are native-browser local transfer/projection measurements with frozen baselines, alternating samples, exact-content guards and explicit noise rules. No physical two-device run, WAN/relay/packet-loss experiment, Tauri/Capacitor package, application UI rendering, complete production build, or remote service authorization flow was exercised. Background shared-chat search indexing is excluded. Attachment storage still copies/writes the growing accumulated body; other upload lifecycle race boundaries remain unchanged. Test success is evidence for the exercised cases, not a guarantee about every platform or concurrent user modification.

Both dedicated browser sessions and loopback servers were closed. Reproducible bundles remain under task-specific `/tmp` directories; raw evidence and source snapshots are retained in the report tree.
