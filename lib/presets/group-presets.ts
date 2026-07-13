// Grouping helper shared by the chat-header config Popover (system-prompt
// preset Select) and the chat-header active-preset pill Popover. Returns a
// stable, deduplicated grouping: favorites first, then default presets not
// already in favorites, then per-category groups, then everything else.

import type { SystemPromptPreset } from "@cognia/agent-config-types"
import { PRESET_CATEGORIES } from "@/lib/presets/categories"

export interface PresetGroup {
  /**
   * Either a translation sub-key (when `translateLabel` is true; the caller
   * translates via `chat.header.groups.*`) or a verbatim category id.
   */
  label: string
  /** When true, `label` is a key inside the `chat.header.groups.*` namespace. */
  translateLabel?: boolean
  presets: SystemPromptPreset[]
}

export function groupPresets(presets: SystemPromptPreset[]): PresetGroup[] {
  const groups: PresetGroup[] = []
  const seen = new Set<string>()

  const favorites = presets.filter((p) => p.isFavorite && !seen.has(p.id))
  if (favorites.length > 0) {
    groups.push({ label: "favorites", translateLabel: true, presets: favorites })
    favorites.forEach((p) => seen.add(p.id))
  }

  const defaults = presets.filter((p) => p.isDefault && !seen.has(p.id))
  if (defaults.length > 0) {
    groups.push({ label: "default", translateLabel: true, presets: defaults })
    defaults.forEach((p) => seen.add(p.id))
  }

  for (const cat of PRESET_CATEGORIES) {
    const inCat = presets.filter((p) => p.category === cat.id && !seen.has(p.id))
    if (inCat.length > 0) {
      groups.push({ label: cat.id, presets: inCat })
      inCat.forEach((p) => seen.add(p.id))
    }
  }

  const rest = presets.filter((p) => !seen.has(p.id))
  if (rest.length > 0) {
    groups.push({ label: "other", translateLabel: true, presets: rest })
  }
  return groups
}
