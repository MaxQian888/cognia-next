"use client"

import { useTranslations } from "next-intl"
import { LayersIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { SKILL_CATEGORIES, SKILL_SOURCES } from "@/lib/skills/categories"
import { useSkillsStore } from "@/stores/skills"
import type { SkillCategory, SkillSource } from "@cognia/agent-config-types"

interface Props {
  total: number
  countsByCategory: Record<string, number>
  countsBySource: Record<string, number>
  /** Fires after every selection — used by the mobile Sheet to auto-close. */
  onSelect?: () => void
}

/**
 * Button-list rendering mounted inside the mobile `SkillCategorySheet`
 * (desktop filtering lives in `SkillListPane`'s selects). Pure
 * presentation — selection writes through `useSkillsStore.setFilters`.
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
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => handleClick({ category: "all", source: "all" })}
        className={cn(
          "w-full justify-between px-2 text-xs font-normal",
          isAll && "bg-accent font-medium"
        )}
      >
        <span className="flex items-center gap-1.5">
          <LayersIcon className="size-3.5" />
          {t("filter.all")}
        </span>
        <span className="text-[10px] text-muted-foreground">{total}</span>
      </Button>

      <p className="mt-3 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t("filter.bySource")}
      </p>
      {SKILL_SOURCES.map((src) => (
        <Button
          key={src.id}
          variant="ghost"
          size="sm"
          onClick={() => handleClick({ source: src.id as SkillSource, category: "all" })}
          className={cn(
            "w-full justify-between px-2 text-xs font-normal",
            filters.source === src.id && filters.category === "all" && "bg-accent font-medium"
          )}
        >
          <span>{t(`source.${src.labelKey}` as never)}</span>
          <span className="text-[10px] text-muted-foreground">{countsBySource[src.id] ?? 0}</span>
        </Button>
      ))}

      <p className="mt-3 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t("filter.byCategory")}
      </p>
      {SKILL_CATEGORIES.map((cat) => {
        const Icon = cat.icon
        const active = filters.category === cat.id && filters.source === "all"
        return (
          <Button
            key={cat.id}
            variant="ghost"
            size="sm"
            onClick={() => handleClick({ category: cat.id as SkillCategory, source: "all" })}
            className={cn(
              "w-full justify-between px-2 text-xs font-normal",
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
          </Button>
        )
      })}
    </div>
  )
}
