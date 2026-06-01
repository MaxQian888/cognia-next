"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BrainIcon, SearchIcon, ArchiveIcon, NotebookPenIcon, ListChecksIcon } from "lucide-react"
import type { Memory, MemoryType } from "@/types/memory/memory"
import { hardDeleteMemory, listMemories, setMemoryPinned, updateMemory } from "@/lib/db/memories"
import {
  computeMemoryStats,
  filterAndSortMemories,
  type MemorySortKey,
} from "@/lib/memory/history-filter"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { StatCard } from "@/components/scheduler/stat-card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { MemoryRow } from "./memory-row"

const TYPE_ORDER: MemoryType[] = ["semantic", "episodic", "procedural"]

/**
 * Full-page `/memory` management panel. Lists every memory with search, type +
 * status filters, sort, and per-row edit / pin / delete. Composed from reused
 * primitives (`StatCard`, `Empty`, shadcn `Select`/`Input`) over the pure
 * `filterAndSortMemories` helper and a live Dexie query.
 */
export function MemoryConsole() {
  const t = useTranslations("memory.panel")
  const tTypes = useTranslations("memory.types")
  const all = useLiveQuery(() => listMemories({}), [], [] as Memory[])

  const [query, setQuery] = useState("")
  const [types, setTypes] = useState<Set<MemoryType>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [sort, setSort] = useState<MemorySortKey>("recent")

  const stats = useMemo(() => computeMemoryStats(all), [all])
  const rows = useMemo(
    () =>
      filterAndSortMemories(all, {
        query,
        types: [...types],
        status: showAll ? "all" : "active",
        sort,
      }),
    [all, query, types, showAll, sort]
  )

  const toggleType = (type: MemoryType) =>
    setTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
          <BrainIcon className="size-5 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
      </header>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label={t("stats.active")}
          value={stats.active}
          icon={<BrainIcon className="size-4" />}
          accentGradient="from-violet-500 to-purple-400"
          iconBgClassName="bg-violet-500/15 text-violet-500"
          testid="memory-stat-active"
        />
        <StatCard
          label={tTypes("semantic")}
          value={stats.byType.semantic}
          icon={<NotebookPenIcon className="size-4" />}
          accentGradient="from-sky-500 to-cyan-400"
          iconBgClassName="bg-sky-500/15 text-sky-500"
        />
        <StatCard
          label={tTypes("episodic")}
          value={stats.byType.episodic}
          icon={<ListChecksIcon className="size-4" />}
          accentGradient="from-emerald-500 to-green-400"
          iconBgClassName="bg-emerald-500/15 text-emerald-500"
        />
        <StatCard
          label={tTypes("procedural")}
          value={stats.byType.procedural}
          icon={<ArchiveIcon className="size-4" />}
          accentGradient="from-amber-500 to-orange-400"
          iconBgClassName="bg-amber-500/15 text-amber-500"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-1" data-testid="memory-type-filters">
          {TYPE_ORDER.map((type) => (
            <Button
              key={type}
              size="sm"
              variant={types.has(type) ? "default" : "outline"}
              aria-pressed={types.has(type)}
              onClick={() => toggleType(type)}
            >
              {tTypes(type)}
            </Button>
          ))}
        </div>
        <Select value={sort} onValueChange={(v) => setSort(v as MemorySortKey)}>
          <SelectTrigger className="w-36" aria-label={t("sortLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">{t("sort.recent")}</SelectItem>
            <SelectItem value="importance">{t("sort.importance")}</SelectItem>
            <SelectItem value="accessed">{t("sort.accessed")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant={showAll ? "default" : "outline"}
          aria-pressed={showAll}
          onClick={() => setShowAll((v) => !v)}
        >
          {t("showInvalidated")}
        </Button>
      </div>

      {/* List */}
      <div className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto")}>
        {rows.length === 0 ? (
          <Empty>
            <EmptyMedia variant="icon">
              <BrainIcon className="size-6" />
            </EmptyMedia>
            <EmptyTitle>{t("empty.title")}</EmptyTitle>
            <EmptyDescription>{t("empty.description")}</EmptyDescription>
          </Empty>
        ) : (
          rows.map((m) => (
            <MemoryRow
              key={m.id}
              memory={m}
              onPinToggle={(id, pinned) => void setMemoryPinned(id, pinned)}
              onSave={(id, text) => void updateMemory(id, { text, bumpVersion: true })}
              onDelete={(id) => void hardDeleteMemory(id)}
            />
          ))
        )}
      </div>
    </div>
  )
}
