"use client"

/**
 * Mobile companion long-term Memory view (closes the `/memory` desktop-only
 * gap). Read-mostly mirror of the desktop MemoryConsole: lists memories from
 * Dexie (warmed by the `memories` sync handler so it works offline) with a
 * text filter, reusing the same `MemoryRow` the desktop panel uses. The
 * pin/edit/delete affordances act on the local cache, matching desktop.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Input } from "@/components/ui/input"
import { EmptyState } from "@/components/mobile/empty-state"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { MemoryRow } from "@/components/memory/memory-row"
import {
  hardDeleteMemory,
  listMemories,
  setMemoryPinned,
  updateMemory,
} from "@/lib/db/memories"
import { runSyncDown } from "@/lib/sync/companion-sync"

export function MemoryMobileBody() {
  const t = useTranslations("mobile.memory")
  const memories = useLiveQuery(() => listMemories(), [])
  const [query, setQuery] = useState("")

  const visible = useMemo(() => {
    const list = memories ?? []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (m) => m.text.toLowerCase().includes(q) || (m.key ?? "").toLowerCase().includes(q)
    )
  }, [memories, query])

  const handleRefresh = async (): Promise<void> => {
    try {
      await runSyncDown({ only: ["memories"] })
    } catch {
      // Orchestrator swallows handler-level failures.
    }
  }

  return (
    <main
      className="flex min-h-[100dvh] flex-col gap-4 bg-background pt-3 safe-area-pt"
      data-testid="mobile-memory-body"
    >
      <header className="flex flex-col gap-3 px-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchAria")}
          data-testid="mobile-memory-search"
        />
      </header>

      <PullToRefresh onRefresh={handleRefresh}>
        <section className="flex flex-col gap-2 px-4 pb-4">
          {visible.length === 0 ? (
            <EmptyState spotIcon="memory" title={t("empty")} />
          ) : (
            visible.map((m) => (
              <MemoryRow
                key={m.id}
                memory={m}
                onPinToggle={(id, pinned) => void setMemoryPinned(id, pinned)}
                onSave={(id, text) => void updateMemory(id, { text })}
                onDelete={(id) => void hardDeleteMemory(id)}
              />
            ))
          )}
        </section>
      </PullToRefresh>
    </main>
  )
}
