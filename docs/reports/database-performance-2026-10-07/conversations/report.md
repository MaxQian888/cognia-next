# Conversation database performance — 2026-10-07

Retained one change: `listWorkspaceSessions` identifies workspace-less conversations using existing primary-key/project indexes, then loads only those candidates. The old fallback decrypted every session with a row cursor merely to inspect `projectId`. No schema, index, stored row, write-path or retention policy changes.

## Measured result

Final evidence is `production-baseline.json` and `production-after.json`. Both use real headless Chromium 151 IndexedDB, Dexie 4.4.6 constructor defaults, actual AES-256-GCM account cipher and production encrypted-content middleware. Function bodies are extracted from owning source, bundled/minified with `NODE_ENV=production`, and source hashes are saved. The benchmark uses an isolated synthetic account/database and no user data.

Machine: Apple M4 Pro (14 cores), 48 GB RAM, macOS 26.5.2. Power mode 0; thermal state not controlled. Other agents' heavy work was held during the final measurement window. Each row below has two warmups and 12 samples before and after, same fixture/command/cache conditions.

| Complete database API workload                                          | Before median / MAD | After median / MAD |        Improvement | Verdict                                                         |
| ----------------------------------------------------------------------- | ------------------: | -----------------: | -----------------: | --------------------------------------------------------------- |
| Workspace conversation/message totals, 1,000 sessions / 20,000 messages |    103.85 / 5.60 ms |    12.70 / 0.50 ms |   91.15 ms, 87.77% | Keep                                                            |
| Workspace conversation list, same mixed workspace fixture               |    102.05 / 3.95 ms |     6.65 / 0.15 ms |   95.40 ms, 93.48% | Keep                                                            |
| Conversation list, all 1,000 sessions workspace-less                    |     94.80 / 6.30 ms |    29.75 / 1.00 ms |   65.05 ms, 68.62% | Guardrail passes                                                |
| Totals, single conversation / 20 messages                               |        0.30 / ~0 ms |     0.40 / 0.05 ms | **0.10 ms slower** | Within preregistered max(10%, 1 ms) guardrail; no speedup claim |

Every claimed improvement exceeds both the 10% practical threshold and twice the larger MAD. The 1,000-session mixed fixture spans four workspaces plus 20 workspace-less rows, with subagent/embedded visibility cases. The count API returns exactly 242 visible conversations and 4,840 messages on both implementations; list API returns all 265 matching rows before exposure filtering. Session prompts contain 2 KiB; each message has 256 text characters. All-workspace-less parity checks all 1,000 IDs and their order.

These are database API results, not React render time, UI time-to-interactive, a full production application build, mobile performance, Tauri WebView performance, or network sync throughput. Full UI flow was not exercised by this harness. The optional diagnostics wrapper is a direct call in the harness; actual exposure filtering, encryption and storage operations run unchanged.

## Correctness and resource guardrails

- Existing plus added co-located session/message tests: **196 tests pass**, two suites (`tests.log`). Added regressions preserve missing, null and empty-string workspace IDs; equal-timestamp scoped-first / unscoped-primary-key ordering; workspace moves; and prevent loading unrelated session bodies. A pre-existing test's 5 ms wall-clock ordering assumption was replaced with an explicit fixture timestamp.
- Real encrypted Chromium check passes: legacy ID ordering, workspace enters/leaves fallback, title edit, five liveQuery emissions, and locked account read rejection (`production-after.json`, `correctness` field). The readonly transaction covers key enumeration and legacy-row fetch, preventing a membership race within that fallback.
- Other workspace sessions remain excluded; embedded/subagent exposure remains the existing predicate. No mutation or schema migration is added. Account cipher validation remains active on index and row reads.
- No application storage growth, retained cache or new persistent metadata. Extra transient allocation is two primary-key arrays plus a Set, O(total sessions). An all-workspace-less database still returns all rows and now decrypts them as a bulk read; peak native crypto/JS memory was **not** measured, so no memory improvement or constant-memory claim is made.

## Investigation map

- `hooks/chat/use-sessions.ts` reads workspace sessions for the sidebar and messages for the selected session. `components/artifacts/workspace-mode/project-overview-panel.tsx` uses `countWorkspaceConversations` in a live query, so both consumers reach this change without new wiring.
- `lib/db/messages.ts` already uses `[sessionId+createdAt]` for full and bounded-tail transcript reads. Streaming writes preserve cached row timestamps, diff references, serialize per database/session, maintain media references and transcript revisions, and check the runtime ownership generation. None of those semantics were changed.
- `hooks/chat/use-claude-chat-controller.ts` and the existing coalescing path write streaming checkpoints and final transcripts to that repository. ADR-0127 documents its coalescing contract; ADR-0144 documents workspace ownership and the shared visibility of workspace-less rows.
- ADR-0116 separates host-authoritative session intent/queues/revisions from historical transcript pages and table replication. This change is limited to renderer Dexie session listing; it does not claim native SQLite, host RPC or sync transport speedups.

## Rejected experiments

1. Grouping session reads and message counts in one transaction failed to complete on real encrypted Chromium (`transaction.json`, CDP `Promise was collected`). Rejected; the broad transaction change is absent. The underlying parallel encrypted-cursor interaction was not independently diagnosed.
2. Grouping only message counts in one transaction: 107.85 → 107.05 ms, under 1% and within noise (`baseline.json`, `counts-only.json`). Removed; it did not meet the retention rule.
3. Initial cache-disabled measurement of the retained keyset change was 106.55 → 13.75 ms. Those files remain diagnostic; final claims above use rerun pairs with the actual CogniaDB constructor defaults.

## Reproduce

From repository root (no application dev server needed):

```sh
rtk node docs/reports/database-performance-2026-10-07/conversations/build-harness.mjs production-baseline docs/reports/database-performance-2026-10-07/conversations/baseline-source.txt
rtk node docs/reports/database-performance-2026-10-07/conversations/build-harness.mjs production-after
rtk python3 -m http.server 8936 --bind 127.0.0.1 --directory /tmp/cognia-conversation-perf
```

In a separate terminal, use one isolated agent-browser session. Navigate to each generated HTML, then collect the same evaluation:

```sh
rtk agent-browser --session cognia-conversation-perf open http://127.0.0.1:8936/production-baseline.html
rtk agent-browser --session cognia-conversation-perf eval 'window.runBenchmark().then(async counts => ({ counts, lists: await window.runListBenchmark() }))' --json
rtk agent-browser --session cognia-conversation-perf open http://127.0.0.1:8936/production-after.html
rtk agent-browser --session cognia-conversation-perf eval 'window.runBenchmark().then(async counts => ({ counts, lists: await window.runListBenchmark(), correctness: await window.runCorrectness() }))' --json
rtk pnpm exec jest lib/db/sessions.test.ts lib/db/messages.test.ts --runInBand --silent
rtk agent-browser --session cognia-conversation-perf close
```

The harness deletes only its own synthetic benchmark database after each workload. Temporary bundles remain under `/tmp/cognia-conversation-perf`. Saved source snapshots and raw samples make the original comparison reproducible without reversing the source edit. No wall-clock assertion was added to CI.
