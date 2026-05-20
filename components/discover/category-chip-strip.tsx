"use client"

/**
 * Horizontally scrollable chip strip used on mobile to navigate between
 * discover categories. Replaces the cramped `grid-cols-5` TabsList from
 * the original Wave-2.4 implementation — with the Phase 3/5 additions the
 * registry has 10 categories, which no fixed-column grid can carry on a
 * 375px-wide viewport.
 *
 * The strip auto-scrolls the active chip into view on category changes so
 * deep-links (`/discover?category=ocrProviders`) land already visible.
 * Super-group boundaries surface as subtle vertical separators between
 * the last entry of one group and the first entry of the next.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import {
  CompassIcon,
  FileEditIcon,
  InboxIcon,
  PlugIcon,
  PuzzleIcon,
  ScanTextIcon,
  SparklesIcon,
  UsersIcon,
  UsersRoundIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { DISCOVER_CATEGORIES, type DiscoverCategoryId } from "@/lib/discover/categories"
import { cn } from "@/lib/utils"

const ICON_BY_NAME: Record<string, React.ComponentType<{ className?: string }>> = {
  Users: UsersIcon,
  UsersRound: UsersRoundIcon,
  Sparkles: SparklesIcon,
  Puzzle: PuzzleIcon,
  FileEdit: FileEditIcon,
  Wrench: WrenchIcon,
  Plug: PlugIcon,
  ScanText: ScanTextIcon,
  Workflow: WorkflowIcon,
  Inbox: InboxIcon,
}

function iconFor(iconName: string): React.ComponentType<{ className?: string }> {
  return ICON_BY_NAME[iconName] ?? CompassIcon
}

export interface CategoryChipStripProps {
  activeCategory: DiscoverCategoryId
  onSelect: (id: DiscoverCategoryId) => void
  className?: string
}

export function CategoryChipStrip({ activeCategory, onSelect, className }: CategoryChipStripProps) {
  const t = useTranslations("discover")
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLButtonElement | null>(null)

  // Center the active chip when the category changes (incl. deep-link mount).
  useEffect(() => {
    const node = activeRef.current
    if (!node) return
    node.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" })
  }, [activeCategory])

  return (
    <div
      ref={scrollerRef}
      role="tablist"
      aria-label={t("chipStripAria")}
      className={cn(
        "flex w-full snap-x snap-mandatory items-center gap-2 overflow-x-auto",
        "scrollbar-thin px-4 pb-2 [&::-webkit-scrollbar]:hidden",
        className
      )}
      data-testid="discover-chip-strip"
    >
      {DISCOVER_CATEGORIES.map((cat, idx) => {
        const Icon = iconFor(cat.iconName)
        const active = cat.id === activeCategory
        const prevGroup = idx > 0 ? DISCOVER_CATEGORIES[idx - 1].group : null
        const showGroupDivider = prevGroup !== null && prevGroup !== cat.group
        return (
          <div key={cat.id} className="flex shrink-0 items-center gap-2 snap-start">
            {showGroupDivider ? (
              <span
                className="h-5 w-px bg-border"
                aria-hidden="true"
                data-testid={`chip-strip-divider-${cat.group}`}
              />
            ) : null}
            <Button
              ref={active ? activeRef : undefined}
              type="button"
              role="tab"
              variant={active ? "default" : "outline"}
              size="sm"
              onClick={() => onSelect(cat.id)}
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              data-testid={`chip-strip-${cat.id}`}
              className={cn("gap-1.5 whitespace-nowrap", active ? "font-medium" : "font-normal")}
            >
              <Icon className="size-4 shrink-0" />
              {t(`categories.${cat.id}`)}
            </Button>
          </div>
        )
      })}
    </div>
  )
}
