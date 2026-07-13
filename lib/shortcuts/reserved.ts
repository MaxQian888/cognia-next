// Per-platform catalog of shortcuts the OS (or a ubiquitous system feature)
// already owns. Binding one of these usually means the app's registration
// silently loses to the system — the one class of "conflict with other
// software" we can detect deterministically, without probing the OS. The
// recorder shows a NON-blocking warning on a match (unlike an in-app conflict,
// which blocks the save).
//
// Chords are in the app's normalized, Cmd/Ctrl-folded form: "ctrl+space" covers
// both ⌘Space and Ctrl+Space, so a macOS Spotlight warning fires on the folded
// chord even though the physical key was ⌘.

import { detectOs } from "@/lib/plugin/context-keys/derive-context-keys"
import { normalizeKeyCombo } from "./utils"
import type { Chord } from "./types"

export type ReservedOs = "macos" | "windows" | "linux"

const RESERVED: Record<ReservedOs, Record<Chord, string>> = {
  macos: {
    "ctrl+space": "Spotlight",
    "ctrl+tab": "App switcher",
    "ctrl+q": "Quit application",
    "ctrl+w": "Close window",
    "ctrl+h": "Hide application",
    "ctrl+m": "Minimize window",
    "ctrl+shift+3": "Screenshot",
    "ctrl+shift+4": "Screenshot (area)",
    "ctrl+shift+5": "Screenshot toolbar",
  },
  windows: {
    "ctrl+alt+delete": "Security screen",
    "alt+tab": "App switcher",
    "alt+f4": "Close window",
    "ctrl+escape": "Start menu",
    "alt+escape": "Cycle windows",
    "ctrl+shift+escape": "Task Manager",
  },
  linux: {
    "ctrl+alt+t": "Terminal",
    "ctrl+alt+delete": "Log out",
    "alt+tab": "App switcher",
    "alt+f4": "Close window",
  },
}

export interface ReservedConflict {
  /** Normalized chord that matched. */
  chord: Chord
  /** Human name of the owning system feature (e.g. "Spotlight"). */
  feature: string
  os: ReservedOs
}

function currentOs(): ReservedOs | "unknown" {
  const os = detectOs()
  return os === "unknown" ? "unknown" : os
}

/**
 * A system-reserved conflict for `chord` on the given platform, or null. Defaults
 * to the detected OS; pass an explicit `os` for tests / deterministic checks.
 */
export function getReservedShortcutConflict(
  chord: Chord,
  os: ReservedOs | "unknown" = currentOs()
): ReservedConflict | null {
  if (os === "unknown" || chord === "") return null
  const normalized = normalizeKeyCombo(chord)
  const feature = RESERVED[os][normalized]
  return feature ? { chord: normalized, feature, os } : null
}
