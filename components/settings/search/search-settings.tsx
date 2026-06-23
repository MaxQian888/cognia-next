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
        <SettingsPageHeader
          title={t("title")}
          description={t("description")}
          icon={<Search className="h-5 w-5" />}
        />

        {isNarrow ? (
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
        ) : (
          <div className="flex gap-6">
            <aside className="w-52 shrink-0 self-start sticky top-0">
              <SearchSettingsNav active={active} onSelect={navigate} />
            </aside>
            <div className="min-w-0 flex-1 space-y-4">
              <div className="space-y-0.5">
                <h3 className="text-base font-semibold">{t(activeSection.labelKey)}</h3>
                <p className="text-xs text-muted-foreground">{t(activeSection.descKey)}</p>
              </div>
              <ActiveComponent />
            </div>
          </div>
        )}
      </SearchSectionNavProvider>
    </TooltipProvider>
  )
}
