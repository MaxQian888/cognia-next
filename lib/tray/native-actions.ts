// Runtime list of the tray's native actions.
//
// `TrayNativeAction` in `./types.ts` is the compile-time union; this is the
// value the settings pickers iterate. The two are pinned together by the
// `satisfies` below plus an exhaustiveness test, and BOTH mirror
// `src-tauri/src/tray/dto.rs:NATIVE_ACTIONS` — an action missing there is
// rejected by the Rust menu builder at runtime rather than failing to compile.

import type { TrayNativeAction } from "./types"

export const NATIVE_TRAY_ACTIONS = [
  "show",
  "hide",
  "toggle-window",
  "tray-panel-toggle",
  "new-chat",
  "settings",
  "open-logs",
  "open-data-folder",
  "copy-diagnostics",
  "open-docs",
  "report-issue",
  "check-updates",
  "toggle-autostart",
  "automation-kill",
  "pet-toggle",
  "pet-disable-click-through",
  "island-toggle",
  "noop",
  "quit",
] as const satisfies readonly TrayNativeAction[]

/** Narrow an arbitrary string to a known native action. */
export function isNativeTrayAction(value: string): value is TrayNativeAction {
  return (NATIVE_TRAY_ACTIONS as readonly string[]).includes(value)
}
