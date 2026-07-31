"use client"

/**
 * Pick the runtime transport for a new terminal session.
 *
 * Mirrors `lib/tauri/transport-instance.ts:pickTransport` but for the
 * terminal subsystem specifically:
 *
 *   - Tauri desktop      → `"tauri-channel"` (in-process PTY via the
 *                          Rust `terminal_*` commands + `Channel`)
 *   - Capacitor mobile   → `"ws"` (LAN — companion server WebSocket)
 *   - Capacitor over WAN → `"webrtc"` (ordered terminal data channel)
 *   - Plain web          → `"unsupported"`
 *
 * `selectTerminalTransport` returns the *preferred* transport for the
 * current shell. `selectTerminalTransportChain` returns a fallback
 * priority list — callers can walk it to retry with a different
 * transport when the preferred one fails (e.g. no mDNS hit → fall
 * through to WebRTC).
 */

import { isCapacitor, isTauri } from "@/lib/tauri"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"

export type TerminalTransportKind = "tauri-channel" | "ws" | "webrtc" | "unsupported"

/**
 * Highest-priority transport. Used by callers that don't want to deal
 * with fallback logic (the dock's "+ New" button on desktop).
 */
export function selectTerminalTransport(): TerminalTransportKind {
  // Desktop driving a remote Cognia host (ADR-0082): the terminal targets the
  // host's `/ws/terminal` over the ws session instead of the local
  // in-process PTY. Inert until a remote host is activated, so a plain desktop
  // still gets `tauri-channel` (zero regression).
  if (isRemoteHostActive()) return "ws"
  if (isTauri()) return "tauri-channel"
  if (isCapacitor()) return "ws"
  return "unsupported"
}

/**
 * Ordered fallback chain. The orchestrator walks this and tries the
 * next transport when the previous one returned `null` / threw.
 *
 *   - Tauri host: just the in-process channel (no remote ambiguity).
 *   - Capacitor mobile: `ws` (LAN/mDNS), then the already-authenticated
 *     Companion WebRTC peer when no direct socket is reachable.
 *   - Web: returns `[]` — caller should surface "unsupported".
 */
export function selectTerminalTransportChain(): TerminalTransportKind[] {
  if (isRemoteHostActive()) return ["ws", "webrtc"]
  if (isTauri()) return ["tauri-channel"]
  if (isCapacitor()) return ["ws", "webrtc"]
  return []
}

/**
 * True when the current shell can run a real PTY (or proxy to one over
 * the network). Components use this to decide whether to mount the
 * dock at all.
 */
export function terminalAvailable(): boolean {
  return selectTerminalTransport() !== "unsupported"
}
