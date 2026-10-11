"use client"

import { useDeveloperMode } from "@/lib/plugin/devtools/developer-mode"
import type { PluginNavSection } from "@/stores/plugins"

/**
 * Devtools is the one section whose entry can vanish under the user (the flag
 * is a localStorage toggle in Settings), so every consumer has to answer
 * "which section am I actually showing" the same way.
 *
 * A leaf module on purpose: the nav rail needs this, and importing it from
 * `plugin-section-pane.tsx` dragged every section pane into the rail's graph.
 */
export function useVisiblePluginSection(section: PluginNavSection): PluginNavSection {
  const developerMode = useDeveloperMode()
  return section === "devtools" && !developerMode ? "library" : section
}
