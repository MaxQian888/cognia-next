"use client"

/**
 * Earlier texts of one memory, newest first, each with why it was replaced and
 * the window it was live — the inspector's History section.
 *
 * Every change to a memory's text keeps the outgoing text as a revision
 * (`lib/db/memories.ts:preserveRevisionIfTextChanges`), so an edit, a
 * consolidation merge, a compaction or a duplicate fold can always be undone
 * here. Restoring is itself reversible: the text it replaces becomes the newest
 * revision.
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { HistoryIcon, RotateCcwIcon } from "lucide-react"

import type { Memory } from "@/types/memory/memory"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmActionDialog } from "@/components/agent/workspace/settings/confirm-action-dialog"

export interface MemoryRevisionHistoryProps {
  revisions: readonly Memory[]
  /** Absent → read-only history (e.g. an archived memory). */
  onRestore?: (revisionId: string) => void
}

export function MemoryRevisionHistory({ revisions, onRestore }: MemoryRevisionHistoryProps) {
  const t = useTranslations("memory.history")
  const format = useFormatter()
  const [pending, setPending] = useState<string | null>(null)

  if (revisions.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("empty")}</p>
  }

  const at = (ts: number) =>
    format.dateTime(new Date(ts), { dateStyle: "medium", timeStyle: "short" })

  return (
    <>
      <ol className="flex flex-col gap-2" data-testid="memory-revision-history">
        {revisions.map((revision) => (
          <li
            key={revision.id}
            className="flex flex-col gap-1 rounded-md border px-2 py-1.5"
            data-testid="memory-revision"
            data-revision-id={revision.id}
          >
            <div className="flex items-center gap-1.5">
              <HistoryIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                {t(`reasons.${revision.revisionReason ?? "edit"}`)}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {t("window", {
                  from: at(revision.revisedAt ?? revision.createdAt),
                  to: at(revision.invalidatedAt ?? revision.updatedAt),
                })}
              </span>
              {onRestore ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs"
                  onClick={() => setPending(revision.id)}
                  data-testid="memory-revision-restore"
                >
                  <RotateCcwIcon className="size-3.5" />
                  {t("restore")}
                </Button>
              ) : null}
            </div>
            <p className="line-clamp-4 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {revision.text}
            </p>
          </li>
        ))}
      </ol>
      <ConfirmActionDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
        title={t("restoreConfirm.title")}
        description={t("restoreConfirm.description")}
        confirmLabel={t("restoreConfirm.confirm")}
        cancelLabel={t("restoreConfirm.cancel")}
        onConfirm={() => {
          if (pending) onRestore?.(pending)
          setPending(null)
        }}
      />
    </>
  )
}
