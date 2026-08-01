/**
 * Preset naming.
 *
 * Importing a preset whose name is already taken must not overwrite the one the
 * user already has — that is their arrangement, and a file from elsewhere has
 * no claim on it. So a clash gets a suffix instead, and the caller supplies the
 * localised template so the numbering reads naturally in the user's language.
 */

import { DOCK_PRESET_NAME_MAX_LENGTH } from "@/types/dock/preset"

/** Trim, collapse whitespace, and clamp to the length the UI can render. */
export function normalizeDockPresetName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, DOCK_PRESET_NAME_MAX_LENGTH)
}

export interface UniqueDockPresetNameInput {
  name: string
  /** Names already in use, in the same host. Compared case-insensitively. */
  taken: Iterable<string>
  /**
   * Localised suffix template, e.g. `"{name} ({count})"`. Supplied by the
   * caller because the kernel has no translator and a hard-coded `" (2)"`
   * would be the one untranslated string in the dock.
   */
  format: (name: string, count: number) => string
}

/**
 * A name not already in use, suffixed if it has to be.
 *
 * Case-insensitive because "Review" and "review" reading as two different
 * presets in a list is a bug, not a feature.
 */
export function uniqueDockPresetName(input: UniqueDockPresetNameInput): string {
  const base = normalizeDockPresetName(input.name)
  const taken = new Set<string>()
  for (const name of input.taken) taken.add(name.trim().toLowerCase())

  if (!taken.has(base.toLowerCase())) return base

  for (let count = 2; count < 1000; count += 1) {
    const candidate = normalizeDockPresetName(input.format(base, count))
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  // Unreachable in practice — 998 presets of one name is not a real state — but
  // returning the base is better than looping forever or throwing at the user.
  return base
}
