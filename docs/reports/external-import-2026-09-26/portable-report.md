# Shared portable history indexing and native format fixes — 2026-09-26

## Measured boundary

The shared reader serves Cursor, Cline, Copilot CLI and Qwen Code. Its existing scan-input cache avoided repeat file reads but every selected conversation still rebuilt parent and canonical-ID maps over the full corpus. Three lookup indexes now live inside that same weakly held, run-scoped cache. Failed reads evict their promise; new scan inputs rebuild from fresh files. Child ordering, duplicate-merge behavior and output fidelity remain unchanged.

Pre-registration: `portable-contract.md`; reproducible actual-source harness: `portable-measure.mjs`. The harness reads real temporary JSON files with Node fs and runs production list/read/parse/graph code; it does not measure Tauri IPC, UI rendering or destination persistence. All fixtures are synthetic and contain no user data. It times complete discovery plus every listed root graph. Two warmups and twelve alternating AB/BA measured pairs; all complete outputs compare by SHA-256. GC and output hashing are outside timed intervals. Samples and machine metadata are recorded in JSON; do not infer tail latency from twelve samples.

Performance-only snapshot `portable-indexed.ts` is the candidate measured in `portable-results.json`, before native compatibility changes. Its 3000-file workload (2500 roots plus500children) fell from1073.027ms to169.100ms (84.24%); MAD15.376/14.712ms, clearing >=10% and >2maxMAD. Retained output/cache heap19,521,780→19,755,672bytes (+1.2%). 20000-message guard55.338→58.267ms (+5.29%); large-tool guard68.462→68.329ms; small guard0.327→0.340ms. No single-long-session or large-tool speedup claim. The final-source re-run is `portable-final-results.json`: many1664.922→372.566ms (**77.62% reduction**), MAD86.970/78.117ms; median delta1292.356ms exceeds2maxMAD173.940ms. Retained heap19,441,148→19,817,208bytes (+1.93%). Long70.515→70.547ms; large-tools79.733→79.487ms; small1.376→1.439ms: all non-target guards pass. The later machine interval is visibly slower/noisier, so the final77.62% is the supported claim, not the earlier84.24%. Full output SHA-256 equality passed every iteration. Final helper hash is `3d4548442c982a53c96307d6397b232dc67c7b08819ff26b5d86605a4b507997`.

Focused adapter validation: `portable-tests.log` and `portable-lint.log`; compatibility fixture source hashes are recorded in `portable-compat-source-hashes.json`. Final post-Copilot-legacy-ID/Cline timestamp regression checks in `portable-final-tests.log`: **6 suites / 50 tests passed**, including shared index integration. ESLint and scoped diff-check passed. No full-app typecheck, desktop E2E, or destination-database benchmark is claimed.

## Compatibility fixes (separate from optimization equality)

- Qwen: native ChatRecord JSON/JSONL Content.parts, UUID fragments, thought/text, binary/file attachments, function calls and results, source usage/model, native parent-session/fork metadata and latest title. Includes `.qwen/projects` in default roots. Off-root distinctive native files match structurally. Parent traversal starts at the last physical conversation record, excluding artifact-only rows, and stops at a missing parent/cycle with explicit losses. Inactive leaf branches are archived separately; their synthetic IDs carry no native resume binding. Checkpoint/rewind/compaction markers preserve their source metadata as diagnostics and are not claimed to restore the source runtime.
- Cline: raw Anthropic message arrays now attach nested tool_result blocks to prior calls, including errors, multiple results, full large structured successful outputs and mixed user text. Unmatched results become explicit bounded diagnostic losses. Native `<id>.messages.json` identities and ApiMessage `ts` timestamps are retained without overriding explicit legacy IDs/timestamps.
- Copilot CLI: persisted SDK assistant.message toolRequests, complete tool results/errors and reasoning are normalized; ephemeral captured chunks do not become duplicate complete turns. Agent-scoped messages become separate child transcripts with no synthetic native resume binding. Tool start/progress and other unmodeled events remain bounded diagnostics with explicit losses.
- Legacy portable JSON/JSONL/Markdown exports retain their existing path; compatibility hooks run only when configured for a source. Cursor proprietary SQLite schema handling is outside this helper and outside these format claims.

## Evidence limits

These are parser contracts derived from primary source schemas and synthetic fixtures, not authenticated external-runtime E2E acceptance. Environment-relocated Qwen runtime roots, arbitrary proprietary Cursor database schemas, encrypted stores, Cline UI ask/say-only streams, and future native records are not claimed universally supported. Unknown native runtime/system metadata remains bounded and redacted with a loss record; it cannot recreate file checkpoints, live processes, or scheduler state. Qwen branch snapshots can duplicate their shared ancestors because each imported branch is a complete readable transcript.

## Primary sources inspected on 2026-09-26

- Qwen ChatRecord and metadata writers: https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts
- Qwen leaf selection, fragment aggregation, missing-parent behavior: https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/utils/transcript-records.ts
- Qwen project/chat roots: https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/config/storage.ts
- Copilot persisted/ephemeral event envelope, tools and agentId: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events
- Copilot local store layout: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
- Cline local SDK sessions: https://docs.cline.bot/cline-sdk/sessions
- Cline native session metadata/storage interface: https://github.com/cline/cline/blob/main/sdk/packages/core/src/session/services/session-service.ts
- Cursor history and Markdown exports: https://docs.cursor.com/en/agent/chat/history
