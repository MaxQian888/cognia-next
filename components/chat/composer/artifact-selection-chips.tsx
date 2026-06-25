"use client"

// Context chips for artifact snippets the user selected + commented on. Sits in
// the ContextChipBar alongside @-references and attachments. Clicking the X
// drops the selection from the chat store; sending consumes them (and records
// the edit target so the AI reply routes into a review proposal).

import { useTranslations } from "next-intl"
import { FileDiff, XIcon } from "lucide-react"
import { useChatStore } from "@/stores/chat"
import { Button } from "@/components/ui/button"

export interface ArtifactSelectionChipsProps {
  /** Render bare (no padded container) for composition inside ContextChipBar. */
  bare?: boolean
}

export function ArtifactSelectionChips({ bare = false }: ArtifactSelectionChipsProps = {}) {
  const t = useTranslations("artifacts.review")
  const selections = useChatStore((s) => s.artifactSelections)
  const remove = useChatStore((s) => s.removeArtifactSelection)

  if (selections.length === 0) return null

  const chips = (
    <>
      {selections.map((sel, index) => {
        const label = t("selectionChipLabel", {
          title: sel.title,
          start: sel.range.startLine,
          end: sel.range.endLine,
        })
        return (
          <div
            key={`${sel.artifactId}:${index}`}
            data-testid="artifact-selection-chip"
            className="group flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
            title={sel.comment || label}
          >
            <FileDiff className="size-3.5 text-muted-foreground" />
            <span className="max-w-[min(280px,calc(100vw-6rem))] truncate">{label}</span>
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
