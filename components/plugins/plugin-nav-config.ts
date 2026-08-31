// Static navigation map for the /plugins 3-pane shell. Mirrors the shape of
// `components/settings/settings-nav-config.ts` (sections grouped by area,
// each item carries an i18n label key + lucide icon). The plugin nav is
// flatter than settings: the rail itself is 4 flat top-level sections.
// Library's status filters and Governance's aggregate views also live here
// — not because the rail nests them (it no longer does), but because both
// lists are static navigation maps and the header's `PluginSectionToolbar`
// reads them from one place.
//
// `featureFlag` lets us hide a section behind a runtime gate without
// branching the nav-sidebar component — `plugin-nav-sidebar.tsx` filters
// the array by the flag's value before rendering.

import {
  BoxesIcon,
  CompassIcon,
  PackageIcon,
  ShieldCheckIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react"
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
  /**
   * Runtime gate; the nav sidebar hides the entry when false.
   *
   * `devtools` is the opt-in localStorage flag. `desktop` means the section
   * only works in the Tauri shell — Pi's package manager reads a config file
   * and shells out to a CLI, neither of which exists in the browser or on
   * mobile, so the entry is not rendered there rather than rendered broken.
   */
  featureFlag?: "devtools" | "desktop"
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
  {
    section: "agent-packages",
    labelKey: "agent-packages",
    icon: PackageIcon,
    featureFlag: "desktop",
  },
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
  { value: "policy", labelKey: "policy" },
]

export interface PluginSectionVisibility {
  /** The opt-in localStorage devtools flag (`useDevtoolsGate`). */
  devtoolsEnabled: boolean
  /** Tauri shell, which is the only host that can run the desktop sections. */
  isDesktop: boolean
}

/**
 * The sections a given host should offer, in nav order.
 *
 * Shared by the desktop rail and the phone body so the two can never disagree
 * about which sections exist. Pure, so the rule is testable without a shell.
 */
export function visiblePluginSections({
  devtoolsEnabled,
  isDesktop,
}: PluginSectionVisibility): ReadonlyArray<PluginNavItem> {
  return PLUGIN_NAV_SECTIONS.filter((item) => {
    if (item.featureFlag === "devtools") return devtoolsEnabled
    if (item.featureFlag === "desktop") return isDesktop
    return true
  })
}
