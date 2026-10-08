"use client"

// Before/after diff block shared by the edit/multi_edit tool cards and the
// tool-approval dialog. The two payloads are snippets (an `old_string` and its
// `new_string`), so this is a real line diff of them — `computeDiff`, drawn by
// the virtualized `LineDiffView` — rather than "every old line, then every new
// line": an edit that touched one line of a forty-line block shows that line
// changed among thirty-nine unchanged ones, with the changed characters
// emphasised. Snippet line numbers would only mislead, so the gutter keeps
// the signs alone.

import { memo, useMemo } from "react"
import { LineDiffView } from "@/components/diff/line-diff-view"
import { computeDiff } from "@/lib/artifacts/diff"
import type { DiffLine } from "@/types"
import { cn } from "@/lib/utils"

/** Tallest the preview grows before it scrolls (the old `max-h-60`). */
export const DIFF_PREVIEW_MAX_HEIGHT = 240

export interface DiffPreviewProps {
  oldText: string
  newText: string
  className?: string
}

export const DiffPreview = memo(function DiffPreview({
  oldText,
  newText,
  className,
}: DiffPreviewProps) {
  // Re-diffed only when a payload changes: this block is mounted inside the
  // edit-card list and the approval dialog, which re-render on every streaming
  // update of their siblings.
  const lines = useMemo<DiffLine[]>(
    () => computeDiff(oldText, newText).map(({ type, content }) => ({ type, content })),
    [oldText, newText]
  )
  if (lines.length === 0) return null
  return (
    <div
      className={cn("overflow-hidden rounded border bg-muted/30 text-[11px]", className)}
      data-testid="diff-preview"
    >
      <LineDiffView
        lines={lines}
        context={null}
        wrap
        maxHeight={DIFF_PREVIEW_MAX_HEIGHT}
        data-testid="diff-preview-lines"
      />
    </div>
  )
})
