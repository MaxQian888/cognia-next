"use client"

// Tauri client for the Capacity Dock (ADR-0165 Phase 2).
//
// Every call is a no-op outside Tauri, so the browser and mobile shells import
// this module without a guard at each call site and the dock simply does not
// exist there. The window itself is opened from the main window and driven
// from inside the dock window, so both sides live here.

import { loggers } from "@cognia/logging"

import { isTauri } from "@/lib/tauri"
import { transport } from "@/lib/tauri/transport-instance"

import type {
  DockEdge,
  UsageDockCapabilities,
  UsageDockGeometry,
  UsageDockMonitor,
  UsageDockState,
} from "./types"

export const USAGE_DOCK_WINDOW_LABEL = "usage-dock"
export const MAIN_WINDOW_LABEL = "main"

/** Rust → dock: cursor entered or left the rail. */
export const USAGE_DOCK_HOVER_EVENT = "usage-dock://hover"
/** Rust → dock: the placement moved, possibly to another monitor. */
export const USAGE_DOCK_GEOMETRY_EVENT = "usage-dock://geometry"
/** Main → dock: a fresh projection plus the current preferences. */
export const USAGE_DOCK_STATE_EVENT = "usage-dock://state"
/** Dock → main: "I am mounted, send me state". */
export const USAGE_DOCK_STATE_REQUEST_EVENT = "usage-dock://state-request"
/** Dock → main: the user clicked through to the full usage view. */
export const USAGE_DOCK_OPEN_FULL_EVENT = "usage-dock://open-full"

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null
  try {
    return await transport.call<T>(command, args)
  } catch (error) {
    loggers.tray?.warn?.(`${command} failed`, { error: String(error) })
    return null
  }
}

/**
 * Deliver an event to another window, by label.
 *
 * `Transport` has `call` and `subscribe` and deliberately no emit: every other
 * caller is talking to a runtime, and this is talking to a sibling WINDOW.
 * There is no host-neutral meaning for "send this to the window labelled
 * usage-dock" on a host that has one window, so the import is dynamic and sits
 * behind the `isTauri()` guard every caller already has, which also keeps
 * `@tauri-apps/api/event` out of the browser and mobile bundles.
 * `lib/pet/reveal.ts` reaches the window API the same way, for the same reason.
 */
async function emitToWindow(label: string, event: string, payload: unknown): Promise<void> {
  const { emitTo } = await import("@tauri-apps/api/event")
  await emitTo(label, event, payload)
}

/* ── Main-window side ──────────────────────────────────────────────────── */

export async function openUsageDock(): Promise<void> {
  await call("usage_dock_open")
}

export async function closeUsageDock(): Promise<void> {
  await call("usage_dock_close")
}

export async function isUsageDockOpen(): Promise<boolean> {
  return (await call<boolean>("usage_dock_is_open")) ?? false
}

export async function listUsageDockMonitors(): Promise<UsageDockMonitor[]> {
  return (await call<UsageDockMonitor[]>("usage_dock_list_monitors")) ?? []
}

export async function setUsageDockMonitor(monitor: string | null): Promise<void> {
  await call("usage_dock_set_monitor", { monitor })
}

export async function setUsageDockScale(scale: number): Promise<number | null> {
  return call<number>("usage_dock_set_scale", { scale })
}

export async function setUsageDockPlacement(edge: DockEdge, offset?: number): Promise<void> {
  await call("usage_dock_set_placement", { edge, offset })
}

/**
 * What this desktop can actually do for the dock.
 *
 * Returns a conservative "blocked" report outside Tauri rather than null, so
 * the settings card renders one explanation instead of branching on a null
 * that means two different things (web shell versus refused compositor).
 */
export async function usageDockCapabilities(): Promise<UsageDockCapabilities> {
  const native = await call<UsageDockCapabilities>("usage_dock_capabilities")
  return (
    native ?? {
      positioning: false,
      alwaysOnTop: false,
      globalHover: false,
      platform: "web",
      blockedReason: "notDesktop",
    }
  )
}

/** Main → dock: push a fresh projection. */
export async function sendUsageDockState(state: UsageDockState): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitToWindow(USAGE_DOCK_WINDOW_LABEL, USAGE_DOCK_STATE_EVENT, state)
    return true
  } catch {
    // The dock is usually closed. Pushing to a window that is not there is the
    // normal case, not an error.
    return false
  }
}

/** Main-window side: the dock asking to be seeded. */
export async function onUsageDockStateRequest(handler: () => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  return transport.subscribe(USAGE_DOCK_STATE_REQUEST_EVENT, () => handler())
}

/** Main-window side: the dock asking to open the full usage view. */
export async function onUsageDockOpenFull(handler: () => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  return transport.subscribe(USAGE_DOCK_OPEN_FULL_EVENT, () => handler())
}

/* ── Dock-window side ──────────────────────────────────────────────────── */

/** First-paint reveal. Windows renders a transparent window black before this. */
export async function revealUsageDock(): Promise<void> {
  await call("usage_dock_reveal")
}

/** Resize to measured content. Rust re-places the rail against its edge. */
export async function resizeUsageDock(width: number, height: number): Promise<void> {
  await call("usage_dock_resize", { width, height })
}

/** Collapse makes the rail transparent to the cursor. */
export async function setUsageDockClickThrough(ignore: boolean): Promise<void> {
  await call("usage_dock_set_click_through", { ignore })
}

/** Commit a drag. Returns the edge that was actually snapped to. */
export async function snapUsageDock(x: number, y: number): Promise<DockEdge | null> {
  return call<DockEdge>("usage_dock_snap", { x, y })
}

export async function requestUsageDockState(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitToWindow(MAIN_WINDOW_LABEL, USAGE_DOCK_STATE_REQUEST_EVENT, null)
    return true
  } catch (error) {
    loggers.tray?.warn?.("requestUsageDockState failed", { error: String(error) })
    return false
  }
}

export async function requestUsageDockOpenFull(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitToWindow(MAIN_WINDOW_LABEL, USAGE_DOCK_OPEN_FULL_EVENT, null)
    return true
  } catch {
    return false
  }
}

export async function onUsageDockState(
  handler: (state: UsageDockState) => void
): Promise<() => void> {
  if (!isTauri()) return () => {}
  return transport.subscribe<UsageDockState>(USAGE_DOCK_STATE_EVENT, handler)
}

export async function onUsageDockHover(handler: (hovering: boolean) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  return transport.subscribe<{ hovering: boolean }>(USAGE_DOCK_HOVER_EVENT, (payload) =>
    handler(payload.hovering)
  )
}

export async function onUsageDockGeometry(
  handler: (geometry: UsageDockGeometry) => void
): Promise<() => void> {
  if (!isTauri()) return () => {}
  return transport.subscribe<UsageDockGeometry>(USAGE_DOCK_GEOMETRY_EVENT, handler)
}
