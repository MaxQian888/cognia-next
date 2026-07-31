"use client"

/**
 * Side-effect-only mount that wires the renderer to the Tauri events
 * emitted by `src-tauri/src/cli_bridge/handlers.rs` whenever a `cognia`
 * CLI install / uninstall / hot-reload completes. Subscribes once and
 * routes each event into the `hot-reload-history-store` + triggers a
 * fresh plugin scan so the Library tab reflects the change without a
 * restart.
 *
 * Mounted next to `PluginErrorToaster` / `PluginEnableFailureToaster`
 * in `app/layout.tsx`. No-op on web / Capacitor (the hook checks
 * `isTauri()` before subscribing).
 */

import { useCliBridgeEvents } from "@/hooks/plugins/use-cli-bridge-events"
import { useCliSessionHandoff } from "@/hooks/chat/use-cli-session-handoff"

export function CliBridgeEventsBridge() {
  useCliBridgeEvents()
  // Receive sessions handed off from the standalone agent CLI (`run --handoff`
  // / `cognia-agent handoff <id>`) and open them in the desktop app.
  useCliSessionHandoff()
  return null
}
