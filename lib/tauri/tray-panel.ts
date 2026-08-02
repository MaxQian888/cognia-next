"use client"

/**
 * Thin, isTauri-guarded wrappers around the Rust `tray::panel` commands plus
 * the panel↔main-window event channel.
 *
 * Same house style as `lib/tauri/pet-window.ts`: return a benign value off
 * Tauri and swallow command failures with a warn, so a flaky window op can
 * never break the renderer. The Rust side uses `serde rename_all = "camelCase"`,
 * so arguments are passed camelCased.
 */

import { invoke } from "@tauri-apps/api/core"
import { emitTo, listen } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"

import type {
  TrayLeftClickAction,
  TrayPanelConfig,
  TrayPanelRunRequest,
  TrayPanelRunResult,
} from "@/lib/tray-panel/types"

/** Window label of the quick panel — lockstep with `tray/panel.rs`. */
export const TRAY_PANEL_WINDOW_LABEL = "tray-panel"
/** The main app window's label, the delegate target for panel requests. */
export const MAIN_WINDOW_LABEL = "main"

/** Panel → main: run a resolved action. */
export const TRAY_PANEL_RUN_EVENT = "tray-panel://run"
/** Main → panel: that request settled. */
export const TRAY_PANEL_RESULT_EVENT = "tray-panel://result"
/** Rust → renderer: the panel was hidden by something the renderer didn't do. */
export const TRAY_PANEL_HIDDEN_EVENT = "tray-panel://hidden"
/** Rust → renderer: the panel was just revealed. */
export const TRAY_PANEL_SHOWN_EVENT = "tray-panel://shown"
/** Panel → main: "send me the current app state so I can filter my actions". */
export const TRAY_PANEL_STATE_REQUEST_EVENT = "tray-panel://state-request"
/** Main → panel: the current `TrayStateSnapshot`. */
export const TRAY_PANEL_STATE_EVENT = "tray-panel://state"

/** Defaults mirroring `TrayPanelConfig::default()` on the Rust side. */
export const DEFAULT_TRAY_PANEL_CONFIG: TrayPanelConfig = {
  leftClick: "panel",
  width: 380,
  height: 460,
}

/** Open (or re-show + reposition) the quick panel under the tray icon. */
export async function openTrayPanel(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("open_tray_panel")
    return true
  } catch (err) {
    loggers.tray?.warn?.("openTrayPanel failed", { error: String(err) })
    return false
  }
}

/** Hide the quick panel (Escape, after running an action, or explicit close). */
export async function closeTrayPanel(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("close_tray_panel")
    return true
  } catch (err) {
    loggers.tray?.warn?.("closeTrayPanel failed", { error: String(err) })
    return false
  }
}

/** Toggle the panel — the same entry point the tray icon click uses. */
export async function toggleTrayPanel(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("toggle_tray_panel")
    return true
  } catch (err) {
    loggers.tray?.warn?.("toggleTrayPanel failed", { error: String(err) })
    return false
  }
}

/** Reveal the panel after its first painted frame (macOS NSPanel path). */
export async function revealTrayPanel(focus: boolean): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("reveal_tray_panel", { focus })
    return true
  } catch (err) {
    loggers.tray?.warn?.("revealTrayPanel failed", { error: String(err) })
    return false
  }
}

/** Fit the native window to the panel's measured content (logical px). */
export async function resizeTrayPanel(width: number, height: number): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("tray_panel_resize", { width, height })
    return true
  } catch (err) {
    loggers.tray?.warn?.("resizeTrayPanel failed", { error: String(err) })
    return false
  }
}

/** Read the persisted panel config. Falls back to the shipped defaults. */
export async function getTrayPanelConfig(): Promise<TrayPanelConfig> {
  if (!isTauri()) return DEFAULT_TRAY_PANEL_CONFIG
  try {
    return await invoke<TrayPanelConfig>("tray_panel_get_config")
  } catch (err) {
    loggers.tray?.warn?.("getTrayPanelConfig failed", { error: String(err) })
    return DEFAULT_TRAY_PANEL_CONFIG
  }
}

/** Persist what a left-click on the tray icon does. */
export async function setTrayLeftClickAction(action: TrayLeftClickAction): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("tray_panel_set_left_click", { action })
    return true
  } catch (err) {
    loggers.tray?.warn?.("setTrayLeftClickAction failed", { error: String(err) })
    return false
  }
}

