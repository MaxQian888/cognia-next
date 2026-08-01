/**
 * A saved dock arrangement.
 *
 * A preset is a *structural template*, not a snapshot. It records which panels
 * sit where, in what proportions, and which edge the dock occupies — and
 * nothing else. No instance ids, no resource references, no open files, no
 * terminal sessions, no window coordinates.
 *
 * That boundary is deliberate and load-bearing: presets are the one dock
 * artefact meant to travel — between contexts, between machines, and out
 * through an export file that someone else can import. Anything identifying
 * would either leak (a file path, a session id) or be meaningless on arrival (an
 * instance id from another machine's layout).
 */

import type { DockHost, DockShellEdge } from "./layout"
import type { DockTabMode } from "./instance"

export const DOCK_PRESET_SCHEMA_VERSION = 1

/** One tab in a preset group. Panel id only — never a resource. */
export interface DockPresetSlot {
  panelId: string
  mode: DockTabMode
}

export type DockPresetNode =
  | { type: "group"; panels: DockPresetSlot[]; size?: number }
  | {
      type: "split"
      orientation: "horizontal" | "vertical"
      children: DockPresetNode[]
      size?: number
    }

export interface DockPreset {
  /** UUID. Regenerated on import so two machines can never collide. */
  id: string
  name: string
  host: DockHost
  schemaVersion: number
  /** `null` is the empty preset: the rail with nothing docked. */
  root: DockPresetNode | null
  shell: { edge: DockShellEdge; sizePercent: number }
  /** Shipped with the app; cannot be renamed or deleted. */
  builtin?: boolean
  createdAt: number
  updatedAt: number
}

/** The on-disk shape of an exported preset file. */
export interface DockPresetFile {
  kind: "cognia.dock.preset"
  schemaVersion: number
  preset: DockPreset
}

export const DOCK_PRESET_FILE_KIND = "cognia.dock.preset" as const

/** Longest name the UI will render without truncating into uselessness. */
export const DOCK_PRESET_NAME_MAX_LENGTH = 80
