// Static navigation map for the /plugins 3-pane shell. Mirrors the shape of
// `components/settings/settings-nav-config.ts` (sections grouped by area,
// each item carries an i18n label key + lucide icon). The plugin nav is
// flatter than settings: 4 top-level sections, with Library and Governance
// exposing nested sub-items.
//
// `featureFlag` lets us hide a section behind a runtime gate without
// branching the nav-sidebar component — `plugin-nav-sidebar.tsx` filters
// the array by the flag's value before rendering.

import { BoxesIcon, CompassIcon, ShieldCheckIcon, WrenchIcon, type LucideIcon } from "lucide-react"
import type {
  PluginGovernanceView,
  PluginLibrarySubFilter,
  PluginNavSection,
} from "@/stores/plugins"

export interface PluginNavItem {
  section: PluginNavSection
  /** i18n key under `plugins.sections.<key>`. */
  labelKey: PluginNavSection
  icon: LucideIcon
  /** Runtime gate; the nav sidebar hides the entry when false. */
  featureFlag?: "devtools"
}

export interface PluginLibrarySubItem {
  value: PluginLibrarySubFilter
  /** i18n key under `plugins.sections.librarySub.<key>`. */
  labelKey: PluginLibrarySubFilter
}

export interface PluginGovernanceSubItem {
  value: PluginGovernanceView
  /** i18n key under `plugins.sections.governanceSub.<key>`. */
  labelKey: PluginGovernanceView
}

export const PLUGIN_NAV_SECTIONS: ReadonlyArray<PluginNavItem> = [
  { section: "library", labelKey: "library", icon: BoxesIcon },
  { section: "discover", labelKey: "discover", icon: CompassIcon },
  { section: "governance", labelKey: "governance", icon: ShieldCheckIcon },
  { section: "devtools", labelKey: "devtools", icon: WrenchIcon, featureFlag: "devtools" },
]

export const PLUGIN_LIBRARY_SUBFILTERS: ReadonlyArray<PluginLibrarySubItem> = [
  { value: "all", labelKey: "all" },
  { value: "enabled", labelKey: "enabled" },
  { value: "updates", labelKey: "updates" },
  { value: "configurable", labelKey: "configurable" },
  { value: "errored", labelKey: "errored" },
]

export const PLUGIN_GOVERNANCE_VIEWS: ReadonlyArray<PluginGovernanceSubItem> = [
  { value: "permissions", labelKey: "permissions" },
  { value: "scheduled", labelKey: "scheduled" },
  { value: "analytics", labelKey: "analytics" },
  { value: "audit", labelKey: "audit" },
]
