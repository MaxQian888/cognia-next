"use client"

import { useTranslations } from "next-intl"
import { ArrowLeftIcon, FilterIcon, LayersIcon, SearchIcon } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useSkillsStore } from "@/stores/skills"
import { SkillPanelToolbar } from "./skill-panel-toolbar"

interface Props {
  totalCount: number
  filteredCount: number
}

export function SkillPanelHeader({ totalCount, filteredCount }: Props) {
  const t = useTranslations("skills")
  const filters = useSkillsStore((s) => s.filters)
  const setQuery = useSkillsStore((s) => s.setQuery)
  const setFilterSheetOpen = useSkillsStore((s) => s.setFilterSheetOpen)
  const setCategorySheetOpen = useSkillsStore((s) => s.setCategorySheetOpen)
  const activeTab = useSkillsStore((s) => s.activeTab)

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 sm:gap-3 sm:px-4 sm:py-3">
      <Button asChild variant="ghost" size="icon" className="size-8 shrink-0">
        <Link href="/" aria-label={t("back")}>
          <ArrowLeftIcon className="size-4" />
        </Link>
      </Button>
      {activeTab === "my-skills" && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 lg:hidden"
          onClick={() => setCategorySheetOpen(true)}
          aria-label={t("panel.openCategoriesAria")}
        >
          <LayersIcon className="size-4" />
        </Button>
      )}
      <div className="flex-1 min-w-0">
        <h1 className="truncate text-base font-semibold">{t("panel.headerTitle")}</h1>
        <p className="text-[11px] text-muted-foreground">
          {filteredCount === totalCount
            ? t("panel.headerSubtitle", { count: totalCount })
            : `${filteredCount}/${totalCount}`}
        </p>
      </div>
      <div className="relative order-last w-full sm:order-none sm:w-56 md:w-64 lg:w-72">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          data-skill-search
          value={filters.query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("filter.search")}
          className="h-9 pl-8 text-xs"
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setFilterSheetOpen(true)}
        className="shrink-0"
        aria-label={t("filters")}
      >
        <FilterIcon className="size-3.5 sm:mr-1.5" />
        <span className="hidden sm:inline">{t("filters")}</span>
      </Button>
      <SkillPanelToolbar />
    </div>
  )
}
