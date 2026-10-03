"use client"

/**
 * Brings the local terminal up at app boot (Tauri only).
 *
 * On mount it pushes the user's terminal profiles to the host (ordered
 * before any spawn, see `syncTerminalHostProfiles`), reattaches to PTY
 * sessions that survived a webview reload, and warm-imports
 * `dock-tool-handler` so the first `terminal_dock_*` MCP call from the agent
 * doesn't pay a dynamic-import round-trip mid-tool. The module is pure (no
 * top-level side effects); the cost is the bundle inclusion only.
 *
 * Tauri-only: the local PTY lives in the desktop app. Web and Capacitor
 * reattach to a remote host's sessions through `lib/terminal/boot-reattach.ts`.
 * VS Code extensions' terminals are dock tabs opened on demand by
 * `lib/plugin/vscode-shim/terminal-handlers.ts`, not here.
 */

import { useEffect } from "react"

import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { syncTerminalHostProfiles } from "@/lib/terminal/host-profiles"

export function TerminalBootInitializer() {
  useEffect(() => {
    // Unreachable in production — `desktop-only-initializers.tsx` mounts this
    // component behind its own `isTauri()` gate — but kept as a local guard
    // because the effect below unconditionally reaches for Tauri APIs. Web and
    // Capacitor reattach through `lib/terminal/boot-reattach.ts` instead, which
    // is mounted from the dock region and therefore actually runs there.
    if (!isTauri()) return
    // Warm-import so the first agent-driven terminal_dock_* call does
    // not pay a dynamic-import round-trip inside `handlePluginToolExec`.
    // Best-effort: if the import fails (e.g. test environment without
    // the settings store), the lazy import in plugin-tool-ipc.ts still
    // works on the actual call.
    void import("@/lib/terminal/dock-tool-handler").catch(() => undefined)
    const syncProfiles = () => {
      const terminal = useSettingsStore.getState().settings?.terminal
      void syncTerminalHostProfiles(terminal?.profiles, {
        enableShellIntegration: terminal?.enableShellIntegration,
        forceUtf8: terminal?.forceUtf8,
        sandboxed: terminal?.sandboxed,
        sshProfiles: terminal?.sshHosts,
      }).catch(() => undefined)
    }
    let stopWaitingForSettings: (() => void) | undefined
    if (useSettingsStore.getState().loaded) {
      syncProfiles()
    } else {
      stopWaitingForSettings = useSettingsStore.subscribe((state) => {
        if (!state.loaded) return
        stopWaitingForSettings?.()
        stopWaitingForSettings = undefined
        syncProfiles()
      })
    }
    // 1C — reattach to PTY sessions that survived a webview reload. The
    // Rust process keeps them alive; this restores the dock tabs + live
    // streams (no-op on first launch / full restart). Best-effort.
    void import("@/lib/terminal/rehydrate")
      .then((m) => m.rehydrateTerminals())
      .catch(() => undefined)
    return () => {
      stopWaitingForSettings?.()
    }
  }, [])

  return null
}

export default TerminalBootInitializer
