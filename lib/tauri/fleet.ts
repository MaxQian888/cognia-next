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
import { EMPTY_ISLAND_GEOMETRY, normalizeIslandGeometry } from "@/lib/fleet/format"
import type {
  FleetMonitorStatus,
  FleetSnapshot,
  IslandGeometry,
  PermissionBehavior,
} from "@/lib/fleet/types"

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

/**
 * Answer a parked AskUserQuestion. `selections[i]` is the option indices the
 * user picked for question `i` (one for single-select, one or more for
 * multi-select). Returns false when the answer window already lapsed on the
 * Rust side (the row clears via the next snapshot; the terminal picker takes
 * over).
 */
export async function fleetQuestionRespond(
  requestId: string,
  selections: number[][]
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>("fleet_question_respond", { requestId, selections })
  } catch (err) {
    console.warn("fleetQuestionRespond failed", err)
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

/**
 * Point `~/.codex/config.toml`'s `notify` at the generated forwarder.
 *
 * DORMANT BY DESIGN — no UI calls this, and none should. `notify` identifies a
 * session with `thread-id`, never `session_id`, so this integration produced
 * zero fleet rows for its entire life; {@link fleetCodexHooksInstall} replaced
 * it. The command is retained only so the path can be revived if Codex's hook
 * trust model changes; the settings card is pinned by a test that asserts it
 * never reaches this function. Its counterpart {@link fleetCodexUninstall} is
 * still live — it clears the leftovers on machines that ran the old build.
 */
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

/**
 * Install state of the Codex **hooks** integration (mirrors
 * `fleet/codex_hooks.rs`) — the replacement for the `notify` path above, which
 * never produced a single fleet row (Codex's notify payload identifies its
 * session with `thread-id`, not `session_id`).
 *
 * `installed` means *written to `~/.codex/hooks.json`*, not *firing*: Codex
 * gates hooks behind a trust the user grants in its TUI, and that trust is not
 * readable from disk. Callers must render liveness from observed events, never
 * from this value alone.
 *
 * `stale` means our handler is present but with a different command (or covers
 * only some events). Codex keys hook trust by content, so a drifted command is
 * also an untrusted one — it will not fire until reinstalled and re-approved.
 */
export type CodexHooksStatus = "installed" | "stale" | "not-installed" | "unavailable"

/**
 * Register the fleet forwarder in `~/.codex/hooks.json`.
 *
 * Merges into the file rather than replacing it — on real machines `hooks.json`
 * is frequently already owned by another tool, and Codex runs every matching
 * hook, so clobbering it would silently break that product.
 */
export async function fleetCodexHooksInstall(): Promise<CodexHooksStatus> {
  if (!isTauri()) return "unavailable"
  return invoke<CodexHooksStatus>("fleet_codex_hooks_install")
}

/** Remove only our handlers (leaving every foreign one) and delete the script. */
export async function fleetCodexHooksUninstall(): Promise<CodexHooksStatus> {
  if (!isTauri()) return "unavailable"
  return invoke<CodexHooksStatus>("fleet_codex_hooks_uninstall")
}

export async function fleetCodexHooksStatus(): Promise<CodexHooksStatus> {
  if (!isTauri()) return "unavailable"
  try {
    return await invoke<CodexHooksStatus>("fleet_codex_hooks_status")
  } catch (err) {
    console.warn("fleetCodexHooksStatus failed", err)
    return "unavailable"
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
 * Structured refusal reasons from the interrupt path (mirrors Rust
 * `InterruptRefusal::code`). Anything else is an OS-level send failure.
 */
export type FleetInterruptRefusal =
  "interrupt_unsupported" | "interrupt_not_running" | "interrupt_identity_mismatch"

export type FleetInterruptResult =
  { ok: true } | { ok: false; reason: FleetInterruptRefusal | "unknown" }

const INTERRUPT_REFUSALS: readonly string[] = [
  "interrupt_unsupported",
  "interrupt_not_running",
  "interrupt_identity_mismatch",
]

/**
 * Interrupt a session's current turn — one `SIGINT` to the agent process,
 * exactly what pressing Ctrl-C once in that terminal does.
 *
 * Deliberately reports "sent", never "stopped": there is no acknowledgement
 * channel back from an agent this app did not start, and the session's own next
 * event is the only real evidence. Rust re-verifies the pid is alive and still
 * looks like that agent before signalling, so a recycled pid is refused rather
 * than hit — those refusals come back as {@link FleetInterruptRefusal} codes so
 * the UI can say which one happened.
 */
export async function fleetInterruptSession(
  agent: string,
  sessionId: string
): Promise<FleetInterruptResult> {
  if (!isTauri()) return { ok: false, reason: "interrupt_unsupported" }
  try {
    await invoke("fleet_interrupt_session", { agent, sessionId })
    return { ok: true }
  } catch (err) {
    console.warn("fleetInterruptSession failed", err)
    const message = typeof err === "string" ? err : ((err as Error)?.message ?? "")
    const reason = INTERRUPT_REFUSALS.find((code) => message.includes(code))
    return { ok: false, reason: (reason as FleetInterruptRefusal) ?? "unknown" }
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
 * display's {@link IslandGeometry}: the top safe-area inset (logical px — the
 * notch height) that Rust grew the window by, and whether a full-screen app
 * currently owns that display.
 *
 * The shell pads its card below the inset so the content clears the camera
 * housing while the window still spans the notch strip (keeping slam-to-top
 * hover on target), and suppresses the idle pill entirely while full-screen.
 * Returning both from the resize round-trip the shell already makes after every
 * layout means the full-screen regime is known synchronously at mount instead
 * of racing the first `fleet://island-geometry` push.
 */
export async function islandResize(width: number, height: number): Promise<IslandGeometry> {
  if (!isTauri()) return EMPTY_ISLAND_GEOMETRY
  try {
    return normalizeIslandGeometry(await invoke<IslandGeometry>("island_resize", { width, height }))
  } catch (err) {
    console.warn("islandResize failed", err)
    return EMPTY_ISLAND_GEOMETRY
  }
}

/**
 * Mirror the shell's tucked state to the window layer. A tucked island's
 * window is made click-through (`set_ignore_cursor_events`) so the invisible
 * pill strip under the notch can't swallow clicks aimed at the menu bar /
 * fullscreen toolbar behind it; untucking restores interactivity. The
 * slam-to-top reveal keeps working because Rust polls the global cursor and
 * pushes `fleet://island-hover` transitions to the shell.
 */
export async function islandSetTucked(tucked: boolean): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("island_set_tucked", { tucked })
    return true
  } catch (err) {
    console.warn("islandSetTucked failed", err)
    return false
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

/**
 * Boot restore: reopen the island overlay if it was showing at last quit.
 * Resolves `false` when it was closed (a no-op, not a failure), so the boot
 * path can call it unconditionally next to {@link fleetMonitorRestore}.
 */
export async function islandRestore(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>("island_restore")
  } catch (err) {
    console.warn("islandRestore failed", err)
    return false
  }
}

/**
 * Every input the island's placement math reads, for one moment (mirrors Rust
 * `IslandDebugGeometry`). Deliberately loosely typed on the display rows: this
 * is a diagnostic dump meant to be copied to a human, not a stable contract.
 */
export interface IslandDebugGeometry {
  displays: {
    name: string | null
    cacheKey: string
    isPrimary: boolean
    isTarget: boolean
    scale: number
    /** Physical px: x, y, width, height. */
    frame: [number, number, number, number]
    workArea: [number, number, number, number]
    safeAreaTopRaw: number
    safeAreaTopCached: number
    menuBarOccupiesTop: boolean
    fullscreen: boolean
  }[]
  preferredMonitor: string | null
  windowPosition: [number, number] | null
  windowSize: [number, number] | null
  windowVisible: boolean
  geometry: IslandGeometry
}

/**
 * Dump the island's placement inputs.
 *
 * The placement failures this exists for are invisible to the test suite —
 * `island_window.rs`'s live window ops can't run under `tauri::test::mock_app()`,
 * and the quantities that go wrong (`safeAreaInsets` under a hidden menu bar,
 * the Space-dependent work area) only exist on a real desktop in a real Space.
 * `null` off Tauri or on failure.
 */
export async function islandDebugGeometry(): Promise<IslandDebugGeometry | null> {
  if (!isTauri()) return null
  try {
    return await invoke<IslandDebugGeometry>("island_debug_geometry")
  } catch (err) {
    console.warn("islandDebugGeometry failed", err)
    return null
  }
}
