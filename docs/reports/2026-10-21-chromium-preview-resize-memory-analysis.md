# Chromium preview resize and memory analysis

Date: 2026-10-21 (Asia/Shanghai)
Scope: analysis of the right-side local Chromium preview. The user clarified that the lag occurs while dragging the panel divider. No production code was changed or committed.

## Findings

| Finding                                                         | Evidence                                                                                                                                                                                                                          | Confidence and limits                                                                                                                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup uses a fixed landscape viewport before panel adaptation | Real local browser service starts at 1280×720; the first captured frame has the same CSS dimensions. Shared-session creation supplies density but no viewport. Preview sizing waits for ready, then uses a 100 ms trailing timer. | Confirmed ordering; explains an initial landscape picture fitting into a differently shaped panel. The actual Tauri visual transition was not captured.                                        |
| Continuous dragging starves viewport updates                    | Actual preview component, with its runtime RPC mocked: 60 size changes at 16 ms intervals (960 ms) send zero viewport updates during the drag and one after release.                                                              | Confirmed responsiveness defect. The debounce is restarted on every measurement, including unchanged measurements. This establishes stale page sizing, not a measured desktop frame-rate drop. |
| Width measurement causes work throughout dragging               | React Profiler around the actual preview recorded 60 commits for 60 toolbar width observations while the toolbar stayed in the same wide tier.                                                                                    | Confirmed unnecessary commits at this component seam; total desktop cost still needs profiling.                                                                                                |
| Closed sessions retain their last JPEG in the runtime           | Real Chromium session closed successfully, but its media endpoint still returned its final 54,411-byte frame. Isolated real runtime-server test retained all 16 closed sessions' 1 MiB frames after forced GC.                    | Confirmed session-lifetime memory leak. Retention scales with distinct session IDs, not every frame in one session. This is separate from the immediate drag problem.                          |

## Call path and owning code

1. components/browser/local-chromium-preview.tsx: SharedChromiumPreview → useSharedLocalBrowser → LocalPreviewBody.
2. lib/browser/shared-local-browser.ts: ensureSharedLocalBrowser creates the shared session with render density but no initial viewport. subscribeSharedFrames multiplexes one native subscription.
3. hooks/browser/use-shared-local-browser.ts: ensures a page, activates it, navigates the initial URL, then clears restoring.
4. LocalPreviewBody's sizing effect (line 416) runs only when ready. measure (line 461) clears the timer on every observation and schedules flush 100 ms later (line 480). Continuous observations prevent the timer firing.
5. The canvas (line 856) uses object-contain. A landscape bitmap preserves its aspect ratio inside a portrait/narrow box until a correctly sized replacement frame arrives.
6. browser.emulate → Rust browser_local_rpc → runtime-server dispatcher → RemoteChromiumService.emulate. The service applies page.setViewportSize, Emulation.setDeviceMetricsOverride, and fitPageToWidth when enabled.
7. Chromium JPEG → runtime MediaLatestStore → Rust long poll → Tauri raw Channel → decodeRemoteBrowserFrame → createFramePainter → canvas.

## Why resizing can feel stuck

The panel's CSS box changes during the drag, but Chromium's CSS viewport does not. The old bitmap is repeatedly fitted into the changing canvas box; the web page only reflows after dragging pauses for 100 ms and the RPC and replacement frame complete. This is trailing debounce starvation, rather than an ever-growing resize queue: the queue already serializes requests and coalesces pending measurements.

There is additional React work: LocalPreviewBody reads exact toolbar width through useElementWidth (line 384) solely to decide side versus bottom rail placement. The hook stores changes of at least 0.5 px. BrowserToolbar independently observes the same ref to select its tier. The diagnostic kept the tier wide throughout but still observed 60 preview-subtree commits. Reuse a threshold-based observation for the parent's binary placement decision; hooks/use-element-width-fits.ts already provides that seam. This count does not establish the desktop frame-time contribution.

High-density capture can amplify costs, but has not been established as the primary cause. Local capture has no maxWidth/maxHeight and captures every compositor frame at quality at least 80; the service launches at the maximum connected display density, capped at 4. At DPR 2, an 800×1000 CSS canvas has a 1600×2000 bitmap, about 12.2 MiB for one RGBA backing store. That is expected allocation, not proof of a leak. Frame acknowledgement occurs after the Rust Channel send, before renderer decode/draw completes, so renderer-side IPC backlog remains a profiling target.

## Confirmed leak and its boundary

services/workspace-runtime/src/runtime-server.mjs:361 defines MediaLatestStore. Its frames and sequence Maps gain a key for each session. publish replaces the latest frame for an existing key, which bounds frames within one session. There is no removal operation. The browser.session.close dispatcher at line 214 calls browser.closeSession without clearing media state, and the server does not clear media on a session.closed event. The same omission applies to expiry/disconnection paths; they also need lifecycle cleanup. Timeout-only media reads can additionally leave empty waiter Sets behind.

Two probes distinguish this from normal Chromium caching:

