"use client"

// The center content and the header controls for each /plugins section, in
// one place.
//
// Both the desktop 3-pane shell (`plugin-panel.tsx`) and the phone body
// (`components/mobile/plugins/plugins-mobile-body.tsx`) show the same five
// sections. Keeping the mapping here means a new section, or a section that
// grows a controls row, arrives on both shells at once instead of on whichever
// one someone remembered.

import { useDeveloperMode } from "@/lib/plugin/devtools/developer-mode"
import type { PluginNavSection } from "@/stores/plugins"

import { AgentPackagesPane } from "./agent-packages/agent-packages-pane"
import { PluginDevtoolsPane } from "./devtools/plugin-devtools-pane"
import { PluginDiscoverHeader } from "./discover/plugin-discover-header"
import { PluginDiscoverPane } from "./discover/plugin-discover-pane"
import { PluginGovernanceHeader } from "./governance/plugin-governance-header"
import { PluginGovernancePane } from "./governance/plugin-governance-pane"
import { PluginLibraryHeader } from "./library/plugin-library-header"
import { PluginLibraryPane } from "./library/plugin-library-pane"
import type { PluginSectionToolbarProps } from "./plugin-section-toolbar"

/**
 * Devtools is the one section whose entry can vanish under the user (the flag
 * is a localStorage toggle in Settings), so every consumer has to answer
 * "which section am I actually showing" the same way.
 */
export function useVisiblePluginSection(section: PluginNavSection): PluginNavSection {
  const developerMode = useDeveloperMode()
  return section === "devtools" && !developerMode ? "library" : section
}

export function PluginSectionPane({ section }: { section: PluginNavSection }) {
  switch (section) {
    case "discover":
      return <PluginDiscoverPane />
    case "agent-packages":
      return <AgentPackagesPane />
    case "governance":
      return <PluginGovernancePane />
    case "devtools":
      return <PluginDevtoolsPane />
    default:
      return <PluginLibraryPane />
  }
}

export interface PluginSectionControlsProps {
  section: PluginNavSection
  layout?: PluginSectionToolbarProps["layout"]
}

/**
 * The section's second-tier controls, or nothing when the section has none.
 * Devtools and Agent Packages carry their own controls inside their pane.
 */
export function PluginSectionControls({ section, layout }: PluginSectionControlsProps) {
  if (section === "library") return <PluginLibraryHeader layout={layout} />
  if (section === "discover") return <PluginDiscoverHeader layout={layout} />
  if (section === "governance") return <PluginGovernanceHeader layout={layout} />
  return null
}

export function pluginSectionHasControls(section: PluginNavSection): boolean {
  return section === "library" || section === "discover" || section === "governance"
}
