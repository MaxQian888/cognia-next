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

/** Resize the overlay window (e.g. to grow for an open quick menu). */
export async function resizePetWindow(width: number, height: number): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke("pet_window_resize", { width, height })
    return true
  } catch (err) {
    console.warn("resizePetWindow failed", err)
    return false
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
