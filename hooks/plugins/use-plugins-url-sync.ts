"use client"

/**
 * `/plugins` URL → panel state, for BOTH shells.
 *
 * This lived inside `PluginPanel`, so the phone body (`PluginsMobileBody`,
 * also what `/me/plugins` renders) ignored every deep link: `?section=`,
 * `?sub=`, legacy `?tab=`. And neither shell read `?plugin=<id>`, which is the
 * link the ⌘K plugin results (`lib/global-search/providers/system.ts`) and
 * every "View details" toast point at, so following one landed on the Library
 * with nothing selected.
 *
 * Vocabulary:
 *   ?section=library|discover|agent-packages|governance|devtools
 *   ?sub=all|enabled|updates|configurable|errored     (library sub-filter)
 *   ?gov=permissions|scheduled|analytics|audit|policy (governance view)
 *   ?subtab=overview|capabilities|configure|permissions|data (detail section)
 *   ?plugin=<id>   select the plugin and open its detail, then strip the param
 *                  (a one-shot command: leaving it would re-open the detail
 *                  every time the user closes it and the URL re-syncs)
 *   ?tab=<legacy>  translated once to the canonical params above
 *
 * The URL is read on mount and whenever it changes; in-app clicks never write
 * it, so this stays a no-op for ordinary navigation inside the page.
 */

import { useEffect } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useDeveloperMode } from "@/lib/plugin/devtools/developer-mode"
import {
  usePluginsStore,
  type PluginDetailSubTab,
  type PluginGovernanceView,
  type PluginLibrarySubFilter,
  type PluginNavSection,
} from "@/stores/plugins"

export const PLUGINS_TAB_REDIRECT: Record<
  string,
  {
    section: PluginNavSection
    sub?: PluginLibrarySubFilter
    gov?: PluginGovernanceView
    subtab?: PluginDetailSubTab
  }
> = {
  installed: { section: "library" },
  browse: { section: "discover" },
  configure: { section: "library", sub: "configurable", subtab: "configure" },
  permissions: { section: "governance", gov: "permissions" },
  scheduled: { section: "governance", gov: "scheduled" },
  analytics: { section: "governance", gov: "analytics" },
  devtools: { section: "devtools" },
}

const VALID_SECTIONS: ReadonlySet<string> = new Set<PluginNavSection>([
  "library",
  "discover",
  "agent-packages",
  "governance",
  "devtools",
])
const VALID_LIBRARY_SUB: ReadonlySet<string> = new Set<PluginLibrarySubFilter>([
  "all",
  "enabled",
  "updates",
  "configurable",
  "errored",
])
const VALID_GOVERNANCE: ReadonlySet<string> = new Set<PluginGovernanceView>([
  "permissions",
  "scheduled",
  "analytics",
  "audit",
  "policy",
])
const VALID_DETAIL_SUBTAB: ReadonlySet<string> = new Set<PluginDetailSubTab>([
  "overview",
  "capabilities",
  "configure",
  "permissions",
  "data",
])

export interface UsePluginsUrlSyncOptions {
  /**
   * Sections this shell can show. The phone body disables the desktop-only
   * ones, and a deep link must not select a section its nav refuses to.
   * Defaults to every valid section.
   */
  isSectionAllowed?: (section: PluginNavSection) => boolean
}

function withParams(
  pathname: string,
  current: URLSearchParams,
  edit: (next: URLSearchParams) => void
): string {
  const next = new URLSearchParams(current.toString())
  edit(next)
  const query = next.toString()
  return query ? `${pathname}?${query}` : pathname
}

export function usePluginsUrlSync(options: UsePluginsUrlSyncOptions = {}): void {
  const { isSectionAllowed } = options
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname() ?? "/plugins"
  const developerMode = useDeveloperMode()
  const tPage = useTranslations("plugins")

  const setActiveSection = usePluginsStore((s) => s.setActiveSection)
  const setLibrarySubFilter = usePluginsStore((s) => s.setLibrarySubFilter)
  const setGovernanceView = usePluginsStore((s) => s.setGovernanceView)
  const setDetailSubTab = usePluginsStore((s) => s.setDetailSubTab)
  const openDetail = usePluginsStore((s) => s.openDetail)

  const tabParam = searchParams?.get("tab") ?? null
  const sectionParam = searchParams?.get("section") ?? null
  const subParam = searchParams?.get("sub") ?? null
  const govParam = searchParams?.get("gov") ?? null
  const subtabParam = searchParams?.get("subtab") ?? null
  const pluginParam = searchParams?.get("plugin")?.trim() || null

  // Legacy `?tab=` → canonical params, then strip `tab`. The effect below
  // picks up the rewritten URL.
  useEffect(() => {
    if (!tabParam) return
    const mapped = PLUGINS_TAB_REDIRECT[tabParam]
    if (!mapped) return
    const current = new URLSearchParams(searchParams?.toString() ?? "")
    router.replace(
      withParams(pathname, current, (next) => {
        next.delete("tab")
        next.set("section", mapped.section)
        if (mapped.sub) next.set("sub", mapped.sub)
        if (mapped.gov) next.set("gov", mapped.gov)
        if (mapped.subtab) next.set("subtab", mapped.subtab)
      }),
      { scroll: false }
    )
    // Keyed on the param alone: the rewrite changes `searchParams`, and
    // re-running on that would be a no-op anyway once `tab` is gone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam])

  useEffect(() => {
    const current = new URLSearchParams(searchParams?.toString() ?? "")

    if (sectionParam === "devtools" && !developerMode) {
      setActiveSection("library")
      router.replace(
        withParams(pathname, current, (next) => next.set("section", "library")),
        { scroll: false }
      )
      toast.message(tPage("devtoolsDisabled.title"), {
        description: tPage("devtoolsDisabled.description"),
        action: {
          label: tPage("devtoolsDisabled.openSettings"),
          onClick: () => router.push("/settings?section=plugins"),
        },
      })
      return
    }

    // A plugin link always lands on the Library, which is where the detail
    // pane lives; an explicit `?section=` in the same URL is overridden.
    if (pluginParam) {
      setActiveSection("library")
    } else if (
      sectionParam !== null &&
      VALID_SECTIONS.has(sectionParam) &&
      (isSectionAllowed?.(sectionParam as PluginNavSection) ?? true)
    ) {
      setActiveSection(sectionParam as PluginNavSection)
    }
    if (subParam !== null && VALID_LIBRARY_SUB.has(subParam)) {
      setLibrarySubFilter(subParam as PluginLibrarySubFilter)
    }
    if (govParam !== null && VALID_GOVERNANCE.has(govParam)) {
      setGovernanceView(govParam as PluginGovernanceView)
    }
    if (subtabParam !== null && VALID_DETAIL_SUBTAB.has(subtabParam)) {
      setDetailSubTab(subtabParam as PluginDetailSubTab)
    } else if (pluginParam) {
      // A bare plugin link opens on the reading-first overview rather than on
      // whichever section the user last left expanded for another plugin.
      setDetailSubTab("overview")
    }

    if (pluginParam) {
      openDetail(pluginParam)
      router.replace(
        withParams(pathname, current, (next) => {
          next.delete("plugin")
          next.delete("subtab")
        }),
        { scroll: false }
      )
    }
  }, [
    sectionParam,
    subParam,
    govParam,
    subtabParam,
    pluginParam,
    developerMode,
    isSectionAllowed,
    pathname,
    router,
    searchParams,
    setActiveSection,
    setDetailSubTab,
    setGovernanceView,
    setLibrarySubFilter,
    openDetail,
    tPage,
  ])
}
