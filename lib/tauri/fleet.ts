"use client"

/**
 * Thin, isTauri-guarded wrappers around the Rust `fleet_*` / island-window
 * commands (`src-tauri/src/fleet/`). Mirrors the `lib/tauri/pet-window.ts`
 * style: early-return a benign value off Tauri, swallow command failures with
 * a warn so a flaky window/monitor op can never break the renderer.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { revealInExplorer } from "@/lib/tauri/opener"
import type { FleetMonitorStatus, FleetSnapshot, PermissionBehavior } from "@/lib/fleet/types"

const STOPPED: FleetMonitorStatus = { enabled: false, port: null, configPath: null }
const EMPTY_SNAPSHOT: FleetSnapshot = { sessions: [], generatedAt: 0 }

/** Enable fleet monitoring (starts the companion ingress + token file). */
export async function fleetMonitorStart(): Promise<FleetMonitorStatus | null> {
  if (!isTauri()) return null
  try {
    return await invoke<FleetMonitorStatus>("fleet_monitor_start")
  } catch (err) {
    console.warn("fleetMonitorStart failed", err)
    return null
  }
}

/**
 * Boot restore: re-arm the monitor if it was enabled before the last quit
 * (the token file persists that intent). Returns the disabled status when it
 * was off. Mint-a-fresh-token semantics fix the stale-token-after-restart gap.
 */
export async function fleetMonitorRestore(): Promise<FleetMonitorStatus> {
  if (!isTauri()) return STOPPED
  try {
    return await invoke<FleetMonitorStatus>("fleet_monitor_restore")
  } catch (err) {
    console.warn("fleetMonitorRestore failed", err)
    return STOPPED
  }
}

/** Disable fleet monitoring (removes the token file; hooks fail open). */
export async function fleetMonitorStop(): Promise<FleetMonitorStatus> {
  if (!isTauri()) return STOPPED
  try {
    return await invoke<FleetMonitorStatus>("fleet_monitor_stop")
  } catch (err) {
    console.warn("fleetMonitorStop failed", err)
    return STOPPED
  }
}

export async function fleetMonitorStatus(): Promise<FleetMonitorStatus> {
  if (!isTauri()) return STOPPED
  try {
    return await invoke<FleetMonitorStatus>("fleet_monitor_status")
  } catch (err) {
    console.warn("fleetMonitorStatus failed", err)
    return STOPPED
  }
}

/** Current fleet snapshot (island mount backfill before the first event). */
export async function fleetGetSnapshot(): Promise<FleetSnapshot> {
  if (!isTauri()) return EMPTY_SNAPSHOT
  try {
    return await invoke<FleetSnapshot>("fleet_get_snapshot")
  } catch (err) {
    console.warn("fleetGetSnapshot failed", err)
    return EMPTY_SNAPSHOT
  }
}

/**
 * Answer a parked permission request. Returns false when the request already
 * timed out on the Rust side (the row clears via the next snapshot).
 */
export async function fleetPermissionRespond(
  requestId: string,
  behavior: PermissionBehavior
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>("fleet_permission_respond", { requestId, behavior })
  } catch (err) {
    console.warn("fleetPermissionRespond failed", err)
    return false
  }
}

/** Install state of the Codex `notify` integration (mirrors `fleet/codex.rs`). */
export type CodexStatus = "installed" | "conflict" | "not-installed" | "unavailable"

export interface CodexIntegrationStatus {
  status: CodexStatus
  configPath: string | null
  scriptPath: string | null
}

const CODEX_UNAVAILABLE: CodexIntegrationStatus = {
  status: "unavailable",
  configPath: null,
  scriptPath: null,
}

/** Point `~/.codex/config.toml`'s `notify` at the generated forwarder. */
export async function fleetCodexInstall(): Promise<CodexIntegrationStatus> {
  if (!isTauri()) return CODEX_UNAVAILABLE
  return invoke<CodexIntegrationStatus>("fleet_codex_install")
}

/** Remove our `notify` entry (only ours) and delete the script. */
export async function fleetCodexUninstall(): Promise<CodexIntegrationStatus> {
  if (!isTauri()) return CODEX_UNAVAILABLE
  return invoke<CodexIntegrationStatus>("fleet_codex_uninstall")
}

export async function fleetCodexStatus(): Promise<CodexIntegrationStatus> {
  if (!isTauri()) return CODEX_UNAVAILABLE
  try {
    return await invoke<CodexIntegrationStatus>("fleet_codex_status")
  } catch (err) {
    console.warn("fleetCodexStatus failed", err)
    return CODEX_UNAVAILABLE
  }
}

/** Install state of the OpenCode plugin (mirrors `fleet/opencode.rs`). */
export type OpencodeStatus = "installed" | "stale" | "not-installed" | "unavailable"

export interface OpencodeIntegrationStatus {
  status: OpencodeStatus
  pluginPath: string | null
}

