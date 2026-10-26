# Chromium preview resize and lifecycle repair

Date: 2026-10-21 (Asia/Shanghai)

## Scope and adversarial review

Repairs the right-side local Chromium preview, including the shared Chromium and user-Chrome rendering path. No commit was requested or created. Unrelated shared-worktree edits are preserved.

The initial independent review found seven actionable issues: startup without a frame/viewport barrier; trailing-debounce starvation; instance-only resize queues and lost final updates after failure; retained media state; capture-generation/ACK races; late decode/listener callbacks and early input-coordinate changes; exact-width subscriptions for a binary layout decision. All were reconciled against the source and addressed. A second independent review found no new substantive blocker. The user explicitly skipped additional cross-model CLI review. i18n, test-gap, and runtime-wiring auditors found no missing integration; their test-strength findings were addressed.

## Changes

- `components/browser/local-chromium-preview.tsx`: hides the canvas on initial/page-generation setup; accepts frames only after the actual viewport request succeeds and a matching frame beyond the capture fence is available. Retains a candidate that arrives before the RPC response. Retires the previous painter on page/session changes. Updates input dimensions only after a successful canvas draw. Uses the existing threshold-width hook for rail placement.
- `lib/browser/local-viewport-scheduler.ts`: new module because resize coordination must outlive a preview remount and belongs neither to the input queue nor the painter. A shared session tail guarantees one in-flight resize across consumers. First dispatch is immediate; later dispatches have a fixed 50 ms minimum interval, coalesce to the latest dimensions, and send the final size. Failed final measurements retry at most three times without requiring another observer notification. Disposal suppresses queued work and callbacks. Partial failures invalidate the previous size cache.
- `lib/browser/frame-painter.ts`: optional eligibility check before and after async decode, plus a successful-paint notification. Keeps the existing latest-wins queue and `ImageBitmap.close()` in `finally`.
- `hooks/browser/use-local-browser-session.ts`: releases an event listener whose asynchronous registration completes after unmount, and suppresses late frame callbacks from a disposed session generation.
- `services/workspace-runtime/src/browser-service.mjs`: serializes capture attach/stop, retires state before asynchronous cleanup, detaches after stop failure, and verifies ownership after asynchronous attach. Frame sequences are runtime-wide monotonic, preventing a late ACK from matching a retargeted or recreated capture. Initial viewport synchronization returns a fresh-frame fence and restarts capture even at unchanged dimensions. Lifecycle subscriptions preserve the existing event sink. Failed creation/disconnection cleanup protects replacement sessions from old asynchronous cleanup.
- `services/workspace-runtime/src/runtime-server.mjs`: generation-bound media publishers, global HTTP cursors, lifecycle-driven release, waiter cleanup and shutdown disposal. Closing a session releases its last JPEG; old publishers cannot recreate released state or overwrite replacement generations. Old pending reads terminate on release.

The existing 24-byte binary frame protocol, raw Tauri IPC, Retina capture, and bounded decoder queue are retained. Simultaneously visible independent panes still share the active page under the existing ADR-0214 architecture; this task does not create a multi-view browser protocol.

## Verification evidence

Evidence lives under `.cache/chromium-resize-analysis/`.

- Behavioral red checks captured initial resize delay, zero intermediate updates during a 960 ms drag, 60 unnecessary body renders, stale ACK reuse, missing capture cleanup, missing post-decode guards, and late session callbacks before their fixes.
- Component regression verifies intermediate updates during 60 observations at 16 ms, exact final size, no preview-body rerender within one placement tier, default-frame suppression, same-size page-switch protection, and the frame-before-RPC race.
- Scheduler tests cover cross-remount serialization, latest-wins, cancellation/hidden measurements, retry cap, no-notification recovery, and uncertain partial RPC failure.
- Runtime tests cover failed/late capture starts, close during attach, detach after stop failure, replacement sessions, media lifecycle events, stale publishers, waiter abort/timeout, and old HTTP cursors.
- Post-GC controlled retention experiment: 16 closed sessions × 1 MiB each retained 16,777,216 bytes before the fix; after the fix, retained payload and growth across those 16 sessions are both 0. This is a deterministic media-store experiment, not the user's process RSS.
- Actual Chromium service fixture: after session close, the former media endpoint now returns 204 and 0 bytes, instead of returning its previous 54,411-byte frame.
- Final focused frontend regression: 6 suites, 103 tests passed. Full workspace-runtime suite: 181 tests, 180 passed, 1 skipped, 0 failed.
- Typecheck, ESLint, i18n lint, locale sorting and scoped formatting checks passed. No coverage command was run.
- `lint:static-export` is blocked by the unchanged `lib/browser/extension-engine.ts:450` import of `node:fs/promises`. `git diff HEAD -- lib/browser/extension-engine.ts` is empty. No Node import was added by this task.

## Real Tauri verification

Stopped at the user's explicit request. Native UI acceptance remains unverified; do not treat the runtime fixture above as native UI acceptance.

The initial Turbopack development launch did not complete page compilation. A Webpack launch then encountered `ENOSPC` during cache writes. Only regenerable build caches were removed; source, uncommitted work, built binaries and dependency artifacts were preserved. Webpack was selected through a temporary agent-debug `beforeDevCommand` override, then the original configuration was restored. Rust/Tauri built successfully and the agent-debug bridge started. The fixed runtime source was explicitly staged again before browser testing.

The warmed Webpack frontend returned HTTP 200, and the built Tauri binary started with an authenticated agent-debug bridge. The main webview remained hidden/loading before helper readiness, while cache writes repeatedly encountered `ENOSPC`. No successful real-panel drag, first-frame, or native session-close UI acceptance is claimed. The tracked native process, task-owned frontend server and disposable fixture server were stopped. The temporary cache symlink was removed. No further real-environment verification will be run under this request.
