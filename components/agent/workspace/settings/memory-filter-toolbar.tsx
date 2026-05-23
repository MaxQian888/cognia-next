"use client"

/**
 * Filter toolbar for the shared-memory list. The `applyMemoryFilter` helper
 * is exported pure so the section + tests can filter without rendering.
 */

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { SharedMemoryEntry } from "@/types/agent/agent-team"

export interface MemoryFilter {
  writerId: string | null
  tag: string | null
  text: string
}

export const EMPTY_MEMORY_FILTER: MemoryFilter = { writerId: null, tag: null, text: "" }

function valueToText(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Pure filter — keeps entries matching every active criterion. */
export function applyMemoryFilter(
  entries: SharedMemoryEntry[],
  filter: MemoryFilter
): SharedMemoryEntry[] {
  const text = filter.text.trim().toLowerCase()
  return entries.filter((e) => {
    if (filter.writerId && e.writtenBy !== filter.writerId) return false
    if (filter.tag && !(e.tags ?? []).includes(filter.tag)) return false
    if (text) {
      const hay = `${e.key} ${valueToText(e.value)}`.toLowerCase()
      if (!hay.includes(text)) return false
    }
    return true
  })
}

export interface MemoryFilterToolbarProps {
  filter: MemoryFilter
  onChange: (next: MemoryFilter) => void
  writers: Array<{ id: string; name: string }>
  availableTags: string[]
}

const ANY = "__any__"

export function MemoryFilterToolbar({
  filter,
  onChange,
  writers,
  availableTags,
}: MemoryFilterToolbarProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.memory.filter")
  const isActive = filter.writerId !== null || filter.tag !== null || filter.text.trim() !== ""

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={filter.text}
        onChange={(e) => onChange({ ...filter, text: e.target.value })}
        placeholder={t("text")}
        className="h-8 max-w-[200px] text-xs"
        data-testid="memory-filter-text"
      />
      <Select
        value={filter.writerId ?? ANY}
        onValueChange={(v) => onChange({ ...filter, writerId: v === ANY ? null : v })}
      >
        <SelectTrigger className="h-8 w-[140px] text-xs">
          <SelectValue placeholder={t("writer")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{t("writer")}</SelectItem>
          {writers.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filter.tag ?? ANY}
        onValueChange={(v) => onChange({ ...filter, tag: v === ANY ? null : v })}
      >
        <SelectTrigger className="h-8 w-[120px] text-xs">
          <SelectValue placeholder={t("tags")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{t("tags")}</SelectItem>
          {availableTags.map((tag) => (
            <SelectItem key={tag} value={tag}>
              {tag}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isActive ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs"
          onClick={() => onChange(EMPTY_MEMORY_FILTER)}
        >
          {t("reset")}
        </Button>
      ) : null}
    </div>
  )
}
