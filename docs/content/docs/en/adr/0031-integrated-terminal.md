---
title: ADR-0031 — Integrated terminal Phase 2 — Dock↔Agent unification, reconnect/replay, plugin + workflow surfacing
description: Wave 1-4 enhancements over the existing terminal dock. (1) The agent's MCP terminal tool routes through the existing `plugin_tool_exec` IPC into the user's visible PTY — one shell, one cwd, one history. (2) A node-pty REPL builtin gives the agent a private interactive shell in the sidecar (orthogonal to the dock-relay). (3) A 5-minute timestamped replay buffer with monotonic `seq` survives WS drops; the WS handler implements the resume protocol; clients reconnect with exponential backoff. (4) A `BaseTerminalSession` abstract class deduplicates listener/exit-state boilerplate across Tauri, WS, and a future WebRTC transport. (5) Plugin manifest already carries `terminal:spawn|write|kill`; this work adds the workflow `action.system.terminal` node + dogfoods through github-delivery's pre-flight test path. (6) Polish — fish + nushell shell-integration, OSC 8 hyperlinks, dock drag-resize, configurable run-in-dock timeout, mobile search+history overlay parity.
---

# ADR-0031 — Integrated terminal Phase 2

**Status**: Proposed (2026-05-22)
**Authors**: Max Qian + Claude Opus 4.7
**Affects**: `lib/terminal/`, `lib/plugin/bridge/sidecar-tools-bridge.ts`, `lib/plugin/security/permission-guard.ts`, `lib/claude/plugin-tool-ipc.ts`, `lib/claude/build-options.ts`, `lib/workflow/nodes/`, `types/workflow/visual.ts`, `components/terminal/`, `components/mobile/mobile-terminal-screen.tsx`, `components/settings/terminal/`, `components/workflow/editor/inspector/`, `sidecar/builtin-tools/`, `src-tauri/src/terminal/`, `src-tauri/src/companion_api/ws_terminal.rs`, `src-tauri/resources/terminal/`, `plugins/github-delivery/plugin.json`

## Current state amendment (2026-08-13)

Remote SSH sessions now probe supported interactive shells, inject a validated nonce-bound OSC 633 integration command through the existing PTY writer, and surface explicit degraded capability reasons when probing or injection fails. Events continue through the one canonical `Osc633Parser`; no parallel terminal transport or protocol was introduced. `cargo test -p cognia-terminal` covers the supported-shell and nonce-validation paths.

## Context

The Phase 1 terminal subsystem (~80 uncommitted files on `master` before this work) shipped a full xterm.js dock, Rust `portable-pty` backend, OSC 633 prompt-marker parser, mobile WebSocket transport, settings UI, chat handoff, sidecar MCP tool, plugin VSCode shim, and an agent-trust consent gate. A cross-cutting audit found 23 concrete gaps. The user scoped a single-wave delivery covering 4 themes: agent dock unification, mobile/WAN resilience, plugin + workflow surfacing, and shell-feature parity.

This ADR records the decisions and their interlocks.

## Decisions

### D1 — Dock↔Agent unification rides the existing `plugin_tool_exec` IPC

Before: `sidecar/builtin-tools/terminal-dock-tool.mjs` admitted that the agent's `child_process` sessions were **not** the same processes as the user's visible dock PTYs ("Run in dock" was misleading).

After: the renderer manifests 4 synthetic `terminal_dock_*` tools to the SDK sidecar via the existing `pluginTools` channel (`lib/plugin/bridge/sidecar-tools-bridge.ts:buildTerminalDockManifestEntries`). The sidecar's existing `plugin-tools.mjs` proxy wraps them with the same `plugin_tool_exec` → `plugin_tool_response` round-trip used by user-installed plugin tools. The renderer's `lib/claude/plugin-tool-ipc.ts:handlePluginToolExec` recognises the `terminal_dock_` prefix and dispatches to `lib/terminal/dock-tool-handler.ts:runTerminalDockAction`. That helper goes through `requestAgentTrust` and `runInDockTab` so the consent + tab gating matches the chat affordance.

