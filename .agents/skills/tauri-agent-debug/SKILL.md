---
name: tauri-agent-debug
description: Launch, automate, inspect, and diagnose Cognia in its real Tauri shell through the authenticated agent-debug bridge and Playwright-style TauriPage API. Use for desktop-only bugs, Tauri startup-mode automation, renderer/native boundary failures, window and webview behavior, console or network diagnosis, native log capture, screenshots, and real-shell verification on macOS, Windows, or Linux.
---

# Tauri Agent Debug

Drive the real system webview while preserving Cognia's Tauri runtime. Use the
structured snapshot/ref loop for reliable actions and the Playwright-style API
for longer flows.

## Workflow

1. Inspect `rtk git status --short`; preserve unrelated changes.
2. Start with `rtk pnpm tauri:debug:agent`. Record the printed artifact and log paths.
   The agent-debug Tauri config uses checkout runtimes instead of copying the
   1+ GiB sidecar dependency tree. A cold Rust build may still use the 20-minute
   default startup budget; pass `--timeout <milliseconds>` only when needed.
3. Confirm the shell with `rtk pnpm tauri:debug:agent:status`. Do not continue if
   `agentDebug` is absent or helper API version is not `2`; a stale normal-build
   endpoint is not a valid target.
4. Capture `rtk node scripts/tauri/agent-debug.mjs snapshot --include-text`.
5. Act on a ref from that snapshot. Every action returns a fresh snapshot; use
   only its new generation for the next action.
6. Reproduce the user path in the real shell. Prefer semantic role/name locators
   over CSS and raw `evaluate`.
7. On failure, drain console and network events, read native logs, and take a
   screenshot before changing code.
8. After a fix, repeat the same user path and one adjacent desktop surface.
9. Stop only the tracked session with `rtk pnpm tauri:debug:agent:stop`.

Never claim Tauri verification from `pnpm dev`, jsdom, or a browser-only
Playwright run. Keep the Windows WebView2 CDP suite for Chromium-specific E2E;
this bridge supplies cross-platform real-webview debugging.

## Fast command loop

```bash
rtk node scripts/tauri/agent-debug.mjs snapshot --include-text
rtk node scripts/tauri/agent-debug.mjs capabilities
rtk node scripts/tauri/agent-debug.mjs act g1e4 click
rtk node scripts/tauri/agent-debug.mjs act g2e7 fill "hello"
rtk node scripts/tauri/agent-debug.mjs inspect g3e2 getAttribute --args '{"name":"aria-label"}'
rtk node scripts/tauri/agent-debug.mjs console
rtk node scripts/tauri/agent-debug.mjs network
rtk node scripts/tauri/agent-debug.mjs logs --lines 300
rtk node scripts/tauri/agent-debug.mjs screenshot .cache/tauri-agent-debug/evidence.png
```

Treat `stale or unknown element ref` as a request to snapshot again, not as a
reason to guess coordinates. Use `--window <label>` after listing windows with
the status command.

## Playwright-style flows

Read [references/playwright-api.md](references/playwright-api.md) before writing
a multi-step script or translating an existing Playwright test. Import
`connectTauriPage` from `scripts/tauri/agent-debug-client.mjs`; do not recreate
bridge discovery, authentication, polling, or locator strictness.

Use raw `page.evaluate` only for state inspection or a capability the semantic
API cannot express. It executes with renderer privileges and exists only behind
the explicit `agent-debug` feature.

Call `await page.capabilities()` before porting any flow that depends on CDP,
trusted input, video, or response interception. Unsupported behavior must raise
`TauriDebugUnsupportedError`; never infer support from a Playwright-shaped name.

## Failure triage

- Launch timeout: inspect the printed `tauri-dev.log` first; then check whether
  another Cargo process holds the build lock.
- `404` on `/api/dev/agent/*`: the running app lacks `--features agent-debug`.
- `401`: reread `cli-endpoint.json`; its per-launch token rotated.
- Empty snapshot: check `page.url()`, `document.readyState`, window label, then
  use `--include-text`.
- Locator ambiguity: refine role/name or CSS, or intentionally use `.first()` /
  `.nth()`. Never silently pick the first match.
- Screenshot capture denied: grant the shell process Screen Recording permission
  on macOS, then relaunch so `xcap` can capture the real window.
- Native build failure: distinguish errors in touched files from pre-existing
  workspace dependency failures. Do not repair unrelated dirty dependency work.

## Evidence report

Report the exact real-shell flow, platform, window label, assertions observed,
console/network/native-log outcome, screenshot path, and whether the tracked
process stopped cleanly. State any blocked gate explicitly.
