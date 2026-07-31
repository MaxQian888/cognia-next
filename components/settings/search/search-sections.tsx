"use client"

import { createContext, useContext, type ReactNode } from "react"
import { Search, Globe, Sliders, Shield, Database, BarChart3 } from "lucide-react"
import { SettingsDivider } from "@/components/settings/common/settings-section"
import { SearchGlobalSettings } from "./search-global-settings"
import { SearchDefaultsSettings } from "./search-defaults-settings"
import { SearchCacheSettings } from "./search-cache-settings"
import { SearchSafetySettings } from "./search-safety-settings"
import { SourceVerificationSettings } from "./source-verification-settings"
import { SearchProviderGrid } from "./search-provider-grid"
import { SearchProviderCompare } from "./search-provider-compare"
import { SearchUsagePanel } from "./search-usage-panel"

/** URL query param that selects the active search settings section (deep-linkable). */
export const SEARCH_SECTION_PARAM = "searchSection"

export type SearchSectionId =
  "basics" | "providers" | "behavior" | "safety" | "performance" | "diagnostics"

const SECTION_IDS: SearchSectionId[] = [
  "basics",
  "providers",
  "behavior",
  "safety",
  "performance",
  "diagnostics",
]

export function isSearchSection(value: string | null | undefined): value is SearchSectionId {
  return !!value && (SECTION_IDS as string[]).includes(value)
}

// --- section navigation context -------------------------------------------------
// Lets section content (e.g. the basics empty-state) jump to another section
// without threading callbacks through the config array.

const SearchSectionNavContext = createContext<(id: SearchSectionId) => void>(() => {})

export function SearchSectionNavProvider({
  navigate,
  children,
}: {
  navigate: (id: SearchSectionId) => void
  children: ReactNode
}) {
  return (
    <SearchSectionNavContext.Provider value={navigate}>{children}</SearchSectionNavContext.Provider>
  )
}

export function useSearchSectionNav() {
  return useContext(SearchSectionNavContext)
}

// --- composite sections ---------------------------------------------------------

function BasicsSection() {
  const navigate = useSearchSectionNav()
  return <SearchGlobalSettings onConfigureProviders={() => navigate("providers")} />
}

function SafetySection() {
  return (
    <div className="space-y-6">
      <SearchSafetySettings />
      <SettingsDivider />
      <SourceVerificationSettings />
    </div>
  )
}

function DiagnosticsSection() {
  return (
    <div className="space-y-6">
      <SearchUsagePanel />
      <SettingsDivider />
      <SearchProviderCompare />
    </div>
  )
}

export interface SearchSectionDef {
  id: SearchSectionId
  /** Key under `searchSettings.nav.*` for the label. */
  labelKey: string
  /** Key under `searchSettings.nav.*` for the one-line description. */
  descKey: string
  icon: ReactNode
  Component: () => ReactNode
}

export const SEARCH_SECTIONS: SearchSectionDef[] = [
  {
    id: "basics",
    labelKey: "nav.basics",
    descKey: "nav.basicsDesc",
    icon: <Search className="h-4 w-4" />,
    Component: BasicsSection,
  },
  {
    id: "providers",
    labelKey: "nav.providers",
    descKey: "nav.providersDesc",
    icon: <Globe className="h-4 w-4" />,
    Component: SearchProviderGrid,
  },
  {
    id: "behavior",
    labelKey: "nav.behavior",
    descKey: "nav.behaviorDesc",
    icon: <Sliders className="h-4 w-4" />,
    Component: SearchDefaultsSettings,
  },
  {
    id: "safety",
    labelKey: "nav.safety",
    descKey: "nav.safetyDesc",
    icon: <Shield className="h-4 w-4" />,
    Component: SafetySection,
  },
  {
    id: "performance",
    labelKey: "nav.performance",
    descKey: "nav.performanceDesc",
    icon: <Database className="h-4 w-4" />,
    Component: SearchCacheSettings,
  },
  {
    id: "diagnostics",
    labelKey: "nav.diagnostics",
    descKey: "nav.diagnosticsDesc",
    icon: <BarChart3 className="h-4 w-4" />,
    Component: DiagnosticsSection,
  },
]
