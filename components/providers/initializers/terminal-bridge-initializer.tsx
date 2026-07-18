"use client"

/**
 * Wires the VS Code-shim terminal bridge to the real PTY at app boot.
 *
 * Before this initializer existed, `configureTerminalBridge()` was never
 * called in production — extensions calling `vscode.window.createTerminal`
 * would throw "not configured". The unit test injected its own fake spawn
 * for coverage, but the runtime path was a TODO.
 *
 * Now: on mount, we install `createPtyShellSpawn()` (which routes spawn
 * calls into `lib/terminal/session.ts`) and a no-op `TerminalOutputSink`
 * (the legacy line-buffered panel is being removed in task #12; the
 * dock subscribes to bridge events via `subscribeTerminalEvents` and
 * the dock store directly).
 *
 * Wave 1 — we also warm-import `dock-tool-handler` so the first
 * `terminal_dock_*` MCP call from the agent doesn't pay a dynamic-import
 * round-trip mid-tool. The module is pure (no top-level side effects);
 * the cost is the bundle inclusion only.
 *
 * Tauri-only — `TerminalSession.spawn` calls `invoke` which throws in
 * web/Capacitor mode. The bridge stays unconfigured outside Tauri, so
 * an extension calling `createTerminal` there throws the same
 * "not configured" error rather than appearing to work and silently
 * dropping bytes.
 */

import { useEffect } from "react"

import { isTauri } from "@/lib/tauri"
import { createPtyShellSpawn } from "@/lib/plugin/vscode-shim/pty-bridge-adapter"
import {
  __resetTerminalBridgeForTesting,
  configureTerminalBridge,
  type TerminalOutputSink,
} from "@/lib/plugin/vscode-shim/terminal-bridge"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

const noopSink: TerminalOutputSink = {
  appendLine() {
    // The dock store subscribes via `subscribeTerminalEvents` instead.
  },
  markClosed() {
    // Same — dock store handles close from the event channel.
  },
}

export function TerminalBridgeInitializer() {
  useEffect(() => {
    if (!isTauri()) {
      // Only desktop PTYs can survive a webview reload. Clear any snapshot
      // inherited by web/Capacitor so it cannot mask later live store updates.
      useTerminalStore.getState().restorePersistedLayout()
      return
    }
    configureTerminalBridge({
      spawn: createPtyShellSpawn(),
      outputSink: noopSink,
    })
    // Warm-import so the first agent-driven terminal_dock_* call does
    // not pay a dynamic-import round-trip inside `handlePluginToolExec`.
    // Best-effort: if the import fails (e.g. test environment without
    // the settings store), the lazy import in plugin-tool-ipc.ts still
    // works on the actual call.
    void import("@/lib/terminal/dock-tool-handler").catch(() => undefined)
    // 1C — reattach to PTY sessions that survived a webview reload. The
    // Rust process keeps them alive; this restores the dock tabs + live
    // streams (no-op on first launch / full restart). Best-effort.
    void import("@/lib/terminal/rehydrate")
      .then((m) => m.rehydrateTerminals())
      .catch(() => undefined)
    return () => {
      // Drop the bridge state so a subsequent remount (e.g. after fast
      // refresh) installs a fresh spawn handle. In production this
      // effectively never runs — the initializer is mounted once at the
      // app shell.
      __resetTerminalBridgeForTesting()
    }
  }, [])

  return null
}

export default TerminalBridgeInitializer
