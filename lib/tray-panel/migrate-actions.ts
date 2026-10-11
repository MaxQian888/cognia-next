/**
 * One-time import of the tray panel action catalogue from the Tauri store
 * (`trayPanel.actions.v1`) into `AppSettings.trayPanelActions` (ADR-0225 §10).
 *
 * Before ADR-0225 the catalogue lived in the Tauri store because the panel
 * window read it directly. The panel now receives it in the glance snapshot,
 * so settings can own it, which brings backup and account sync with it.
 *
 * The import runs in the main window once settings have loaded. It is
 * idempotent: the pref is deleted only after the catalogue is safely in
 * settings (or settings already had one, which wins), so an interrupted run
 * simply runs again next launch.
 */

import { TRAY_PANEL_ACTIONS_PREF } from "./defaults"
import type { TrayPanelAction } from "./types"

export interface MigrateTrayPanelActionsDeps {
  /** What settings hold now; `undefined` means the field was never written. */
  current: TrayPanelAction[] | undefined
  readPref: (key: string) => Promise<unknown>
  deletePref: (key: string) => Promise<void>
  save: (actions: TrayPanelAction[]) => Promise<void>
}

export type MigrateTrayPanelActionsOutcome =
  /** The stored catalogue moved into settings. */
  | "imported"
  /** Settings already had a catalogue (synced or migrated before); the pref was dropped. */
  | "kept-settings"
  /** No pref, nothing to do. */
  | "nothing"

export async function migrateTrayPanelActions(
  deps: MigrateTrayPanelActionsDeps
): Promise<MigrateTrayPanelActionsOutcome> {
  const stored = await deps.readPref(TRAY_PANEL_ACTIONS_PREF)
  if (stored === null || stored === undefined) return "nothing"
  if (deps.current !== undefined) {
    await deps.deletePref(TRAY_PANEL_ACTIONS_PREF)
    return "kept-settings"
  }
  // An empty or unreadable pref is a pref with nothing to carry over: the
  // shipped catalogue is what it meant.
  if (Array.isArray(stored) && stored.length > 0) {
    // Stored as-is; `resolveTrayPanelActions` repairs on every read, so the
    // import never has to guess what a malformed entry meant.
    await deps.save(stored as TrayPanelAction[])
    await deps.deletePref(TRAY_PANEL_ACTIONS_PREF)
    return "imported"
  }
  await deps.deletePref(TRAY_PANEL_ACTIONS_PREF)
  return "nothing"
}
