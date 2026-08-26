"use client"

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { Search } from "lucide-react"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SettingsPageHeader } from "@/components/settings/common/settings-section"
import { useIsNarrow } from "@/hooks/ui/use-media-query"
import { SearchSettingsNav } from "./search-settings-nav"
import { SettingsListDetail } from "@/components/settings/common/settings-master-detail"
import {
  SEARCH_SECTIONS,
  SEARCH_SECTION_PARAM,
  SearchSectionNavProvider,
  isSearchSection,
  type SearchSectionId,
} from "./search-sections"

export function SearchSettings() {
  const t = useTranslations("searchSettings")
  const router = useRouter()
  const params = useSearchParams()
  const isNarrow = useIsNarrow()

  const requested = params.get(SEARCH_SECTION_PARAM)
  const active: SearchSectionId = isSearchSection(requested) ? requested : "basics"

  const navigate = (id: SearchSectionId) => {
    const next = new URLSearchParams(params.toString())
    next.set(SEARCH_SECTION_PARAM, id)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  const activeSection = SEARCH_SECTIONS.find((s) => s.id === active) ?? SEARCH_SECTIONS[0]
  const ActiveComponent = activeSection.Component

  return (
    <TooltipProvider delayDuration={300}>
      <SearchSectionNavProvider navigate={navigate}>
        <div className="flex h-full min-h-0 flex-col gap-4">
          <SettingsPageHeader
            title={t("title")}
            description={t("description")}
            icon={<Search className="h-5 w-5" />}
            className="mb-0"
          />

          {isNarrow ? (
            <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
              <Accordion
                type="single"
                collapsible
                value={active}
                onValueChange={(v) => {
                  if (isSearchSection(v)) navigate(v)
                }}
              >
                {SEARCH_SECTIONS.map((section) => {
                  const SectionComponent = section.Component
                  return (
                    <AccordionItem key={section.id} value={section.id}>
                      <AccordionTrigger>
                        <span className="flex items-center gap-2">
                          {section.icon}
                          {t(section.labelKey)}
                        </span>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="pt-1">
                          <SectionComponent />
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  )
                })}
              </Accordion>
            </div>
          ) : (
            /* The rail used to be a flat 220px with no breakpoint at all, so
               the detail column was whatever the pane had left — 204px in an
               835px window. `SettingsListDetail` measures the pane and keeps
               the rail a share of it. */
            <SettingsListDetail listWidth={260}>
              {/* ── Master rail ─────────────────────────────────────────── */}
              <aside className="min-h-0 overflow-y-auto rounded-lg border p-2">
                <SearchSettingsNav active={active} onSelect={navigate} />
              </aside>

              {/* ── Detail panel ────────────────────────────────────────── */}
              <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
                <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    {activeSection.icon}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold leading-tight">
                      {t(activeSection.labelKey)}
                    </h3>
                    <p className="truncate text-xs text-muted-foreground">
                      {t(activeSection.descKey)}
                    </p>
                  </div>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                  <ActiveComponent />
                </div>
              </section>
            </SettingsListDetail>
          )}
        </div>
      </SearchSectionNavProvider>
    </TooltipProvider>
  )
}
