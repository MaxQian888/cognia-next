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
// rail read as neither navigation nor filter; Governance's picker has
// already moved, Library's follows.
//
// Click handlers route through the plugins store — no prop drilling. The
// devtools section uses `useDevtoolsGate()` so production builds without
// the opt-in localStorage flag hide it entirely (the option is never
// rendered, not just disabled).

import { useTranslations } from "next-intl"
import { useDevtoolsGate } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { PLUGIN_LIBRARY_SUBFILTERS, PLUGIN_NAV_SECTIONS } from "./plugin-nav-config"

export function PluginNavSidebar() {
  const t = useTranslations("plugins.sections")
  const activeSection = usePluginsStore((s) => s.activeSection)
  const setActiveSection = usePluginsStore((s) => s.setActiveSection)
  const librarySub = usePluginsStore((s) => s.librarySubFilter)
  const setLibrarySub = usePluginsStore((s) => s.setLibrarySubFilter)
  const devtoolsEnabled = useDevtoolsGate()

  const visibleSections = PLUGIN_NAV_SECTIONS.filter((item) => {
    if (item.featureFlag === "devtools") return devtoolsEnabled
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
              {section === "library" && active && (
                <SubList
                  testIdPrefix="plugin-nav-library-sub"
                  i18nPrefix="librarySub"
                  items={PLUGIN_LIBRARY_SUBFILTERS}
                  value={librarySub}
                  onSelect={setLibrarySub}
                />
              )}
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

interface SubListProps<T extends string> {
  testIdPrefix: string
  i18nPrefix: "librarySub" | "governanceSub"
  items: ReadonlyArray<{ value: T; labelKey: T }>
  value: T
  onSelect: (value: T) => void
}

function SubList<T extends string>({
  testIdPrefix,
  i18nPrefix,
  items,
  value,
  onSelect,
}: SubListProps<T>) {
  // next-intl types the namespace argument against the JSON tree.
  // Casting through `string` is safe here because the union of
  // i18nPrefix values is constrained to literal sub-tree keys.
  const t = useTranslations(`plugins.sections.${i18nPrefix}` as never) as (key: string) => string
  return (
    <ul className="mt-0.5 ml-6 space-y-0.5">
      {items.map((item) => {
        const active = value === item.value
        return (
          <li key={item.value}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSelect(item.value)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "h-7 w-full justify-start px-2 text-xs font-normal",
                active ? "bg-accent/60 text-foreground font-medium" : "text-muted-foreground"
              )}
              data-testid={`${testIdPrefix}-${item.value}`}
            >
              {t(item.labelKey)}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
