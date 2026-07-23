"use client"

/**
 * Mobile companion long-term Memory view (closes the `/memory` desktop-only
 * gap). Read-mostly mirror of the desktop MemoryConsole: lists memories from
 * Dexie (warmed by the `memories` sync handler so it works offline) with a
 * text filter, reusing the same `MemoryRow` the desktop panel uses. The
 * mutations enter the durable mobile outbound queue and optimistically update
 * the local mirror only after enqueue succeeds. The desktop remains the
 * authority and applies the shared policy, PII, audit, and vector lifecycle.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { useVirtualizer } from "@tanstack/react-virtual"
import { toast } from "sonner"

import { Input } from "@/components/ui/input"
import { EmptyState } from "@/components/mobile/empty-state"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { MemoryRow } from "@/components/memory/memory-row"
import {
  invalidateMemory,
  listMemories,
  setMemoryPinned,
  updateMemory,
} from "@/lib/db/memories"
import { enqueue as enqueueOutbound } from "@/lib/db/mobile-outbound-queue"
import { runSyncDown } from "@/lib/sync/companion-sync"

export interface MemoryMobileBodyProps {
  /** Scroll the deep-linked memory into view once (`/memory?id=` from chips). */
  initialSelectedId?: string
}

export function MemoryMobileBody({ initialSelectedId }: MemoryMobileBodyProps = {}) {
  const t = useTranslations("mobile.memory")
  const tErrors = useTranslations("memory.errors")
  const memories = useLiveQuery(() => listMemories({ status: "active" }), [])
  const [query, setQuery] = useState("")

  const visible = useMemo(() => {
    const list = memories ?? []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (m) => m.text.toLowerCase().includes(q) || (m.key ?? "").toLowerCase().includes(q)
    )
  }, [memories, query])

  // The PullToRefresh wrapper is the scroll container; virtualize against it
  // so large synced stores don't render every row on a phone.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 104,
    overscan: 8,
    getItemKey: (index) => visible[index]?.id ?? index,
  })

  /** Enqueue failures were silently swallowed — surface them as a toast. */
  const guarded = (work: Promise<void>) => {
    void work.catch(() => toast.error(tErrors("mutation_failed")))
  }

  // One-shot deep-link scroll once the target row is present in the live list.
  const scrolledToInitialRef = useRef(false)
  useEffect(() => {
    if (!initialSelectedId || scrolledToInitialRef.current) return
    const index = visible.findIndex((m) => m.id === initialSelectedId)
    if (index < 0) return
    scrolledToInitialRef.current = true
    virtualizer.scrollToIndex(index)
  }, [initialSelectedId, visible, virtualizer])

  const handleRefresh = async (): Promise<void> => {
    try {
      await runSyncDown({ only: ["memories"] })
    } catch {
      // Orchestrator swallows handler-level failures.
    }
  }

  const handlePinToggle = async (id: string, pinned: boolean): Promise<void> => {
    await enqueueOutbound({
      command: "memory_update",
      payload: { id, pinned },
      label: t("queueUpdateLabel"),
    })
    await setMemoryPinned(id, pinned)
  }

  const handleSave = async (id: string, text: string): Promise<void> => {
    await enqueueOutbound({
      command: "memory_update",
      payload: { id, text },
      label: t("queueUpdateLabel"),
    })
    await updateMemory(id, { text, bumpVersion: true })
  }

  const handleForget = async (id: string): Promise<void> => {
    await enqueueOutbound({
      command: "memory_forget",
      payload: { id },
      label: t("queueForgetLabel"),
    })
    await invalidateMemory(id)
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

      <PullToRefresh onRefresh={handleRefresh} onScrollElChange={setScrollEl}>
        <section className="px-4 pb-4">
          {visible.length === 0 ? (
            <EmptyState spotIcon="memory" title={t("empty")} />
          ) : (
            <div
              className="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
              data-testid="mobile-memory-virtual-list"
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const m = visible[virtualRow.index]
                if (!m) return null
                return (
                  <div
                    key={m.id}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 w-full pb-2"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <MemoryRow
                      memory={m}
                      onPinToggle={(id, pinned) => guarded(handlePinToggle(id, pinned))}
                      onSave={(id, text) => guarded(handleSave(id, text))}
                      onDelete={(id) => guarded(handleForget(id))}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </PullToRefresh>
    </main>
  )
}
