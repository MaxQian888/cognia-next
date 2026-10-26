"use client"

/**
 * A slot's revision history (ADR-0236 §4 "History", §7 "Reset/restore").
 * Revisions are immutable: restoring one publishes its text again as a new
 * revision (a reset revision restores inheritance), so history only grows and
 * the restore itself can be undone the same way.
 */

import { useMemo, useState } from "react"
import { useFormatter } from "next-intl"
import { HistoryIcon, RotateCcwIcon } from "lucide-react"
import { LineDiffView } from "@/components/diff/line-diff-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { computeDiff } from "@/lib/artifacts/diff"
import type { PromptOverrideRevisionRow } from "@/lib/db/prompt-overrides"
import { cn } from "@/lib/utils"
import { usePromptLabels } from "./use-prompt-labels"

export interface PromptHistoryProps {
  revisions: readonly PromptOverrideRevisionRow[]
  activeRevisionId: string | null
  draftRevisionId: string | null
  /** What the editor holds now; each revision is compared against it. */
  currentText: string
  /** The text a reset revision stands for (inherited or shipped). */
  inheritedText: string
  busy?: boolean
  onRestore(revision: PromptOverrideRevisionRow): void
  onLoadDraft(revision: PromptOverrideRevisionRow): void
}

export function PromptHistory({
  revisions,
  activeRevisionId,
  draftRevisionId,
  currentText,
  inheritedText,
  busy = false,
  onRestore,
  onLoadDraft,
}: PromptHistoryProps) {
  const { t } = usePromptLabels()
  const format = useFormatter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = revisions.find((revision) => revision.id === selectedId) ?? revisions[0]
  const selectedText = selected?.kind === "reset" ? inheritedText : (selected?.body ?? "")
  const diff = useMemo(() => computeDiff(selectedText, currentText), [selectedText, currentText])

  if (revisions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center text-xs text-muted-foreground">
        <HistoryIcon className="size-6 opacity-50" />
        {t("history.empty")}
      </div>
    )
  }

  return (
    <div className="grid gap-3 @[720px]/settings-pane:grid-cols-[220px_minmax(0,1fr)]">
      <ol className="space-y-1" aria-label={t("history.title")}>
        {revisions.map((revision) => (
          <li key={revision.id}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSelectedId(revision.id)}
              aria-current={selected?.id === revision.id}
              className={cn(
                "flex h-auto w-full flex-col items-start gap-0.5 whitespace-normal rounded-md px-2 py-1.5 text-left",
                selected?.id === revision.id && "bg-accent"
              )}
            >
              <span className="flex flex-wrap items-center gap-1 text-xs font-medium">
                {t(`history.kind.${revision.kind}`)}
                {revision.id === activeRevisionId ? (
                  <Badge className="h-4 px-1 text-[9px]">{t("history.active")}</Badge>
                ) : null}
                {revision.id === draftRevisionId ? (
                  <Badge variant="outline" className="h-4 px-1 text-[9px]">
                    {t("history.currentDraft")}
                  </Badge>
                ) : null}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {format.dateTime(revision.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                {" · "}
                {t(`history.origin.${revision.origin}`)}
              </span>
            </Button>
          </li>
        ))}
      </ol>
      {selected ? (
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">{t("history.compareHint")}</p>
            {selected.kind === "draft" ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => onLoadDraft(selected)}
              >
                {t("history.loadDraft")}
              </Button>
            ) : selected.id === activeRevisionId ? null : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                disabled={busy}
                onClick={() => onRestore(selected)}
              >
                <RotateCcwIcon className="size-3.5" />
                {selected.kind === "reset" ? t("history.restoreInheritance") : t("history.restore")}
              </Button>
            )}
          </div>
          <LineDiffView lines={diff} wrap maxHeight={420} aria-label={t("history.diffLabel")} />
        </div>
      ) : null}
    </div>
  )
}
