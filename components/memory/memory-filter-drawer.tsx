"use client"

/**
 * Filter and sort for `/memory` on a touch layout: a bottom drawer with chip
 * groups, the same facets the desktop Filter menu offers (`useMemoryFacetGroups`)
 * at a size a thumb can hit. Sort lives here too — on a phone there is no room
 * for a second menu button, and both answer "which rows, in what order".
 */

import { useTranslations } from "next-intl"
import { CheckIcon, ListFilterIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import {
  clearMemoryFacets,
  countActiveMemoryFilters,
  type MemoryFacets,
  type MemoryFilter,
  type MemorySortKey,
} from "@/lib/memory/history-filter"
import { cn } from "@/lib/utils"
import { useMemoryFacetGroups } from "./memory-facet-groups"
import { MEMORY_SORT_KEYS } from "./memory-toolbar"

export interface MemoryFilterDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  facets: MemoryFacets
  filter: MemoryFilter
  onFilterChange: (filter: MemoryFilter) => void
  projectNames?: Record<string, string>
  sort: MemorySortKey
  onSortChange: (sort: MemorySortKey) => void
}

export function MemoryFilterDrawer({
  open,
  onOpenChange,
  facets,
  filter,
  onFilterChange,
  projectNames,
  sort,
  onSortChange,
}: MemoryFilterDrawerProps) {
  const t = useTranslations("memory.panel")
  const groups = useMemoryFacetGroups({ facets, filter, onFilterChange, projectNames })
  const visibleGroups = groups.filter((group) => group.options.length > 0)
  const activeCount = countActiveMemoryFilters(filter)

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="max-h-[85vh] pb-[env(safe-area-inset-bottom)]"
        data-testid="memory-filter-drawer"
      >
        <DrawerHeader className="pb-2 text-left">
          <DrawerTitle className="flex items-center gap-2">
            <ListFilterIcon className="size-4 text-muted-foreground" aria-hidden />
            {t("filter.drawerTitle")}
          </DrawerTitle>
          <DrawerDescription>
            {activeCount > 0
              ? t("filter.activeCount", { count: activeCount })
              : t("filter.drawerHint")}
          </DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <ChipGroup label={t("display.sort")}>
            {MEMORY_SORT_KEYS.map((key) => (
              <Chip
                key={key}
                selected={sort === key}
                onClick={() => onSortChange(key)}
                testId={`memory-drawer-sort-${key}`}
                role="radio"
              >
                {t(`sort.${key}`)}
              </Chip>
            ))}
          </ChipGroup>
          {visibleGroups.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">{t("filter.none")}</p>
          ) : (
            visibleGroups.map((group) => (
              <ChipGroup key={group.key} label={group.label}>
                {group.options.map((option) => (
                  <Chip
                    key={option.value}
                    selected={(group.selected ?? []).includes(option.value)}
                    onClick={() => group.toggle(option.value)}
                    testId={`memory-drawer-${group.key}-${option.value}`}
                    count={option.count}
                  >
                    {group.render(option.value)}
                  </Chip>
                ))}
              </ChipGroup>
            ))
          )}
        </div>
        <DrawerFooter className="flex-row gap-2">
          <Button
            variant="outline"
            className="flex-1"
            disabled={activeCount === 0}
            onClick={() => onFilterChange(clearMemoryFacets(filter))}
            data-testid="memory-drawer-clear"
          >
            {t("filter.clear")}
          </Button>
          <DrawerClose asChild>
            <Button className="flex-1" data-testid="memory-drawer-done">
              {t("filter.done")}
            </Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}

function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b py-3 last:border-b-0">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {children}
      </div>
    </section>
  )
}

function Chip({
  selected,
  onClick,
  children,
  count,
  testId,
  role,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
  count?: number
  testId: string
  role?: "radio"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role={role}
      aria-checked={role === "radio" ? selected : undefined}
      aria-pressed={role === "radio" ? undefined : selected}
      data-testid={testId}
      className={cn(
        "inline-flex h-8 max-w-full items-center gap-1 rounded-pill border px-3 text-xs transition-colors",
        selected
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-border bg-muted/40 text-foreground"
      )}
    >
      {selected ? <CheckIcon className="size-3 shrink-0" aria-hidden /> : null}
      <span className="truncate">{children}</span>
      {count !== undefined ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
      ) : null}
    </button>
  )
}
