"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, FilterIcon, LayersIcon } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
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
    <FeaturePageHeader
      icon={<LayersIcon />}
      title={t("panel.headerTitle")}
      summary={
        <span className="tabular-nums">
          {filteredCount === totalCount
            ? t("panel.headerSubtitle", { count: totalCount })
            : `${filteredCount}/${totalCount}`}
        </span>
      }
      breadcrumb={
        <div className="flex items-center gap-1">
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
        </div>
      }
      navigation={tabsSlot}
      actions={
        <>
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
        </>
      }
    />
  )
}
