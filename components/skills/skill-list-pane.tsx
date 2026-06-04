"use client"

import { useTranslations } from "next-intl"
import { SearchIcon, SparklesIcon } from "lucide-react"
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
import type { Skill, SkillCategory, SkillSource } from "@/lib/claude/types"
import { SkillListItem } from "./skill-list-item"

interface Props {
  /** Filtered skills (the rows to render). */
  skills: Skill[]
  /** Unfiltered total (stats bar). */
  total: number
  /** Enabled count across all skills (stats bar). */
  enabledCount: number
  countsBySource: Record<string, number>
  countsByCategory: Record<string, number>
  /** Empty-state "create a skill" action. */
  onCreate: () => void
}

/**
 * Left pane of the master-detail My Skills layout: search + compact
 * source/category filters + scrollable skill rows + stats bar. Mirrors the
 * provider settings sidebar (`ProviderSidebar`).
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

      <div
        className="flex-1 overflow-y-auto p-1"
        aria-label={t("panel.listAriaLabel")}
        data-testid="skill-list"
      >
        {skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
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
