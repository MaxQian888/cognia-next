"use client"

/**
 * Compact memory panel for the Context Workbench.
 *
 * Shows a searchable, scrollable list of memories with inline pin/delete actions,
 * optimized for the narrow/wide workbench widths. For the full management page
 * (detail sidebar, bulk editing, conflict resolution), use `/memory`.
 */

import { useCallback, useDeferredValue, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BrainIcon, PlusIcon, SearchIcon, ExternalLinkIcon } from "lucide-react"
import Link from "next/link"
import type { Memory } from "@/types/memory/memory"
import { listMemories } from "@/lib/db/memories"
import { manageMemory } from "@/lib/memory/control-plane/manage"
import { filterAndSortMemories, type MemorySortKey } from "@/lib/memory/history-filter"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MemoryRow } from "@/components/memory/memory-row"
import { AddMemoryDialog, type AddMemoryInput } from "@/components/memory/add-memory-dialog"

export interface MemoryWorkbenchPanelProps {
  /** Session id that provides scope context for newly added memories. */
  sessionId?: string | null
}

export function MemoryWorkbenchPanel({ sessionId: _sessionId }: MemoryWorkbenchPanelProps) {
  const t = useTranslations("contextWorkbench.memoryPanel")
  const tMemPanel = useTranslations("memory.panel")

  const all = useLiveQuery(() => listMemories({}), [], [] as Memory[])

  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<MemorySortKey>("recent")
  const [addOpen, setAddOpen] = useState(false)

  const deferredQuery = useDeferredValue(query)

  const rows = useMemo(
    () =>
      filterAndSortMemories(all, {
        query: deferredQuery,
        status: "active",
        sort,
      }),
    [all, deferredQuery, sort]
  )

  const handlePin = useCallback((id: string, pinned: boolean) => {
    void manageMemory({ kind: "pin", id, pinned: !pinned })
  }, [])

  const handleSave = useCallback((id: string, text: string) => {
    void manageMemory({ kind: "update", id, patch: { text } })
  }, [])

  const handleDelete = useCallback((id: string) => {
    void manageMemory({ kind: "delete", id })
  }, [])

  const handleCreate = useCallback(async (input: AddMemoryInput) => {
    await manageMemory({ kind: "create", ...input })
  }, [])

  return (
    <div className="flex h-full flex-col">
      {/* Header controls */}
      <div className="flex shrink-0 flex-col gap-2 border-b p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchLabel")}
              className="h-8 pl-8 text-sm"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={() => setAddOpen(true)}
            aria-label={t("addMemory")}
          >
            <PlusIcon className="size-4" />
          </Button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {t("count", { count: rows.length })}
          </span>
          <Select value={sort} onValueChange={(v) => setSort(v as MemorySortKey)}>
            <SelectTrigger className="h-7 w-[100px] text-xs" aria-label={t("sortLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">{tMemPanel("sort.recent")}</SelectItem>
              <SelectItem value="importance">{tMemPanel("sort.importance")}</SelectItem>
              <SelectItem value="accessed">{tMemPanel("sort.accessed")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Memory list */}
      <ScrollArea className="flex-1">
        {rows.length === 0 ? (
          <Empty className="h-48 rounded-none">
            <EmptyMedia variant="icon">
              <BrainIcon />
            </EmptyMedia>
            <EmptyTitle className="text-sm">{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription className="text-xs">{t("emptyDescription")}</EmptyDescription>
          </Empty>
        ) : (
          <div className="divide-y">
            {rows.map((memory) => (
              <MemoryRow
                key={memory.id}
                memory={memory}
                onPinToggle={handlePin}
                onSave={handleSave}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Footer link to full memory page */}
      <div className="shrink-0 border-t p-2">
        <Button variant="ghost" size="sm" className="w-full text-xs" asChild>
          <Link href="/memory">
            <ExternalLinkIcon className="mr-1.5 size-3" />
            {t("openFullPage")}
          </Link>
        </Button>
      </div>

      <AddMemoryDialog open={addOpen} onOpenChange={setAddOpen} onCreate={handleCreate} />
    </div>
  )
}
