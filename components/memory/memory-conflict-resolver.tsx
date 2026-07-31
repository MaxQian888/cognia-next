"use client"

/**
 * Guided conflict-disposition dialog for the `/memory` console (ADR-0069
 * round 2). Consolidation retains contradictory memories as
 * `reviewStatus: "conflict"` pairs (linked via `conflictWithIds`) and excludes
 * both from recall; until now the only tooling was jumping between the two
 * rows by hand. This card shows the pair side-by-side and resolves it in one
 * click through `manageMemory({ kind: "resolve-conflict" })`, which writes the
 * audit trail: keep A / keep B (loser soft-invalidated with a superseded
 * link), keep both (conflict edges cleared, both verified), or a hand-written
 * merge (PII-gated text onto the kept row).
 */

import { useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { manageMemory } from "@/lib/memory/control-plane/manage"
import { cn } from "@/lib/utils"
import type { Memory } from "@/types/memory/memory"

export interface MemoryConflictResolverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The conflict row the user opened (side A). */
  memory: Memory
  /** Resolve the opposing row (side B) from `conflictWithIds`. */
  resolveMemory: (id: string) => Memory | undefined
  /** Called after a successful disposition with the surviving memory id. */
  onResolved?: (keptId: string) => void
}

export function MemoryConflictResolver({
  open,
  onOpenChange,
  memory,
  resolveMemory,
  onResolved,
}: MemoryConflictResolverProps) {
  const t = useTranslations("memory.conflicts")
  const tErrors = useTranslations("memory.errors")
  const [merging, setMerging] = useState(false)
  const [mergedText, setMergedText] = useState(memory.text)
  const [busy, setBusy] = useState(false)

  const otherId = memory.conflictWithIds?.[0]
  const other = otherId ? resolveMemory(otherId) : undefined

  const run = async (command: Parameters<typeof manageMemory>[0], keptId: string) => {
    setBusy(true)
    const result = await manageMemory(command)
    setBusy(false)
    if (!result.ok) {
      toast.error(tErrors(result.reason))
      return
    }
    toast.success(t("resolvedToast"))
    onResolved?.(keptId)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="memory-conflict-resolver">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {other ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <ConflictSide
                memory={memory}
                keepLabel={t("keepThis")}
                disabled={busy}
                onKeep={() =>
                  void run(
                    { kind: "resolve-conflict", keepId: memory.id, dropId: other.id, mode: "keep" },
                    memory.id
                  )
                }
              />
              <ConflictSide
                memory={other}
                keepLabel={t("keepThis")}
                disabled={busy}
                onKeep={() =>
                  void run(
                    { kind: "resolve-conflict", keepId: other.id, dropId: memory.id, mode: "keep" },
                    other.id
                  )
                }
              />
            </div>

            {merging && (
              <div className="flex flex-col gap-2">
                <Textarea
                  value={mergedText}
                  onChange={(event) => setMergedText(event.target.value)}
                  rows={3}
                  placeholder={t("mergePlaceholder")}
                  aria-label={t("mergeAria")}
                />
              </div>
            )}

            <DialogFooter className="sm:justify-between">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(
                    {
                      kind: "resolve-conflict",
                      keepId: memory.id,
                      dropId: other.id,
                      mode: "keep-both",
                    },
                    memory.id
                  )
                }
              >
                {t("keepBoth")}
              </Button>
              {merging ? (
                <div className="flex gap-2">
                  <Button variant="ghost" disabled={busy} onClick={() => setMerging(false)}>
                    {t("mergeCancel")}
                  </Button>
                  <Button
                    disabled={busy || !mergedText.trim()}
                    onClick={() =>
                      void run(
                        {
                          kind: "resolve-conflict",
                          keepId: memory.id,
                          dropId: other.id,
                          mode: "merge",
                          mergedText,
                        },
                        memory.id
                      )
                    }
                  >
                    {t("mergeConfirm")}
                  </Button>
                </div>
              ) : (
                <Button variant="outline" disabled={busy} onClick={() => setMerging(true)}>
                  {t("merge")}
                </Button>
              )}
            </DialogFooter>
          </>
        ) : (
          // The opposing row was deleted out from under the conflict — offer to
          // clear the stale flag so the memory rejoins recall.
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{t("counterpartMissing")}</p>
            <DialogFooter>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  const result = await manageMemory({
                    kind: "review",
                    id: memory.id,
                    status: "verified",
                  })
                  setBusy(false)
                  if (!result.ok) {
                    toast.error(tErrors(result.reason))
                    return
                  }
                  onResolved?.(memory.id)
                  onOpenChange(false)
                }}
              >
                {t("clearStaleConflict")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ConflictSide({
  memory,
  keepLabel,
  disabled,
  onKeep,
}: {
  memory: Memory
  keepLabel: string
  disabled: boolean
  onKeep: () => void
}) {
  const tProv = useTranslations("memory.provenance")
  const format = useFormatter()
  const now = useNow()
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border/60 p-3",
        "bg-card/60 text-sm"
      )}
      data-testid={`conflict-side-${memory.id}`}
    >
      <p className="flex-1 break-words leading-snug">{memory.text}</p>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          {tProv(memory.provenance)}
        </Badge>
        <span>{format.relativeTime(new Date(memory.createdAt), now)}</span>
      </div>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={onKeep}>
        {keepLabel}
      </Button>
    </div>
  )
}
