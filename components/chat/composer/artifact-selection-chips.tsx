"use client"

// Context chips for artifact snippets the user selected + commented on. Sits in
// the ContextChipBar alongside @-references and attachments. Clicking the X
// drops the selection from the chat store; sending consumes them (and records
// the edit target so the AI reply routes into a review proposal).
//
// Only the FIRST chip becomes that edit target — the rest contribute context
// alone (`composer.tsx`). That was invisible: every chip looked identical and
// the drop was recorded in a `debug` log, so referencing two artifacts silently
// meant one of them could never receive a revision proposal. The lead chip now
// says so, and clicking any other chip promotes it.

import { useTranslations } from "next-intl"
import { FileDiff, XIcon } from "lucide-react"
import { useChatStore } from "@/stores/chat"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface ArtifactSelectionChipsProps {
  /** Render bare (no padded container) for composition inside ContextChipBar. */
  bare?: boolean
}

export function ArtifactSelectionChips({ bare = false }: ArtifactSelectionChipsProps = {}) {
  const t = useTranslations("artifacts.review")
  const selections = useChatStore((s) => s.artifactSelections)
  const remove = useChatStore((s) => s.removeArtifactSelection)
  const promote = useChatStore((s) => s.promoteArtifactSelection)

  if (selections.length === 0) return null

  // With one chip there is nothing to choose between, so the badge would be
  // noise — the single reference is obviously the target.
  const showEditTarget = selections.length > 1

  const chips = (
    <>
      {selections.map((sel, index) => {
        // A whole-artifact reference (the dock tab's "reference in chat") is
        // staged as lines 1..N of the snapshot, which rendered as a line range
        // and read like a hand-picked excerpt. Derived from the snapshot rather
        // than a flag, so a selection that happens to cover everything reads the
        // same way — which is what it is.
        const wholeArtifact =
          sel.range.startLine === 1 && sel.range.endLine >= sel.snapshot.split("\n").length
        const label = wholeArtifact
          ? t("selectionChipWholeLabel", { title: sel.title })
          : t("selectionChipLabel", {
              title: sel.title,
              start: sel.range.startLine,
              end: sel.range.endLine,
            })
        const isTarget = index === 0
        return (
          <div
            key={`${sel.artifactId}:${index}`}
            data-testid="artifact-selection-chip"
            data-edit-target={showEditTarget && isTarget ? "true" : undefined}
            className={cn(
              "group flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs",
              showEditTarget && isTarget && "border-primary/50"
            )}
            title={sel.comment || label}
          >
            <FileDiff className="size-3.5 text-muted-foreground" />
            {showEditTarget && !isTarget ? (
              <button
                type="button"
                data-testid="artifact-selection-promote"
                aria-label={t("promoteSelectionAria", { title: sel.title })}
                onClick={() => promote(index)}
                className="max-w-[min(280px,calc(100vw-6rem))] truncate hover:underline"
              >
                {label}
              </button>
            ) : (
              <span className="max-w-[min(280px,calc(100vw-6rem))] truncate">{label}</span>
            )}
            {showEditTarget && isTarget ? (
              <Badge
                variant="secondary"
                className="shrink-0 px-1 text-[9px]"
                title={t("editTargetHint")}
              >
                {t("editTargetBadge")}
              </Badge>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("removeSelectionAria", { title: sel.title })}
              onClick={() => remove(index)}
              className="size-5 opacity-60 transition-opacity hover:opacity-100"
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        )
      })}
    </>
  )

  if (bare) return chips
  return <div className="flex flex-wrap gap-1.5 px-2 pt-2">{chips}</div>
}
