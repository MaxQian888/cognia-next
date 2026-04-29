"use client"

import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/tauri"

/**
 * Tauri-side event names emitted from `src-tauri/src/{lib,tray,menu}.rs`.
 * Keep this enum in sync with the Rust emitters.
 */
export const TAURI_EVENTS = {
  trayNewChat: "tray://new-chat",
  traySettings: "tray://settings",
  /**
   * Emitted by the system tray "Open Log Panel" item, the View menu's
   * "Open Log Panel" item (which routes through this same channel), AND the
   * Ctrl+Shift+L global shortcut. Frontend listener navigates to /logs.
   */
  trayOpenLogs: "tray://open-logs",
  /** View menu → Open Log Panel. Same destination, separate channel. */
  menuOpenLogs: "menu://open-logs",
  menuPrefix: "menu://",
  cliMatches: "cli://matches",
  cliSecondInstance: "cli://second-instance",
  deepLink: "deep-link://received",
} as const

export async function onTauriEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  if (!isTauri()) return async () => {}
  return await listen<T>(event, (e) => handler(e.payload))
}
