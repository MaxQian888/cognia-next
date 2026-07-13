"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, LayoutGridIcon, ListIcon, SearchIcon, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SKILL_CATEGORIES, SKILL_SOURCES } from "@/lib/skills/categories"
import { useSkillsStore } from "@/stores/skills"
import { useSettingsStore } from "@/stores/settings"
import { useSkillPanelPrefs } from "@/hooks/skills"
import type { Skill, SkillCategory, SkillSource } from "@cognia/agent-config-types"
import type { SkillSortMode } from "@/stores/skills"
import { cn } from "@/lib/utils"
import { SkillListItem, type SkillListDisplay } from "./skill-list-item"

interface Props {
  /** Filtered skills (the rows to render). */
  skills: Skill[]
  /** Unfiltered total (stats bar). */
  total: number
  /** Enabled count across all skills (stats bar + budget warning). */
  enabledCount: number
  countsBySource: Record<string, number>
  countsByCategory: Record<string, number>
  /** Empty-state "create a skill" action. */
  onCreate: () => void
}

/**
 * Left pane of the master-detail My Skills layout: search + compact
 * source/category filters + a sort/view controls row + scrollable skill rows
 * (or a card grid) + stats bar. Density, view mode, and per-row field
 * visibility come from the persisted skill panel preferences.
 */
export function SkillListPane({
  skills,
  total,
  enabledCount,
  countsBySource,
  countsByCategory,
  onCreate,
}: Props) {
  const t = useTranslations("skills")
  const filters = useSkillsStore((s) => s.filters)
  const setQuery = useSkillsStore((s) => s.setQuery)
  const setFilters = useSkillsStore((s) => s.setFilters)
  const selection = useSkillsStore((s) => s.selection)
  const toggleSelection = useSkillsStore((s) => s.toggleSelection)
  const detailSkillId = useSkillsStore((s) => s.detailSkillId)
  const openDetail = useSkillsStore((s) => s.openDetail)
  const prefs = useSkillPanelPrefs()
  const setPrefs = useSettingsStore((s) => s.setSkillPanelPrefs)

  const display = useMemo<SkillListDisplay>(
    () => ({
      density: prefs.density,
      viewMode: prefs.viewMode,
      showDescription: prefs.showDescription,
      showTags: prefs.showTags,
      showSource: prefs.showSource,
      showUsage: prefs.showUsage,
    }),
    [
      prefs.density,
      prefs.viewMode,
      prefs.showDescription,
      prefs.showTags,
      prefs.showSource,
      prefs.showUsage,
    ]
  )

  const overBudget = prefs.enabledWarnThreshold > 0 && enabledCount > prefs.enabledWarnThreshold

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b p-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            data-skill-search
            value={filters.query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("filter.search")}
            className="h-9 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-2 border-b px-3 py-2">
        <Select
          value={filters.source}
          onValueChange={(v) => setFilters({ source: v as SkillSource | "all", category: "all" })}
        >
          <SelectTrigger className="h-8 min-w-0 text-xs" aria-label={t("panel.selectSourceAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              {t("filter.all")} ({total})
            </SelectItem>
            {SKILL_SOURCES.map((src) => (
              <SelectItem key={src.id} value={src.id} className="text-xs">
                {t(`source.${src.labelKey}` as never)} ({countsBySource[src.id] ?? 0})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.category}
          onValueChange={(v) => setFilters({ category: v as SkillCategory | "all", source: "all" })}
        >
          <SelectTrigger className="h-8 min-w-0 text-xs" aria-label={t("panel.selectCategoryAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              {t("filter.all")} ({total})
            </SelectItem>
            {SKILL_CATEGORIES.map((cat) => (
              <SelectItem key={cat.id} value={cat.id} className="text-xs">
                {t(`category.${cat.labelKey}` as never)} ({countsByCategory[cat.id] ?? 0})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Sort + view-mode controls */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Select
          value={filters.sort}
          onValueChange={(v) => setFilters({ sort: v as SkillSortMode })}
        >
          <SelectTrigger className="h-7 min-w-0 flex-1 text-xs" aria-label={t("filter.sortBy")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name" className="text-xs">
              {t("filter.sortName")}
            </SelectItem>
            <SelectItem value="updated" className="text-xs">
              {t("filter.sortUpdated")}
            </SelectItem>
            <SelectItem value="usage" className="text-xs">
              {t("filter.sortUsage")}
            </SelectItem>
          </SelectContent>
        </Select>
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border p-0.5">
          <Button
            type="button"
            size="icon"
            variant={prefs.viewMode === "list" ? "secondary" : "ghost"}
            className="size-6"
            aria-label={t("prefs.viewList")}
            aria-pressed={prefs.viewMode === "list"}
            data-testid="skill-view-list"
            onClick={() => void setPrefs({ viewMode: "list" })}
          >
            <ListIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant={prefs.viewMode === "grid" ? "secondary" : "ghost"}
            className="size-6"
            aria-label={t("prefs.viewGrid")}
            aria-pressed={prefs.viewMode === "grid"}
            data-testid="skill-view-grid"
            onClick={() => void setPrefs({ viewMode: "grid" })}
          >
            <LayoutGridIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {overBudget && (
        <div
          className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400"
          role="status"
          data-testid="skill-budget-warning"
        >
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          <span>
            {t("prefs.budgetWarning", {
              count: enabledCount,
              threshold: prefs.enabledWarnThreshold,
            })}
          </span>
        </div>
      )}

      <div
        className={cn(
          "flex-1 overflow-y-auto",
          prefs.viewMode === "grid" ? "grid grid-cols-1 gap-2 p-2 sm:grid-cols-2" : "p-1"
        )}
        aria-label={t("panel.listAriaLabel")}
        data-testid="skill-list"
      >
        {skills.length === 0 ? (
          <div
            className={cn(
              "flex flex-col items-center justify-center gap-3 py-16 text-center",
              prefs.viewMode === "grid" && "sm:col-span-2"
            )}
          >
            <SparklesIcon className="size-8 text-muted-foreground/50" />
            <div>
              <p className="text-sm font-medium">{t("panel.emptyTitle")}</p>
              <p className="mt-1 px-4 text-xs text-muted-foreground">{t("panel.emptyHint")}</p>
            </div>
            <Button size="sm" onClick={onCreate}>
              {t("panel.emptyAction")}
            </Button>
          </div>
        ) : (
          skills.map((sk) => (
            <SkillListItem
              key={sk.id}
              skill={sk}
              display={display}
              selected={selection.has(sk.id)}
              active={detailSkillId === sk.id}
              onToggleSelect={toggleSelection}
              onOpen={openDetail}
            />
          ))
        )}
      </div>

      <div className="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">
        {t("panel.statsBar", { enabled: enabledCount, total })}
      </div>
    </div>
  )
}
