"use client"

/**
 * Shared item grid for the discover page — used by the desktop center pane
 * and (eventually, after Phase 5) the mobile chip-strip variant. Pure
 * presentational: it never reads Dexie itself, only renders the items it's
 * handed and dispatches selection back to the URL state hook via the
 * `onSelectItem` callback.
 */

import { useTranslations } from "next-intl"
import { CompassIcon } from "lucide-react"

import { DiscoverItemCard } from "@/components/discover/discover-item-card"
import { EmptyState } from "@/components/mobile/empty-state"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"
import type { DiscoverCategoryId } from "@/lib/discover/categories"
import { cn } from "@/lib/utils"

export interface DiscoverGridProps {
  category: DiscoverCategoryId
  items: DiscoverItem[]
  loading: boolean
  query: string
  selectedItemId: string | null
  onSelectItem: (id: string) => void
  className?: string
}

const EMPTY_KEY_BY_CATEGORY: Partial<Record<DiscoverCategoryId, string>> = {
  characters: "emptyCharacters",
  teams: "emptyTeams",
  skills: "emptySkills",
  plugins: "emptyPlugins",
  mcpTools: "emptyMcpTools",
  connectors: "emptyConnectors",
  ocrProviders: "emptyOcrProviders",
  workflowTemplates: "emptyWorkflowTemplates",
  twinIngest: "emptyTwinIngest",
  twinDrafts: "emptyTwinDrafts",
}

export function DiscoverGrid({
  category,
  items,
  loading,
  query,
  selectedItemId,
  onSelectItem,
  className,
}: DiscoverGridProps) {
  const t = useTranslations("discover")
  const trimmed = query.trim()

  if (loading) {
    return (
      <div
        aria-busy="true"
        className={cn("flex flex-1 items-center justify-center p-6", className)}
        data-testid="discover-grid-loading"
      >
        <span className="text-sm text-muted-foreground">{t("grid.loading")}</span>
      </div>
    )
  }

  if (items.length === 0) {
    const emptyKey = EMPTY_KEY_BY_CATEGORY[category] ?? "empty.noQuery"
    return (
      <div
        className={cn("flex flex-1 items-center justify-center p-6", className)}
        data-testid="discover-grid-empty"
      >
        <EmptyState
          icon={CompassIcon}
          title={trimmed.length > 0 ? t("emptyFiltered", { query: trimmed }) : t(emptyKey)}
        />
      </div>
    )
  }

  return (
    <ul
      role="list"
      aria-label={t("grid.aria", { category: t(`categories.${category}`) })}
      className={cn("flex flex-col gap-2 overflow-y-auto p-4", className)}
      data-testid={`discover-grid-${category}`}
    >
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`}>
          <DiscoverItemCard
            item={item}
            selected={item.id === selectedItemId}
            onSelect={() => onSelectItem(item.id)}
          />
        </li>
      ))}
    </ul>
  )
}
