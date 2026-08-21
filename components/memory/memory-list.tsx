"use client"

/**
 * The virtualized memory list — the only thing on `/memory` that is actually
 * content, so it gets the whole center pane.
 *
 * Empty states are split three ways on purpose. "Still loading" must not paint
 * the same thing as "you have no memories", or every visit flashes an
 * onboarding CTA before the Dexie read resolves; and "nothing matched your
 * filters" has to offer a way back, not an invitation to add a first memory the
 * user may already have hundreds of.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { useVirtualizer } from "@tanstack/react-virtual"
import { BrainIcon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { MemoryRow, type MemoryRowDensity } from "@/components/memory/memory-row"
import type { Memory } from "@/types/memory/memory"
import { cn } from "@/lib/utils"

const ESTIMATED_ROW_HEIGHT = { comfortable: 96, compact: 72 } as const

export interface MemoryListProps {
  rows: readonly Memory[]
  /** True until the first Dexie result lands — keeps empty states from flashing. */
  isLoading: boolean
  /** Whether the store holds anything at all, ignoring the active filters. */
  hasAnyMemories: boolean
  density?: MemoryRowDensity
  selectedId?: string
  selectedIds: ReadonlySet<string>
  selectionActive: boolean
  activeTags?: ReadonlySet<string>
  onOpenDetail: (id: string) => void
  onSelectToggle: (id: string, selected: boolean) => void
  onPinToggle: (id: string, pinned: boolean) => void
  onSave: (id: string, text: string) => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
  onTagClick: (tag: string) => void
  onClearFilters: () => void
  onAddFirst: () => void
  /** Scroll this row into view once (deep link from `/memory?id=`). */
  scrollToId?: string
}

export function MemoryList({
  rows,
  isLoading,
  hasAnyMemories,
  density = "comfortable",
  selectedId,
  selectedIds,
  selectionActive,
  activeTags,
  onOpenDetail,
  onSelectToggle,
  onPinToggle,
  onSave,
  onArchive,
  onDelete,
  onTagClick,
  onClearFilters,
  onAddFirst,
  scrollToId,
}: MemoryListProps) {
  const t = useTranslations("memory.panel")
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT[density],
    overscan: 10,
    getItemKey: (index) => rows[index]?.id ?? index,
  })

  // One-shot deep-link scroll, armed only once the target is actually present.
  const scrolledRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!scrollToId || scrolledRef.current === scrollToId) return
    const index = rows.findIndex((row) => row.id === scrollToId)
    if (index < 0) return
    scrolledRef.current = scrollToId
    virtualizer.scrollToIndex(index, { align: "center" })
  }, [scrollToId, rows, virtualizer])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 p-3" data-testid="memory-list-loading">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton
            key={index}
            className="w-full rounded-md"
            style={{ height: ESTIMATED_ROW_HEIGHT[density] - 12 }}
          />
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return hasAnyMemories ? (
      <Empty className="h-full" data-testid="memory-empty-filtered">
        <EmptyMedia variant="icon">
          <SearchIcon />
        </EmptyMedia>
        <EmptyTitle>{t("noResults.title")}</EmptyTitle>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            {t("clearFilters")}
          </Button>
        </EmptyContent>
      </Empty>
    ) : (
      <Empty className="h-full" data-testid="memory-empty">
        <EmptyMedia variant="icon">
          <BrainIcon />
        </EmptyMedia>
        <EmptyTitle>{t("empty.title")}</EmptyTitle>
        <EmptyContent>
          <Button size="sm" onClick={onAddFirst}>
            {t("addFirst")}
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <div ref={scrollRef} className={cn("h-full min-h-0 overflow-y-auto")} data-testid="memory-list">
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const memory = rows[virtualRow.index]
          if (!memory) return null
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <MemoryRow
                memory={memory}
                density={density}
                active={memory.id === selectedId}
                selectable={selectionActive}
                selected={selectedIds.has(memory.id)}
                activeTags={activeTags}
                onOpenDetail={onOpenDetail}
                onSelectToggle={onSelectToggle}
                onPinToggle={onPinToggle}
                onSave={onSave}
                onArchive={onArchive}
                onDelete={onDelete}
                onTagClick={onTagClick}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