/**
 * Run one of the tray's native actions.
 *
 * Goes straight to Rust rather than through the main window: these actions are
 * implemented there already (window show/hide, automation kill switch, the pet
 * and island toggles), they emit the legacy `tray://*` events existing
 * listeners consume, and routing them this way means they still work when the
 * main window is wedged or still booting.
 */
export async function runNativeTrayAction(action: string): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("tray_run_native_action", { action })
    return true
  } catch (err) {
    loggers.tray?.warn?.("runNativeTrayAction failed", { action, error: String(err) })
    return false
  }
}

/**
 * Hand a resolved action to the main window.
 *
 * Addressed with `emitTo(MAIN_WINDOW_LABEL, …)` rather than a broadcast: the
 * pet overlay, popup and island all load the same root layout, so a broadcast
 * would run the request once per open window — and delegating a task is very
 * much not idempotent. Mirrors how the selection toolbar reports back.
 */
export async function sendTrayPanelRequest(request: TrayPanelRunRequest): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitTo(MAIN_WINDOW_LABEL, TRAY_PANEL_RUN_EVENT, request)
    return true
  } catch (err) {
    loggers.tray?.warn?.("sendTrayPanelRequest failed", { error: String(err) })
    return false
  }
}

/** Main window → panel: report an action's outcome. */
export async function sendTrayPanelResult(result: TrayPanelRunResult): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitTo(TRAY_PANEL_WINDOW_LABEL, TRAY_PANEL_RESULT_EVENT, result)
    return true
  } catch {
    // The panel is normally already dismissed by the time a request settles —
    // emitting to a closed window is expected, not an error worth logging.
    return false
  }
}

/**
 * Panel → main: ask for the current app-state snapshot.
 *
 * The panel is a least-privilege webview with no Dexie and no app stores, so it
 * cannot build a `TrayStateSnapshot` itself — but its actions' `when`
 * expressions are evaluated against one. Rather than duplicate the whole
 * snapshot pipeline, it asks the window that already maintains it
 * (`useTrayStateSnapshot`, driven by the tray sync loop).
 */
export async function requestTrayPanelState(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitTo(MAIN_WINDOW_LABEL, TRAY_PANEL_STATE_REQUEST_EVENT, null)
    return true
  } catch (err) {
    loggers.tray?.warn?.("requestTrayPanelState failed", { error: String(err) })
    return false
  }
}

/** Main → panel: reply with (or push) the current snapshot. */
export async function sendTrayPanelState(snapshot: unknown): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitTo(TRAY_PANEL_WINDOW_LABEL, TRAY_PANEL_STATE_EVENT, snapshot)
    return true
  } catch {
    // The panel is usually closed — pushing to a window that isn't there is
    // the normal case, not an error.
    return false
  }
}

/** Subscribe to snapshot pushes (panel window side). */
export async function onTrayPanelState<T>(handler: (snapshot: T) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const unlisten = await listen<T>(TRAY_PANEL_STATE_EVENT, (event) => handler(event.payload))
  return unlisten
}

/** Subscribe to snapshot requests (main window side). */
export async function onTrayPanelStateRequest(handler: () => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const unlisten = await listen(TRAY_PANEL_STATE_REQUEST_EVENT, () => handler())
  return unlisten
}

/** Subscribe to run requests (main window side). */
export async function onTrayPanelRequest(
  handler: (request: TrayPanelRunRequest) => void
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const unlisten = await listen<TrayPanelRunRequest>(TRAY_PANEL_RUN_EVENT, (event) =>
    handler(event.payload)
  )
  return unlisten
}

/** Subscribe to run results (panel window side). */
export async function onTrayPanelResult(
  handler: (result: TrayPanelRunResult) => void
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const unlisten = await listen<TrayPanelRunResult>(TRAY_PANEL_RESULT_EVENT, (event) =>
    handler(event.payload)
  )
  return unlisten
}

/** Subscribe to native hide/show notifications (panel window side). */
export async function onTrayPanelVisibility(
  handler: (visible: boolean) => void
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const [offHidden, offShown] = await Promise.all([
    listen(TRAY_PANEL_HIDDEN_EVENT, () => handler(false)),
    listen(TRAY_PANEL_SHOWN_EVENT, () => handler(true)),
  ])
  return () => {
    offHidden()
    offShown()
  }
}
