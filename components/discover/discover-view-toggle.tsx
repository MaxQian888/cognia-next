"use client"

/**
 * Grid / list / compact view toggle for the discover grid. Mirrors
 * `components/plugins/library/plugin-library-view-toggle.tsx` (same shadcn
 * `ToggleGroup` primitive) but is bound to `useDiscoverView`, which persists
 * per-category to `AppSettings` (cross-device) rather than to a localStorage
 * zustand store.
 */

import { useTranslations } from "next-intl"
import { LayoutGridIcon, ListIcon, Rows3Icon } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useDiscoverView } from "@/hooks/discover/use-discover-view"
import { isValidViewMode, type DiscoverView } from "@/lib/discover/categories"

export interface DiscoverViewToggleProps {
  category: DiscoverView
  className?: string
}

export function DiscoverViewToggle({ category, className }: DiscoverViewToggleProps) {
  const t = useTranslations("discover.view")
  const { view, setView } = useDiscoverView()
  const mode = view(category)

  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={mode}
      onValueChange={(value) => {
        if (isValidViewMode(value)) void setView(category, value)
      }}
      aria-label={t("aria")}
      className={className}
      data-testid="discover-view-toggle"
    >
      <ToggleGroupItem value="grid" aria-label={t("grid")} data-testid="discover-view-grid">
        <LayoutGridIcon className="size-3.5" />
      </ToggleGroupItem>
      <ToggleGroupItem value="list" aria-label={t("list")} data-testid="discover-view-list">
        <ListIcon className="size-3.5" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="compact"
        aria-label={t("compact")}
        data-testid="discover-view-compact"
      >
        <Rows3Icon className="size-3.5" />
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