Eliminated 2 net-new files (`terminal-dock-bridge.mjs`, `terminal-dock-ipc.ts`) by reusing the protocol that was already live for `pluginTools`. The gate is per-call:

1. **Manifest** — `buildPluginToolsManifest({ exposeDockToAgents })` skips the synthetic entries when the setting is off, so the sidecar never registers them.
2. **Renderer** — `dock-tool-handler.ts` re-reads `useSettingsStore.getState().settings.terminal.exposeDockToAgents` on every action (defence in depth against a stale manifest).
3. **Consent broker** — every command writes via the `terminal:write` permission, scoped to `agent:<chatId>:<tabId>` (`lib/terminal/agent-trust.ts`).

### D2 — Headless interactive REPL via `node-pty` (optional dependency)

The dock-relay handles the case where the renderer is alive. For headless contexts (V2 server, agent-only flows that don't need user visibility), the sidecar exposes 4 `terminal_repl_*` tools backed by `node-pty` — a real PTY with bidirectional bytes, ring-buffered output, idle GC, per-agent session cap (8). Lazy `import("node-pty")` so a host without the native binding falls through to a clean structured error rather than crashing.

`node-pty` is declared in `sidecar/package.json` under `optionalDependencies` so `pnpm install` succeeds even on hosts without a C++ toolchain. The new BuiltinTools category `terminalRepl` (default off) gates the tool surface; a separate flag from `exposeDockToAgents` because the surfaces serve different use cases.

### D3 — Reconnect/replay protocol with monotonic `seq`

Before: `src-tauri/src/companion_api/ws_terminal.rs:78` flagged reconnect "reserved for future"; the handler rejected anything other than `spawn=1`. Mobile sessions died on any network blip.

After: a per-session `ReplayBuffer` (`src-tauri/src/terminal/replay.rs`) stamps each `TerminalEvent` with a monotonic `seq: u64` and retains the most-recent ~512 KiB for up to 5 minutes (matching the renderer-side reconnect budget). The `PtySession`'s reader/waiter threads push every event through the buffer before fan-out. Sessions are NOT dropped when the WS closes — instead a process-wide `WsTerminalRegistry` marks them detached; a background reaper drops sessions whose consumer has been gone past 5 minutes.

Wire protocol additions:

- Outgoing JSON control frames gain `seq: u64`.
- Reconnect URL: `wss://…/ws/v1/terminal?token=<jwt>&sessionId=<id>&resumeFrom=<seq>`. The server replays every event with `seq > resumeFrom` from the buffer, then resumes live emission.
- Per-device ownership: `WsTerminalRegistry.lookup_for_device` confirms the requesting device JWT matches the device that spawned the session before allowing reconnect.

Client (`lib/terminal/transport-ws.ts`):

- `RemoteTerminalSession extends BaseTerminalSession`.
- Exponential backoff schedule [1s, 2s, 5s, 10s, 30s, 60s × 4] summing to ~5 min.
- During the reconnect window, outgoing writes queue (cap 256 frames) and flush on reattach.
- `onTransportState` listener surface: `connected | reconnecting | gone`. The mobile connection badge reads this.
- If the 5-minute budget expires, emit `gone` then `handleExit(null)` so consumers see a final exit.

### D4 — `BaseTerminalSession` abstract class deduplicates transport boilerplate

`TerminalSession` (Tauri channel) and `RemoteTerminalSession` (WS) duplicated ~80 LOC of listener-set + exit-state code before this work. Adding a third subclass for WebRTC would have made it 240 LOC of copy-paste.

`lib/terminal/base-session.ts` extracts the shared surface: `dataListeners`, `integrationListeners`, `exitListeners`, `exited`, `exitCode`, `onData/onIntegration/onExit`, `dispatchData/dispatchIntegration/handleExit`, `isExited/lastExitCode/id`. Subclasses implement `write/resize/kill` and wire incoming frames to the protected dispatchers.

The Tauri subclass shrank from 161 LOC to 100; the WS subclass (after adding full reconnect) ended up at ~330 LOC because of the new machinery — but the boilerplate share is ~120 LOC less than the worst case.

### D5 — `EventSink` carries `(seq, event)` not just `event`

For the Rust reader/waiter threads to surface both the replay buffer's assigned seq AND the event to downstream consumers, the `EventSink` type changed from `Arc<dyn Fn(TerminalEvent) + Send + Sync>` to `Arc<dyn Fn(u64, TerminalEvent) + Send + Sync>`. The Tauri Channel wrapper (`spawn_session`) ignores the seq because the desktop dock doesn't need it; the WS handler uses it on every outgoing JSON control frame.

This is the contract change that lets the replay buffer remain the single source of truth for event ordering — consumers either honor seq or explicitly ignore it.

### D6 — WebRTC datachannel transport — **shipped** (was: designed, deferred)

ADR-0021's signaling stack (`src-tauri/src/companion_api/signaling/{mod,client,dispatch,peer}.rs`, ~5000 LOC across signaling + dispatch + envelope) shipped a `cognia.signaling` JSON-only data channel for the RPC + event plane. Carrying terminal traffic over the same peer requires either:

1. Multiplexing PTY bytes into the existing channel (would force RPC envelope schema changes for binary framing + session id prefix), OR
2. A second binary-capable data channel labeled `cognia.signaling.terminal` on the same peer connection (clean separation, but requires `signaling/client.rs` + `dispatch.rs` integration for the new label).

`lib/terminal/pick-transport.ts:selectTerminalTransportChain` returns `["ws"]` on Capacitor today. Once the Rust desktop peer is wired through (new `rtc_terminal.rs` handler + peer.rs label dispatch + `transport-webrtc.ts` client subclass of `BaseTerminalSession`), the chain extends to `["ws", "webrtc"]` and the orchestrator walks it on connect failure. The `BaseTerminalSession` + reconnect protocol from D4/D5 already factor the bulk of the work — the remaining surface is the signaling routing layer.

### D7 — Workflow node `action.system.terminal`

A new node kind (`types/workflow/visual.ts` union + `WORKFLOW_NODE_KINDS` array) with executor `lib/workflow/nodes/terminal.ts`. Inputs: `command`, optional `args` / `cwd` / `shell` / `projectId` / `tabId` / `timeoutSec` / `onFailure` (`"throw" | "branch"`). Output: `{ exitCode, output, sessionId }` and a `decision` of `"success"` (exit 0) or `"failure"` (non-zero) for downstream `flow.branch`-style routing.

The executor delegates to `runTerminalDockAction` so consent + tab gating + timeout-resolution behaviour is identical to the chat affordance and the agent's MCP path. Renderer-only execution — workflows run in the Next.js process today; if/when V2 server-side workflow execution lands, a Tauri command bridge for the consent broker becomes necessary (scoped out of this wave).

Inspector form (`SystemTerminalConfig` in `components/workflow/editor/inspector/forms/index.tsx`) surfaces every input; registered in `node-config-registry.tsx`.

### D8 — Plugin permission descriptions + risk classification

`terminal:spawn`, `terminal:write`, `terminal:kill` already lived in `PluginPermission` (`types/plugin/plugin.ts:280-282`) and `PERMISSION_DESCRIPTIONS` / `PERMISSION_GROUPS` (`lib/plugin/security/permission-guard.ts:74-121`). This wave adds:

- `terminal:write` to `DANGEROUS_PERMISSIONS` (writing to an existing terminal session is equivalent to executing arbitrary shell commands — same risk tier as `terminal:spawn` and `shell:execute`).
- `terminal:kill` explicitly NOT dangerous (medium risk — killing a session you already have a handle to is recoverable; per-call confirmation would be more annoying than the action warrants).

The github-delivery plugin gains `terminal:spawn` + `terminal:write` in its manifest, dogfooding the chain end-to-end: a github-delivery workflow can now compose `action.system.terminal` (e.g. running `pnpm test`) → `flow.branch` → `action.github.mergePr` to gate a merge on a pre-flight test result.

### D9 — Shell parity (fish + nushell) and prompt-marker completeness

Two new shell-integration scripts mirror the bash / zsh / pwsh pattern:

- `shell-integration.fish` uses native `fish_prompt` + `fish_preexec` event handlers. Emits D + P + A on prompt render and C on command submit; no B (fish has no post-prompt event; the OSC 633 parser tolerates a missing B).
- `shell-integration.nu` uses `$env.config.hooks.{pre_prompt, pre_execution}`. Emits D + P + A + C; no B (same reason). Best-effort `LAST_EXIT_CODE` — falls back to 0 when the env var isn't set.

`integration.rs:ShellKind` gains `Fish` and `Nu` variants. `build_fish` uses `--init-command "source <script>"` (fish loads conf.d before the init command, so user functions are in scope when we attach hooks). `build_nu` writes a temp config that re-sources the user's regular config via `try { source '<user>' } catch {}` then sources our hook script, then passes the temp config via `--config <path>`. Both env-inject `COGNIA_TERM_NONCE` so the OSC 633 parser nonce-gates incoming sequences.

PSReadLine completion in `shell-integration.ps1` (the Wave 3C `C` event for PowerShell on Windows) was already shipped pre-this-work.

### D10 — Polish — OSC 8 hyperlinks, dock drag-resize, configurable timeout, mobile overlay parity

- **OSC 8 hyperlinks** (`terminal-instance.tsx`): xterm.js 5.x `linkHandler` opens the URL via `@tauri-apps/plugin-opener` in Tauri (writes through the OS without an in-app webview hop) or `window.open` in browser / Capacitor. Allowlisted schemes: http / https / mailto / file.
- **Dock drag-resize** (`terminal-dock.tsx`): pinned 4-px handle at the top edge of the dock. Pointer drag captures `pointermove` on `window` (so the cursor can leave the handle without dropping the drag); deltaY → pct of viewport → `useTerminalStore.setPanelHeight` (clamped to existing `TERMINAL_LAYOUT_BOUNDS`). Keyboard-accessible: arrow keys ±2% when the separator has focus. Aria-labeled.
- **Configurable run-in-dock timeout** (`run-in-dock.ts`, `terminal-card.tsx`): new setting `terminal.runInDockTimeoutSec` (default 60, range 5–600). Read at call time so a settings change applies to the very next invocation. Per-call `input.timeoutMs` still wins; this is the floor used when no per-call override is given.
- **Mobile overlay parity** (`mobile-terminal-screen.tsx`): mounts the existing `TerminalSearchOverlay` (anchored top-right) and `TerminalHistoryPanel` (in a slide-up `Sheet`). The components were already touch-safe; this is composition only.

### D11 — Settings + i18n parity

New / updated i18n keys land in both `i18n/messages/en.json` and `i18n/messages/zh-CN.json`:

- `terminal.dock.resize` (handle aria-label)
- `mobile.terminal.search`, `history`, `historyTitle`, `historySubtitle`
- `settings.terminal.exposeDockToAgents.helper` (revised to describe the new dock-relay semantics)
- `settings.terminal.runInDockTimeout.{label, helper}`
- `settings.builtinTools.terminalRepl{, Desc}` + per-tool descriptions
- `workflows.forms.systemTerminal.*` (command / cwd / shell / tabId / timeoutSec / onFailure with options)

`pnpm lint:i18n` confirms parity.

## Test coverage

Per-file co-located tests (CLAUDE.md rule #3, ≥90% lines/branches/functions on new code):

- `lib/plugin/bridge/terminal-dock-schemas.test.ts` (10 tests)
- `lib/plugin/bridge/sidecar-tools-bridge.test.ts` (13 tests — extended)
- `lib/terminal/dock-tool-handler.test.ts` (17 tests covering all four actions + gate + consent + timeout)
- `lib/claude/plugin-tool-ipc.test.ts` (extended with terminal-dock fallback test)
- `components/providers/initializers/terminal-bridge-initializer.test.tsx` (4 tests)
- `lib/terminal/base-session.test.ts` (10 tests)
- `lib/terminal/transport-ws.test.ts` (rewritten — 20 tests including 7 Wave 2 reconnect scenarios)
- `lib/terminal/pick-transport.test.ts` (extended with chain tests)
- `components/mobile/mobile-terminal-screen.test.tsx` (11 tests including 3 overlay parity)
- `lib/workflow/nodes/terminal.test.ts` (10 tests)
- `sidecar/builtin-tools/__tests__/terminal-repl-tool.test.mjs` (15 Node-test tests — node-pty stubbed)
- `lib/plugin/security/permission-guard.test.ts` (extended for `terminal:write` dangerous classification)
- `plugins/first-party-manifests.test.ts` (covers the github-delivery manifest extension)
- Rust: `src-tauri/src/terminal/replay.rs` (8 `#[cfg(test)]` tests); `src-tauri/src/terminal/integration.rs` (4 new tests for fish/nu); `src-tauri/src/companion_api/ws_terminal.rs` (extended for the new resume params + registry).

Net: **121 + 15 + 8 = 144 new/extended tests, all passing.**

## File summary

**Net-new (10)**:

- `lib/terminal/base-session.ts`
- `lib/terminal/dock-tool-handler.ts`
- `lib/plugin/bridge/terminal-dock-schemas.ts`
- `lib/workflow/nodes/terminal.ts`
- `sidecar/builtin-tools/terminal-repl-tool.mjs` (replaces deleted `terminal-dock-tool.mjs`)
- `src-tauri/src/terminal/replay.rs`
- `src-tauri/resources/terminal/shell-integration.fish`
- `src-tauri/resources/terminal/shell-integration.nu`
- This ADR (en) + Chinese mirror

**Extended (~22)**: `lib/plugin/bridge/sidecar-tools-bridge.ts`, `lib/claude/build-options.ts`, `lib/claude/plugin-tool-ipc.ts`, `lib/claude/types.ts`, `lib/plugin/security/permission-guard.ts`, `lib/settings/builtin-tools-data.json`, `sidecar/builtin-tools/index.mjs`, `sidecar/package.json` (optional node-pty), `components/providers/initializers/terminal-bridge-initializer.tsx`, `lib/terminal/session.ts`, `lib/terminal/transport-ws.ts`, `lib/terminal/pick-transport.ts`, `lib/terminal/run-in-dock.ts`, `src-tauri/src/terminal/{mod,session,integration}.rs`, `src-tauri/src/companion_api/ws_terminal.rs`, `src-tauri/resources/terminal/shell-integration.ps1` (already had PSReadLine), `components/mobile/mobile-terminal-screen.tsx`, `components/terminal/terminal-instance.tsx`, `components/terminal/terminal-dock.tsx`, `components/settings/terminal/terminal-card.tsx`, `components/workflow/editor/inspector/forms/index.tsx` + `node-config-registry.tsx`, `types/workflow/visual.ts`, `lib/workflow/nodes/built-ins.ts`, `plugins/github-delivery/plugin.json`, both i18n message files, `stores/terminal/terminal-store.ts` (doc-comment refresh), `lib/terminal/spawn-orchestrator.ts` (doc-comment refresh).

**Deleted (2)**: `sidecar/builtin-tools/terminal-dock-tool.mjs` + its test — dead code (the `terminalDock` BuiltinToolsConfig field never existed, so the sidecar never registered these tools). Replaced by the `terminal-repl-tool.mjs` REPL surface.

## Follow-ups explicitly scoped out

1. ~~**WebRTC terminal transport**~~ — **shipped.** `selectTerminalTransportChain()` returns `["ws", "webrtc"]` on Capacitor and for a desktop driving a remote host; `RemoteTerminalSession` implements `spawnWan` / `listWan` / `reattachWan` over the companion data channel (`lib/terminal/transport-ws.ts`). This entry is left in place because §D6 below still describes it as deferred.
2. **Remote shell-integration script delivery** — mobile WS sessions deliberately disable OSC 633 today (the integration scripts are local file paths the remote shell can't resolve). A future minor version can ship the script bytes over the WS handshake so mobile gets prompt markers + command tracking.
3. **Server-side workflow execution + consent broker bridge** — `action.system.terminal` is renderer-only. Headless V2 server workflows that want to invoke the dock need a Tauri command bridge for the broker (or restrict to the headless `terminal_repl_*` path).
4. **More shells** — elvish / tcsh / xonsh would each need a new `shell-integration.<x>` script + `ShellKind` variant. The pattern is established; the work is per-shell.
