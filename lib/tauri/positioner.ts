"use client"

import { moveWindow, Position } from "@tauri-apps/plugin-positioner"
import { isTauri } from "@/lib/tauri"

export { Position }

/**
 * Move the focused window to one of the predefined positions exposed by the
 * positioner plugin (TopLeft, TopRight, Center, TrayCenter, etc.). Returns
 * `true` on success, `false` outside Tauri / on plugin failure.
 */
export async function moveWindowToPosition(position: Position): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await moveWindow(position)
    return true
  } catch (err) {
    console.warn("moveWindowToPosition failed", err)
    return false
  }
}
