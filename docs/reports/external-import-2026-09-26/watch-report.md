# Existing-source watch correctness — 2026-09-26

This change repairs live-sync delivery and routing for the existing source registry. It does not add sources or claim a desktop end-to-end latency improvement.

## Correctness changes

- Native debounce retains all distinct paths, rather than only the last file in a burst. The payload carries `paths` and `rescan`; the controller also accepts legacy `path` events.
- Native input queue and pending distinct-path set each cap at 256 entries. Overflow and notify rescan/error signals trigger a full scan. A sentinel wake after overflow prevents the flag from being stranded if the consumer drained the queue concurrently.
- Quiet debounce remains 300 ms, with a 2,000 ms maximum batch duration so continuous writes cannot indefinitely postpone sync. These are scheduling bounds, not measured UI latency guarantees.
- Stop/replacement drops the OS watcher and aborts its debounce task; stale frontend callbacks are ignored. Frontend subscribes before native start so the first native batch has a listener.
- Frontend path jobs cap at 256 queued paths per workspace, followed by a coalesced full scan. Later events join that pending scan; events arriving while a scan is executing enqueue a trailing read. Workspace identity is part of queue keys.
- Cursor `.vscdb`, `.vscdb-wal`, `.vscdb-shm` changes are accepted alongside the existing SQLite suffixes.
- Watch roots include Claude's configured vendor root (teams/tasks as well as transcripts), `.copilot` (session-store DB), `.cursor`, and `.cline` (native stores), while preserving external platform-specific roots. Redundant nested scan roots are omitted from the native watch request.
- Single-file parsing is limited to accepted transcript extensions under actual scan roots. Broad Claude vendor settings/plugins events are ignored; empty configured roots use the same home-directory fallback as the adapter.
- Successful native watch installation performs one asynchronous guarded catch-up scan, covering offline/crash gaps without waiting for a new filesystem event. Retargeting does not repeat it; native `false` (no roots installed) releases the listener and skips catch-up.
- Picked Claude transcripts no longer fall back to unselected local team/task files when the selection contains no matching auxiliary artifacts. Desktop scans continue to read local auxiliary data.
- Claude teams/tasks changes route to Claude's source-wide graph import and bypass transcript watermarks. They are never handed to the single-transcript parser. Ordinary transcript changes retain the narrow path.

## Verification

- `rtk node_modules/.bin/jest lib/session-import/registry.test.ts lib/session-import/watch-import.test.ts lib/session-import/watch-controller.test.ts lib/session-import/adapters/claude-code.test.ts --runInBand --no-coverage`: **4 suites, 96 tests passed**. `watch-tests.log` is the actual captured output.
- Production Rust collector/filter helpers and their inline tests are compiled by `watch-verify.py`: **8 tests passed**, including distinct paths, overflow, continuous writes and channel close. `watch-rust-tests.log` records the actual result and source SHA-256 hashes.
- Scoped ESLint, Prettier and `git diff --check` passed.

The Rust harness extracts the production helper code verbatim, removing only Tauri-specific state/command/emitter glue and the idle-state test. It is deliberately not represented as a full Tauri build, real notify OS-event test, or desktop import/persistence E2E run. Missing vendor directories remain uninstalled at watch start; installing a new agent later requires restarting the watch. Aider remains picker-only as declared by its adapter.
