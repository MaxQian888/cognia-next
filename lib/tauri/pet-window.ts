"use client"

/**
 * Thin, isTauri-guarded wrappers around the Rust `pet_window` commands that
 * own the transparent desktop-pet overlay window (label "pet"). Each wrapper
 * mirrors the `lib/tauri/positioner.ts` style: early-return a benign value off
 * Tauri, swallow command failures with a warn so a flaky window op can never
 * break the renderer. The Rust side uses `serde rename_all = "camelCase"`, so
 * arguments are passed camelCased.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "./safe-unlisten"

/** Options for opening the desktop-pet overlay window. */
export interface PetWindowOpts {
  width: number
  height: number
  x?: number
  y?: number
  clickThrough: boolean
}

/** Open (or show + focus, if already open) the desktop-pet overlay window. */
export async function openPetWindow(opts: PetWindowOpts): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("open_pet_window", { opts })
    return true
  } catch (err) {
    console.warn("openPetWindow failed", err)
    return false
  }
}

/** Hide the overlay window (toggle off). The window survives for re-show. */
export async function closePetWindow(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("close_pet_window")
    return true
  } catch (err) {
    console.warn("closePetWindow failed", err)
    return false
  }
}

/** Destroy the overlay window entirely (settings-disable path). */
export async function destroyPetWindow(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("destroy_pet_window")
    return true
  } catch (err) {
    console.warn("destroyPetWindow failed", err)
    return false
  }
}

/** Toggle click-through (cursor events ignored) on the overlay window. */
export async function setPetClickThrough(ignore: boolean): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("pet_window_set_ignore_cursor_events", { ignore })
    return true
  } catch (err) {
    console.warn("setPetClickThrough failed", err)
    return false
  }
}

/** Move the overlay window to an absolute screen position. */
export async function setPetWindowPosition(x: number, y: number): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("pet_window_set_position", { x, y })
    return true
  } catch (err) {
    console.warn("setPetWindowPosition failed", err)
    return false
  }
}

/** Read the overlay window's current absolute screen position. */
export async function getPetWindowPosition(): Promise<{ x: number; y: number } | null> {
  if (!isTauri()) return null
  try {
    return await invoke<{ x: number; y: number }>("pet_window_get_position")
  } catch (err) {
    console.warn("getPetWindowPosition failed", err)
    return null
  }
}

/** Read the global cursor position for local-only gaze tracking. */
export async function getPetCursorPosition(): Promise<{ x: number; y: number } | null> {
  if (!isTauri()) return null
  try {
    return await invoke<{ x: number; y: number }>("pet_window_get_cursor_position")
  } catch (err) {
    console.warn("getPetCursorPosition failed", err)
    return null
  }
}

/**
 * Work area of the monitor the pet window sits on (physical px + scale
 * factor). Mirrors the Rust `PetWorkArea` DTO. `null` off Tauri / headless.
 */
export interface PetWorkArea {
  x: number
  y: number
  width: number
  height: number
  scaleFactor: number
}

/** Read the work area of the monitor hosting the overlay window. */
export async function getPetWorkArea(): Promise<PetWorkArea | null> {
  if (!isTauri()) return null
  try {
    return await invoke<PetWorkArea | null>("pet_window_get_work_area")
  } catch (err) {
    console.warn("getPetWorkArea failed", err)
    return null
  }
}

/**
 * One perchable window-top surface (physical px). Mirrors the Rust `PetSurface`
 * DTO. `y` is the window's top edge; `x`/`width` its horizontal span.
 */
export interface PetSurface {
  x: number
  y: number
  width: number
}

/**
 * Enumerate perchable window-top surfaces on the pet's monitor (Windows only;
 * empty elsewhere). Returns `[]` off Tauri or on any failure — the overlay then
 * keeps its normal floor-wander behavior.
 */
export async function getPetSurfaces(): Promise<PetSurface[]> {
  if (!isTauri()) return []
  try {
    const res = await invoke<{ surfaces: PetSurface[] } | null>("pet_window_get_surfaces")
    return res?.surfaces ?? []
  } catch (err) {
    console.warn("getPetSurfaces failed", err)
    return []
  }
}

/** Whether the overlay window currently exists. */
export async function isPetWindowOpen(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>("is_pet_window_open")
  } catch (err) {
    console.warn("isPetWindowOpen failed", err)
    return false
  }
}

