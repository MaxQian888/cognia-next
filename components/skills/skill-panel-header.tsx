"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, FilterIcon, LayersIcon, LayoutListIcon } from "lucide-react"
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
  /**
   * The panel is inside a host that already owns the page's identity and its
   * way back: the Settings shell, or `/me/skills` under `SubPageShell`.
   *
   * Without it this header put a second back arrow next to the host's, and
   * that one pointed at `/`, so the control that looked like "up one level"
   * actually left Settings altogether. It also emitted a second `<h1>` for a
   * page that already had one, and on a 375px phone the two titles competed
   * for the same row until this one truncated to "S…".
   */
  embedded?: boolean
}

export function SkillPanelHeader({ totalCount, filteredCount, tabsSlot, embedded }: Props) {
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
      headingLevel={embedded ? 2 : 1}
      breadcrumb={
        <div className="flex items-center gap-1">
          {!embedded && (
            <Button asChild variant="ghost" size="icon" className="size-8 shrink-0">
              <Link href="/" aria-label={t("back")}>
                <ArrowLeftIcon className="size-4" />
              </Link>
            </Button>
          )}
          {activeTab === "my-skills" && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 lg:hidden"
              onClick={() => setCategorySheetOpen(true)}
              aria-label={t("panel.openCategoriesAria")}
              data-testid="skill-panel-open-categories"
            >
              {/* Not `LayersIcon`: that is the page's own identity glyph one
                  slot to the right, and two of it side by side read as a
                  rendering glitch. Same glyph as the plugin category sheet. */}
              <LayoutListIcon className="size-4" />
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
