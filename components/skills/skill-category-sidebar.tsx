"use client"

import { useTranslations } from "next-intl"
import { LayersIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { SKILL_CATEGORIES, SKILL_SOURCES } from "@/lib/skills/categories"
import { useSkillsStore } from "@/stores/skills"
import type { SkillCategory, SkillSource } from "@/lib/claude/types"

interface Props {
  total: number
  countsByCategory: Record<string, number>
  countsBySource: Record<string, number>
  /** Fires after every selection — used by the mobile Sheet to auto-close. */
  onSelect?: () => void
}

/**
 * Left rail under the My Skills tab (≥ lg). Below lg the same content is
 * mounted inside `SkillCategorySheet` via the shared `SkillCategoryButtonList`.
 *
 * Selecting a bucket sets either `filters.source` or `filters.category` (and
 * resets the other to "all") so the cells in the panel grid narrow
 * predictably.
 */
export function SkillCategorySidebar({ total, countsByCategory, countsBySource, onSelect }: Props) {
  return (
    <aside className="hidden w-52 shrink-0 border-r bg-muted/20 px-2 py-3 text-sm lg:block">
      <SkillCategoryButtonList
        total={total}
        countsByCategory={countsByCategory}
        countsBySource={countsBySource}
        onSelect={onSelect}
      />
    </aside>
  )
}

/**
 * Shared button-list rendering used by both the desktop sidebar and the
 * mobile category sheet. Pure presentation — selection writes through
 * `useSkillsStore.setFilters`.
 */
export function SkillCategoryButtonList({
  total,
  countsByCategory,
  countsBySource,
  onSelect,
}: Props) {
  const t = useTranslations("skills")
  const filters = useSkillsStore((s) => s.filters)
  const setFilters = useSkillsStore((s) => s.setFilters)
  const isAll = filters.source === "all" && filters.category === "all"

  const handleClick = (patch: Partial<typeof filters>) => {
    setFilters(patch)
    onSelect?.()
  }

  return (
    <div data-testid="skill-category-button-list">
      <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t("filter.byCategory")}
      </p>
      <button
        type="button"
        onClick={() => handleClick({ category: "all", source: "all" })}
        className={cn(
          "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
          isAll && "bg-accent font-medium"
        )}
      >
        <span className="flex items-center gap-1.5">
          <LayersIcon className="size-3.5" />
          {t("filter.all")}
        </span>
        <span className="text-[10px] text-muted-foreground">{total}</span>
      </button>

      <p className="mt-3 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t("filter.bySource")}
      </p>
      {SKILL_SOURCES.map((src) => (
        <button
          key={src.id}
          type="button"
          onClick={() => handleClick({ source: src.id as SkillSource, category: "all" })}
          className={cn(
            "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
            filters.source === src.id && filters.category === "all" && "bg-accent font-medium"
          )}
        >
          <span>{t(`source.${src.labelKey}` as never)}</span>
          <span className="text-[10px] text-muted-foreground">{countsBySource[src.id] ?? 0}</span>
        </button>
      ))}

      <p className="mt-3 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t("filter.byCategory")}
      </p>
      {SKILL_CATEGORIES.map((cat) => {
        const Icon = cat.icon
        const active = filters.category === cat.id && filters.source === "all"
        return (
          <button
            key={cat.id}
            type="button"
            onClick={() => handleClick({ category: cat.id as SkillCategory, source: "all" })}
            className={cn(
              "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
              active && "bg-accent font-medium"
            )}
          >
            <span className="flex items-center gap-1.5">
              <Icon className="size-3.5" />
              {t(`category.${cat.labelKey}` as never)}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {countsByCategory[cat.id] ?? 0}
            </span>
          </button>
        )
      })}
    </div>
  )
}