/**
 * Options for opening the desktop-pet click popup window (label "pet-popup").
 * `width`/`height` are logical; `x`/`y` are physical screen coords already
 * clamped on-screen by `lib/pet/popup-geometry.ts`. Mirrors the Rust
 * `PetPopupOpts` DTO.
 */
export interface PetPopupOpts {
  width: number
  height: number
  x: number
  y: number
}

/** Open (or show + reposition + focus) the desktop-pet click popup window. */
export async function openPetPopup(opts: PetPopupOpts): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("open_pet_popup", { opts })
    return true
  } catch (err) {
    console.warn("openPetPopup failed", err)
    return false
  }
}

/** Hide the click popup window (Esc / explicit close). */
export async function closePetPopup(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("close_pet_popup")
    return true
  } catch (err) {
    console.warn("closePetPopup failed", err)
    return false
  }
}

/** Resize the click popup window to fit its panel (talk composer toggle). */
export async function resizePetPopup(width: number, height: number): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("pet_popup_resize", { width, height })
    return true
  } catch (err) {
    console.warn("resizePetPopup failed", err)
    return false
  }
}

/** Window labels allowed to request a native pet-panel reveal. */
export type PetRevealTarget = "pet" | "pet-popup"

/**
 * Reveal a pet overlay after its first paint. The target is explicit because
 * an overlay can be hosted by a plain Webview rather than a Tauri
 * `WebviewWindow`; Rust resolves this label to its native window.
 */
export async function revealPetWindow(
  focus = false,
  targetLabel: PetRevealTarget = "pet"
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("reveal_pet_window", { focus, targetLabel })
    return true
  } catch (err) {
    console.warn("revealPetWindow failed", err)
    return false
  }
}

/**
 * Reveal the fleet island overlay after its first paint. Mirrors
 * `revealPetWindow` but for the `"island"` window; on macOS it orders the
 * island NSPanel front without activating Cognia.
 */
export async function revealIslandWindow(focus = false): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("reveal_island_window", { focus })
    return true
  } catch (err) {
    console.warn("revealIslandWindow failed", err)
    return false
  }
}

/** Bring the main app window back to the foreground (overlay "show main"). */
export async function showMainWindow(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("show_main_window")
    return true
  } catch (err) {
    console.warn("showMainWindow failed", err)
    return false
  }
}

// ── Native pet-window events ─────────────────────────────────────────────────
// The Rust side broadcasts window-state changes it initiates itself (tray
// toggle, click-through recovery, blur-hide, suspend/resume, monitor change)
// so renderer state never silently desyncs from native mutations. Each
// subscription returns a disposer; all are no-ops off Tauri.

/** Payload of `pet://state-changed` (mirrors the Rust `PetStateChanged` DTO). */
export interface PetNativeState {
  open: boolean
  clickThrough: boolean
}

type Disposer = () => void

/** Shared listen-with-guard helper: returns an inert disposer off Tauri. */
function subscribe(event: string, handler: (payload: unknown) => void): Disposer {
  if (!isTauri()) return () => {}
  let disposed = false
  let unlisten: (() => void) | null = null
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen(event, (e) => handler(e.payload)))
    .then((off) => {
      if (disposed) safeUnlisten(off)
      else unlisten = off
    })
    .catch((err) => console.warn(`subscribe(${event}) failed`, err))
  return () => {
    disposed = true
    safeUnlisten(unlisten)
    unlisten = null
  }
}

/** Native open/click-through changes (tray toggle, recovery, destroy). */
export function onPetNativeStateChanged(handler: (state: PetNativeState) => void): Disposer {
  return subscribe("pet://state-changed", (payload) => {
    const p = payload as Partial<PetNativeState> | null
    if (p && typeof p.open === "boolean" && typeof p.clickThrough === "boolean") {
      handler({ open: p.open, clickThrough: p.clickThrough })
    }
  })
}

/** The sprite window was hidden — pause animation loops (ticker / rAF). */
export function onPetSuspend(handler: () => void): Disposer {
  return subscribe("pet://suspend", () => handler())
}

/** The sprite window is visible again — resume animation loops. */
export function onPetResume(handler: () => void): Disposer {
  return subscribe("pet://resume", () => handler())
}

/** Monitor topology / DPI changed — re-read the work area immediately. */
export function onPetWorkAreaChanged(handler: () => void): Disposer {
  return subscribe("pet://work-area-changed", () => handler())
}

/** The popup was natively hidden (blur-to-close) — sync popup UI state. */
export function onPetPopupHidden(handler: () => void): Disposer {
  return subscribe("pet-popup://hidden", () => handler())
}
