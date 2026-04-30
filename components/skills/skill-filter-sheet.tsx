"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { SKILL_CATEGORIES, SKILL_SOURCES } from "@/lib/skills/categories"
import { useSkillsStore } from "@/stores/skills"
import type { SkillCategory, SkillSource, SkillStatus } from "@/lib/claude/types"

interface Props {
  allTags: string[]
}

const STATUS_OPTIONS: SkillStatus[] = ["enabled", "disabled", "error"]

export function SkillFilterSheet({ allTags }: Props) {
  const t = useTranslations("skills")
  const open = useSkillsStore((s) => s.filterSheetOpen)
  const setOpen = useSkillsStore((s) => s.setFilterSheetOpen)
  const filters = useSkillsStore((s) => s.filters)
  const setFilters = useSkillsStore((s) => s.setFilters)
  const reset = useSkillsStore((s) => s.resetFilters)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-80 sm:w-96 p-0">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>{t("filter.byCategory")}</SheetTitle>
          <SheetDescription>{t("filter.search")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-5 py-4">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("filter.byCategory")}</Label>
            <Select
              value={filters.category}
              onValueChange={(v) => setFilters({ category: v as SkillCategory | "all" })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">
                  {t("filter.all")}
                </SelectItem>
                {SKILL_CATEGORIES.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id} className="text-xs">
                    {t(`category.${cat.labelKey}` as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("filter.bySource")}</Label>
            <Select
              value={filters.source}
              onValueChange={(v) => setFilters({ source: v as SkillSource | "all" })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">
                  {t("filter.all")}
                </SelectItem>
                {SKILL_SOURCES.map((src) => (
                  <SelectItem key={src.id} value={src.id} className="text-xs">
                    {t(`source.${src.labelKey}` as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("filter.byStatus")}</Label>
            <Select
              value={filters.status}
              onValueChange={(v) => setFilters({ status: v as SkillStatus | "all" })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">
                  {t("filter.all")}
                </SelectItem>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">
                    {t(`status.${s}` as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("filter.byTag")}</Label>
            {allTags.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">—</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {allTags.map((tag) => (
                  <Badge
                    key={tag}
                    variant={filters.tag === tag ? "default" : "outline"}
                    onClick={() => setFilters({ tag: filters.tag === tag ? null : tag })}
                    className="cursor-pointer select-none text-[10px]"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("filter.sortBy")}</Label>
            <Select
              value={filters.sort}
              onValueChange={(v) => setFilters({ sort: v as typeof filters.sort })}
            >
              <SelectTrigger className="h-8 text-xs">
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
          </div>
        </div>
        <SheetFooter className="border-t px-5 py-3">
          <Button variant="ghost" size="sm" onClick={reset}>
            {t("filter.clear")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
