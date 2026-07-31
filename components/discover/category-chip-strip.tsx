"use client"

/**
 * Horizontally scrollable chip strip used on mobile to navigate between
 * discover categories. Consumes the user's layout (`useDiscoverLayout`) so the
 * visible set + order match the desktop sidebar: a pinned "Favorites" chip
 * first, then pinned categories, then overflow, with hidden categories dropped.
 *
 * The strip auto-scrolls the active chip into view on category changes so
 * deep-links (`/discover?category=ocrProviders`) land already visible.
 * Super-group boundaries surface as subtle vertical separators.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { CompassIcon, SparklesIcon, StarIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useDiscoverLayout } from "@/hooks/discover/use-discover-layout"
import { FAVORITES_CATEGORY, FORYOU_CATEGORY, type DiscoverView } from "@/lib/discover/categories"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { cn } from "@/lib/utils"

export interface CategoryChipStripProps {
  activeCategory: DiscoverView
  onSelect: (id: DiscoverView) => void
  className?: string
}

export function CategoryChipStrip({ activeCategory, onSelect, className }: CategoryChipStripProps) {
  const t = useTranslations("discover")
  const { resolved } = useDiscoverLayout()
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLButtonElement | null>(null)

  const visible = [...resolved.pinned, ...resolved.overflow]

  // Center the active chip when the category changes (incl. deep-link mount).
  useEffect(() => {
    const node = activeRef.current
    if (!node) return
    node.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" })
  }, [activeCategory])

  const favoritesActive = activeCategory === FAVORITES_CATEGORY
  const foryouActive = activeCategory === FORYOU_CATEGORY

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
      <Button
        ref={foryouActive ? activeRef : undefined}
        type="button"
        role="tab"
        variant={foryouActive ? "default" : "outline"}
        size="sm"
        onClick={() => onSelect(FORYOU_CATEGORY)}
        aria-selected={foryouActive}
        aria-current={foryouActive ? "page" : undefined}
        data-testid="chip-strip-foryou"
        className={cn(
          "shrink-0 snap-start gap-1.5 whitespace-nowrap",
          foryouActive ? "font-medium" : "font-normal"
        )}
      >
        <SparklesIcon className="size-4 shrink-0" />
        {t("categories.foryou")}
      </Button>

      <Button
        ref={favoritesActive ? activeRef : undefined}
        type="button"
        role="tab"
        variant={favoritesActive ? "default" : "outline"}
        size="sm"
        onClick={() => onSelect(FAVORITES_CATEGORY)}
        aria-selected={favoritesActive}
        aria-current={favoritesActive ? "page" : undefined}
        data-testid="chip-strip-favorites"
        className={cn(
          "shrink-0 snap-start gap-1.5 whitespace-nowrap",
          favoritesActive ? "font-medium" : "font-normal"
        )}
      >
        <StarIcon className="size-4 shrink-0" />
        {t("categories.favorites")}
      </Button>

      {visible.map((cat, idx) => {
        const Icon = resolveIcon(cat.iconName) ?? CompassIcon
        const active = cat.id === activeCategory
        const prevGroup = idx > 0 ? visible[idx - 1].group : null
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