- Real Chromium: after browser.session.close, browser.sessions.has(id) is false, yet GET /v1/media/:id?after=0 returns 200 and the identical final 54,411 bytes.
- Isolated media-store lifecycle: actual createRuntimeServer, deterministic browser producer stub, 1 MiB per frame. Publishing 32 times to one session retained approximately one frame. Creating and closing 16 further session IDs left activeSessions=0, but all 16 media endpoints still returned their frames. After repeated forced GC, arrayBuffers increased by exactly 16,777,216 bytes across those 16 sessions.

The 16 MiB figure is a controlled fixture result, not the user's measured memory consumption. The real service sample retained roughly 53 KiB for that one closed page. A long-lived shared session replaces one retained frame; repeated session creation/closure is needed for this leak to grow. A runtime process exit releases the store.

The canvas painter itself has a bounded latest-wins queue (one decode plus one waiting frame), closes each ImageBitmap in finally, and clears its waiting frame on dispose. Five existing painter tests passed. This is evidence against an obvious unbounded painter queue, not a substitute for a WKWebView heap/native-memory profile.

## Measurements and verification

- Actual preview diagnostics: initial viewport RPC count at 16 ms = 0; 960 ms sustained drag RPC count = 0; after release = 1. Two assertions intentionally failed to capture the reported responsiveness defects.
- Profiler diagnostic: 60 commits across 60 width ticks, wide → wide; assertion passed. It runs in jsdom, so no desktop FPS inference is made.
- Existing Jest suites: preview, frame painter, shared browser — 3 suites, 67 tests passed. The preview suite prints an existing collisionPadding DOM-prop warning.
- Existing runtime suites: browser-service-local and runtime-server — 59 tests passed.
- Real browser fixture: installed Chrome for Testing 148.0.7778.96, launched through the repository's Playwright dependency and real RemoteChromiumService in local mode, DPR 2, isolated temporary profile and local HTML page. Twenty rapid viewport RPCs had median 9.47 ms and maximum 16.58 ms after the cold-build process was stopped. This excludes Rust IPC, WKWebView drawing, and the user's page; it is not an end-to-end latency benchmark. The temporary profile, fixture server, runtime, and Chromium were closed.
- Tauri bridge was initially unavailable. A managed debug launch entered a cold Rust build. It was stopped before app startup, so native UI, real drag FPS, and WKWebView heap behavior remain unverified. The regular stop command could not stop a pre-endpoint build; the exact process group started by this session was terminated and verified absent.
- No production-code edits; no lint/typecheck/build needed for this analysis-only report. No coverage run.

Evidence files in .cache/chromium-resize-analysis/:

- viewport-probe.log and viewport-probe.test.tsx: diagnostic source and output; the temporary source was removed from components/browser after execution to avoid leaving intentionally failing tests in the normal suite.
- runtime-probe.mjs, runtime-probe.json: actual browser service experiment.
- media-retention-probe.mjs, media-retention-probe.json: deterministic media lifecycle and post-GC measurement.
- existing-tests.log and runtime-tests.log: existing-suite output.

Commands executed:

```sh
rtk pnpm test --runInBand --runTestsByPath components/browser/local-chromium-preview.diagnostic.test.tsx -t 'diagnostic:'
rtk proxy node --expose-gc .cache/chromium-resize-analysis/runtime-probe.mjs
rtk proxy node --expose-gc .cache/chromium-resize-analysis/media-retention-probe.mjs
rtk pnpm test --runInBand --runTestsByPath components/browser/local-chromium-preview.test.tsx lib/browser/frame-painter.test.ts lib/browser/shared-local-browser.test.ts
rtk proxy node --test services/workspace-runtime/src/runtime-server.test.mjs services/workspace-runtime/src/browser-service-local.test.mjs
```

To rerun the component diagnostics, first copy the archived viewport-probe.test.tsx into components/browser/local-chromium-preview.diagnostic.test.tsx, run its command, then remove that temporary copy. Do not commit the intentionally red assertions as ordinary tests.

## Recommended correction order and acceptance checks

1. Size before revealing the initial page frame. Measure the actual container before initial navigation/capture where possible, or withhold the old-aspect canvas until the current page/viewport generation has produced a matching frame. Do not rely on reducing the timer alone. Check cold open and tab switch, including a slow navigation and non-1 DPR.
2. Replace the pure trailing debounce with a bounded-rate, latest-wins resize pump: immediate first measurement, at most one in-flight RPC, a bounded update interval while dragging, and delivery of the final dimensions. Do not send every pointer tick or let requests accumulate. Verify continuous dragging produces intermediate viewport updates and reaches the final exact size.
3. Replace the preview parent's exact-width subscription with the existing threshold-based observation. Keep precise measurement local to components that need it. Verify no parent re-render for ticks that stay within the same placement threshold.
4. Add runtime media cleanup at the common session lifecycle boundary, including normal close, expiry, disconnect, and failed/restarted sessions. Delete frame/sequence state, wake pending readers, remove empty waiter entries, and prevent a late publish from resurrecting a closed session. Test repeated create/close with GC and assert old media cannot be retrieved.
5. Repeat the real desktop flow with a frame-time trace and memory samples for the host WebContent process, Chromium renderers, and Node runtime separately. Only then decide whether capture resolution/quality or renderer backpressure needs adjustment. Preserve the existing raw binary IPC, bitmap.close, and bounded painter behavior.