const OPENCODE_UNAVAILABLE: OpencodeIntegrationStatus = {
  status: "unavailable",
  pluginPath: null,
}

/** Write the OpenCode plugin into `~/.config/opencode/plugin/`. */
export async function fleetOpencodeInstall(): Promise<OpencodeIntegrationStatus> {
  if (!isTauri()) return OPENCODE_UNAVAILABLE
  return invoke<OpencodeIntegrationStatus>("fleet_opencode_install")
}

/** Remove the OpenCode plugin. */
export async function fleetOpencodeUninstall(): Promise<OpencodeIntegrationStatus> {
  if (!isTauri()) return OPENCODE_UNAVAILABLE
  return invoke<OpencodeIntegrationStatus>("fleet_opencode_uninstall")
}

export async function fleetOpencodeStatus(): Promise<OpencodeIntegrationStatus> {
  if (!isTauri()) return OPENCODE_UNAVAILABLE
  try {
    return await invoke<OpencodeIntegrationStatus>("fleet_opencode_status")
  } catch (err) {
    console.warn("fleetOpencodeStatus failed", err)
    return OPENCODE_UNAVAILABLE
  }
}

/** Bring the terminal that dispatched a session to the foreground. */
export async function fleetFocusTerminal(agent: string, sessionId: string): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("fleet_focus_terminal", { agent, sessionId })
    return true
  } catch (err) {
    console.warn("fleetFocusTerminal failed", err)
    return false
  }
}

/**
 * Reveal a monitored session's transcript file in the OS file manager (Finder /
 * Explorer / the Linux default), surfacing the session's `openTranscript`
 * capability. Cross-platform via the shared reveal helper; a benign `false`
 * off Tauri, on an empty path, or on any failure so the row action can never
 * throw into the island renderer.
 */
export async function fleetRevealTranscript(path: string | null | undefined): Promise<boolean> {
  if (!isTauri() || !path) return false
  try {
    await revealInExplorer(path)
    return true
  } catch (err) {
    console.warn("fleetRevealTranscript failed", err)
    return false
  }
}

/**
 * Queue a prompt for an OpenCode session — the OpenCode plugin polls for it
 * and injects it via its bound client. Returns the command id, or null on
 * failure / empty text.
 */
export async function fleetOpencodeSendMessage(
  sessionId: string,
  text: string
): Promise<string | null> {
  if (!isTauri()) return null
  try {
    return await invoke<string>("fleet_opencode_send_message", { sessionId, text })
  } catch (err) {
    console.warn("fleetOpencodeSendMessage failed", err)
    return null
  }
}

/** Open (or re-show) the island overlay window. */
export async function openIslandWindow(opts?: { width: number; height: number }): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("open_island_window", { opts: opts ?? null })
    return true
  } catch (err) {
    console.warn("openIslandWindow failed", err)
    return false
  }
}

/** Hide the island overlay window (cheap re-show later). */
export async function closeIslandWindow(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("close_island_window")
    return true
  } catch (err) {
    console.warn("closeIslandWindow failed", err)
    return false
  }
}

export async function isIslandWindowOpen(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>("is_island_window_open")
  } catch (err) {
    console.warn("isIslandWindowOpen failed", err)
    return false
  }
}

/**
 * Resize the island to its measured content size (logical px). Returns the
 * display's top safe-area inset (logical px — the notch height) that Rust
 * grew the window by; the shell pads its card below it so the content clears
 * the camera housing while the window still spans the notch strip (keeping
 * slam-to-top hover on target). `0` off Tauri, on failure, and on
 * non-notched displays.
 */
export async function islandResize(width: number, height: number): Promise<number> {
  if (!isTauri()) return 0
  try {
    const inset = await invoke<number>("island_resize", { width, height })
    return typeof inset === "number" && Number.isFinite(inset) && inset > 0 ? inset : 0
  } catch (err) {
    console.warn("islandResize failed", err)
    return 0
  }
}

/** One connected monitor, for the island display picker (mirrors Rust `IslandMonitorInfo`). */
export interface IslandMonitorInfo {
  /** OS monitor name — the persisted identifier. `null` when unnamed. */
  name: string | null
  index: number
  isPrimary: boolean
  /** Whether the persisted preference points at this monitor. */
  selected: boolean
  /** Logical size, for the "2560×1440" hint. */
  width: number
  height: number
}

/** List connected monitors for the island display picker. */
export async function islandListMonitors(): Promise<IslandMonitorInfo[]> {
  if (!isTauri()) return []
  try {
    return await invoke<IslandMonitorInfo[]>("island_list_monitors")
  } catch (err) {
    console.warn("islandListMonitors failed", err)
    return []
  }
}

/**
 * Persist the island's preferred monitor (`null` → follow the primary) and
 * move a live island there immediately.
 */
export async function islandSetMonitor(name: string | null): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("island_set_monitor", { monitor: name })
    return true
  } catch (err) {
    console.warn("islandSetMonitor failed", err)
    return false
  }
}
