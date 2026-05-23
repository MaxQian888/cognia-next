/**
 * Window diagnostics — reads main-window state from the Tauri runtime.
 *
 * Cognia tracks state for several auxiliary windows (toolbar, bubble, chat
 * widget, splashscreen). cognia-next has only the main window, so this
 * snapshot is a singleton record. Crash bundles include it so future
 * subsystems can extend the shape via the open index signature without
 * breaking the bundle format.
 */

import { getCurrentWindow } from "@tauri-apps/api/window"
import { getAllWebviews } from "@tauri-apps/api/webview"
import { isTauri } from "@/lib/tauri"
import type { WindowDiagnosticsSnapshot } from "@/lib/logging/crash-log"

export type { WindowDiagnosticsSnapshot }

interface WindowStateSnapshot {
  label: string
  isVisible: boolean
  isMinimized: boolean
  isMaximized: boolean
  isFocused: boolean
  position: [number, number] | null
  size: [number, number] | null
}

async function readMainWindow(): Promise<WindowStateSnapshot | null> {
  try {
    const window = getCurrentWindow()
    const [isVisible, isMinimized, isMaximized, isFocused, pos, size] = await Promise.all([
      window.isVisible().catch(() => false),
      window.isMinimized().catch(() => false),
      window.isMaximized().catch(() => false),
      window.isFocused().catch(() => false),
      window
        .outerPosition()
        .then((p) => [p.x, p.y] as [number, number])
        .catch(() => null),
      window
        .outerSize()
        .then((s) => [s.width, s.height] as [number, number])
        .catch(() => null),
    ])
    return {
      label: window.label,
      isVisible,
      isMinimized,
      isMaximized,
      isFocused,
      position: pos,
      size,
    }
  } catch {
    return null
  }
}

export async function getWindowDiagnostics(): Promise<WindowDiagnosticsSnapshot | null> {
  if (!isTauri()) return null

  const mainWindow = await readMainWindow()
  let totalWindows = 0
  try {
    const webviews = await getAllWebviews()
    totalWindows = webviews.length
  } catch {
    totalWindows = mainWindow ? 1 : 0
  }

  return {
    timestamp: Date.now(),
    totalWindows,
    mainWindow,
  }
}
