"use client"

// Left nav for the /plugins 3-pane shell. Mounted as
// `<FeaturePageShell leftPane={{ content: <PluginNavSidebar /> }} />` so it
// inherits the resize handle + mobile Sheet treatment from the feature
// shell.
//
// The rail's first job is which section you are in (Library / Discover /
// Agent packages / Governance / Devtools). Status-like pickers that switch
// the *view inside* a section — Library's All / Enabled / Updates segments,
// Governance's aggregate views — stay in `PluginSectionToolbar` in the page
// header's second tier.
//
// The one thing below the sections is Library's capability facets, under
// their own heading and only while Library is the section. They used to be a
// second fixed-width rail beside this one, so a desktop window spent two
// columns of chrome before the list. A facet list is a natural rail citizen
// (a long vertical list of short labels); what keeps it from blurring with
// navigation is the heading and the fact that it disappears with the section.
//
// Click handlers route through the plugins store — no prop drilling.
//
// Two gates, treated differently on purpose (see `visiblePluginSections`).
// `devtools` is an opt-in developer switch and is absent when it is off.
// `agent-packages` is a capability gap, so it stays rendered and disabled
// with the reason attached: a blank rail cannot tell "does not exist" apart
// from "needs the desktop app".
//
// The rail also carries the Library badges. "3 updates waiting" and "1 plugin
// failed" used to require entering the section to discover.

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { useDevtoolsGate, usePlugins, type PluginsView } from "@/hooks/plugins"
import { usePluginsStore, type PluginNavSection } from "@/stores/plugins"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { visiblePluginSections } from "./plugin-nav-config"
import { PluginCategorySidebar } from "./plugin-category-sidebar"
import { useVisiblePluginSection } from "./plugin-visible-section"

/**
 * Which shell we are in, read SSR-safely.
 *
 * This app is a static export, so the server render happens at build time where
 * `isTauri()` is always false. `useSyncExternalStore`'s third argument is the
 * server snapshot, which is exactly this distinction — and unlike an effect it
 * does not cause a cascading render on mount. The shell never changes while the
 * page is open, so `subscribe` has nothing to listen for.
 */
const NEVER_CHANGES = () => () => {}
const useDesktopShell = () =>
  useSyncExternalStore(
    NEVER_CHANGES,
    () => isTauri(),
    () => false
  )

export function PluginNavSidebar() {
  const t = useTranslations("plugins.sections")
  const tFacets = useTranslations("plugins.categorySidebar")
  const activeSection = usePluginsStore((s) => s.activeSection)
  const visibleSection = useVisiblePluginSection(activeSection)
  const setActiveSection = usePluginsStore((s) => s.setActiveSection)
  const devtoolsEnabled = useDevtoolsGate()
  const { totals } = usePlugins()

  const isDesktop = useDesktopShell()

  const visibleSections = visiblePluginSections({ devtoolsEnabled, isDesktop })

  return (
    <nav aria-label={t("navAria")} className="flex h-full min-h-0 flex-col overflow-y-auto p-2">
      <ul className="space-y-0.5">
        {visibleSections.map(({ section, labelKey, icon: Icon, disabled }) => {
          const active = visibleSection === section
          return (
            <li key={section}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setActiveSection(section)}
                disabled={disabled}
                title={disabled ? t("desktopOnlyHint") : undefined}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "w-full justify-start gap-2 px-2 font-normal pointer-coarse:h-10",
                  active ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground"
                )}
                data-testid={`plugin-nav-${section}`}
                data-disabled-reason={disabled ? "desktop" : undefined}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{t(labelKey)}</span>
                {disabled ? (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {t("desktopOnly")}
                  </span>
                ) : (
                  <NavBadges section={section} totals={totals} />
                )}
              </Button>
            </li>
          )
        })}
      </ul>
      {visibleSection === "library" ? (
        <section
          className="mt-3 border-t pt-3"
          aria-labelledby="plugin-nav-facets-heading"
          data-testid="plugin-nav-capability-facets"
        >
          <h2
            id="plugin-nav-facets-heading"
            className="px-2 pb-1.5 text-[11px] font-medium text-muted-foreground"
          >
            {tFacets("heading")}
          </h2>
          <PluginCategorySidebar variant="rail" />
        </section>
      ) : null}
    </nav>
  )
}

/**
 * Library carries the two counts a user needs before deciding to open it:
 * how many plugins have an update waiting, and how many failed. Zero-count
 * badges are dropped for the same reason `visibleSegments` drops zero-count
 * segments: a number that is always 0 is chrome, not information.
 */
function NavBadges({
  section,
  totals,
}: {
  section: PluginNavSection
  totals: PluginsView["totals"]
}) {
  if (section !== "library") return null
  const updates = totals.updateAvailable
  const errored = totals.errored
  if (updates === 0 && errored === 0) return null
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {updates > 0 && (
        <Badge variant="secondary" className="h-4 px-1 text-[10px] tabular-nums">
          {updates}
        </Badge>
      )}
      {errored > 0 && (
        <Badge variant="destructive" className="h-4 px-1 text-[10px] tabular-nums">
          {errored}
        </Badge>
      )}
    </span>
  )
}
