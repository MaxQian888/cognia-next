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
    if (!isTauri()) return
    configureTerminalBridge({
      spawn: createPtyShellSpawn(),
      outputSink: noopSink,
    })
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
