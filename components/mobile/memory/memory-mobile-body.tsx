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

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

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

export function MemoryMobileBody() {
  const t = useTranslations("mobile.memory")
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

      <PullToRefresh onRefresh={handleRefresh}>
        <section className="flex flex-col gap-2 px-4 pb-4">
          {visible.length === 0 ? (
            <EmptyState spotIcon="memory" title={t("empty")} />
          ) : (
            visible.map((m) => (
              <MemoryRow
                key={m.id}
                memory={m}
                onPinToggle={(id, pinned) => void handlePinToggle(id, pinned)}
                onSave={(id, text) => void handleSave(id, text)}
                onDelete={(id) => void handleForget(id)}
              />
            ))
          )}
        </section>
      </PullToRefresh>
    </main>
  )
}
