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
  "pet-disable-click-through",
  "island-toggle",
  "noop",
  "quit",
] as const satisfies readonly TrayNativeAction[]

/** Narrow an arbitrary string to a known native action. */
export function isNativeTrayAction(value: string): value is TrayNativeAction {
  return (NATIVE_TRAY_ACTIONS as readonly string[]).includes(value)
}

/**
 * Native actions that no longer exist, each mapped to the command that
 * replaced it. The single source both persisted stores migrate from
 * (`lib/tray/store.ts` for the menu layout, `lib/tray-panel/defaults.ts` for
 * panel actions), because both persist whole payloads: a stale native action
 * left in either would make the Rust menu builder reject the entire push
 * (`BuildError::UnknownNativeAction`) or `tray_run_native_action` fail.
 *
 * - `pet-toggle`: a second pet opener in Rust that ignored the saved overlay
 *   size, position and click-through and never switched the pet on, so it
 *   could raise an overlay with no controller behind it. The command owns the
 *   one summon path (ADR-0058 D3/D9).
 */
export const RETIRED_NATIVE_TRAY_ACTIONS: Readonly<Record<string, string>> = {
  "pet-toggle": "pet.toggle-window",
}

/** The command id that replaced a retired native action, if it is one. */
export function retiredNativeReplacement(action: string): string | undefined {
  return Object.hasOwn(RETIRED_NATIVE_TRAY_ACTIONS, action)
    ? RETIRED_NATIVE_TRAY_ACTIONS[action]
    : undefined
}
