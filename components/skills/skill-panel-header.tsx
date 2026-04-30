"use client"

import { useTranslations } from "next-intl"
import { ArrowLeftIcon, FilterIcon, SearchIcon } from "lucide-react"
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

  return (
    <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
      <Button asChild variant="ghost" size="icon" className="size-8">
        <Link href="/" aria-label={t("back")}>
          <ArrowLeftIcon className="size-4" />
        </Link>
      </Button>
      <div className="flex-1 min-w-0">
        <h1 className="text-base font-semibold">{t("panel.headerTitle")}</h1>
        <p className="text-[11px] text-muted-foreground">
          {filteredCount === totalCount
            ? t("panel.headerSubtitle", { count: totalCount })
            : `${filteredCount}/${totalCount}`}
        </p>
      </div>
      <div className="relative w-72 max-w-[40vw]">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("filter.search")}
          className="h-9 pl-8 text-xs"
        />
      </div>
      <Button size="sm" variant="outline" onClick={() => setFilterSheetOpen(true)}>
        <FilterIcon className="mr-1.5 size-3.5" />
        {t("filters")}
      </Button>
      <SkillPanelToolbar />
    </div>
  )
}
