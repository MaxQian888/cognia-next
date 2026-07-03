"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, FilterIcon, LayersIcon } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { useSkillsStore } from "@/stores/skills"
import { SkillPanelToolbar } from "./skill-panel-toolbar"
import { SkillPreferencesPopover } from "./skill-preferences"

interface Props {
  totalCount: number
  filteredCount: number
  /** Tabs rendered inline in the header row at lg+ (second row below lg). */
  tabsSlot?: ReactNode
}

export function SkillPanelHeader({ totalCount, filteredCount, tabsSlot }: Props) {
  const t = useTranslations("skills")
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
      <div className="min-w-0 shrink-0">
        <h1 className="truncate text-base font-semibold">{t("panel.headerTitle")}</h1>
        <p className="text-[11px] text-muted-foreground">
          {filteredCount === totalCount
            ? t("panel.headerSubtitle", { count: totalCount })
            : `${filteredCount}/${totalCount}`}
        </p>
      </div>
      {tabsSlot && <div className="hidden min-w-0 lg:flex lg:items-center">{tabsSlot}</div>}
      <div className="flex-1" />
      {activeTab === "my-skills" && (
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
      )}
      <SkillPreferencesPopover />
      <SkillPanelToolbar />
    </div>
  )
}
