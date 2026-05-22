"use client"

/**
 * Pick the runtime transport for a new terminal session.
 *
 * Mirrors `lib/tauri/transport-instance.ts:pickTransport` but for the
 * terminal subsystem specifically:
 *
 *   - Tauri desktop  → `"tauri-channel"` (uses the Rust `terminal_*`
 *                       commands + `Channel<TerminalEvent>`)
 *   - Capacitor mobile → `"ws"` (LAN-only — implemented in Task #14)
 *   - Plain web      → not supported (throws on use)
 *
 * The Capacitor path is wired to the V2 headless server's
 * `/v1/ws/terminal/:projectId/:sessionId` endpoint (per the approved
 * plan). The implementation for `"ws"` lands in task #14; until then
 * `selectTerminalTransport` returns `"ws"` on Capacitor and the
 * `<TerminalDock>` empty-state shows a "remote not yet implemented"
 * note instead of trying to spawn.
 */

import { isCapacitor, isTauri } from "@/lib/tauri"

export type TerminalTransportKind = "tauri-channel" | "ws" | "unsupported"

export function selectTerminalTransport(): TerminalTransportKind {
  if (isTauri()) return "tauri-channel"
  if (isCapacitor()) return "ws"
  return "unsupported"
}

/**
 * True when the current shell can run a real PTY (or proxy to one over LAN).
 * Components use this to decide whether to mount the dock at all.
 */
export function terminalAvailable(): boolean {
  return selectTerminalTransport() !== "unsupported"
}
