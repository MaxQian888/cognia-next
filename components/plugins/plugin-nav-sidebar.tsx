"use client"

// Left nav for the /plugins 3-pane shell. Mounted as
// `<FeaturePageShell leftPane={{ content: <PluginNavSidebar /> }} />` so it
// inherits the resize handle + mobile Sheet treatment from the feature
// shell.
//
// The rail carries exactly one axis: which section you are in (Library /
// Discover / Governance / Devtools). Anything that switches the *view
// inside* a section — Library's status filter, Governance's aggregate
// view picker — belongs to `PluginSectionToolbar` in the page header's
// second tier instead. Mixing the two axes in one column is what made the
// rail read as neither navigation nor filter; both pickers have now moved,
// so this file renders a flat list and nothing else.
//
// Click handlers route through the plugins store — no prop drilling. The
// devtools section uses `useDevtoolsGate()` so production builds without
// the opt-in localStorage flag hide it entirely (the option is never
// rendered, not just disabled).

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { useDevtoolsGate } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { PLUGIN_NAV_SECTIONS } from "./plugin-nav-config"

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
  const activeSection = usePluginsStore((s) => s.activeSection)
  const setActiveSection = usePluginsStore((s) => s.setActiveSection)
  const devtoolsEnabled = useDevtoolsGate()

  const isDesktop = useDesktopShell()

  const visibleSections = PLUGIN_NAV_SECTIONS.filter((item) => {
    if (item.featureFlag === "devtools") return devtoolsEnabled
    if (item.featureFlag === "desktop") return isDesktop
    return true
  })

  return (
    <nav aria-label={t("library")} className="flex h-full min-h-0 flex-col overflow-y-auto p-2">
      <ul className="space-y-0.5">
        {visibleSections.map(({ section, labelKey, icon: Icon }) => {
          const active = activeSection === section
          return (
            <li key={section}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setActiveSection(section)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "w-full justify-start gap-2 px-2 font-normal",
                  active ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground"
                )}
                data-testid={`plugin-nav-${section}`}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{t(labelKey)}</span>
              </Button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
