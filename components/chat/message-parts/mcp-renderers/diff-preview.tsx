"use client"

// Minimal before/after diff block shared by the edit/multi_edit tool cards
// and the tool-approval dialog. Renders the removed lines (-, red) followed by
// the added lines (+, green) — adequate for the old_string/new_string payloads
// these tools carry. Same-index removed/added lines additionally get a
// word/char-level intraline highlight (via `fast-diff`) so the eye lands on
// the exact changed run instead of a whole-line wash.

import { memo, useMemo } from "react"
import { cn } from "@/lib/utils"
import { computeIntralineDiff, type IntralineSegment } from "@/lib/chat/intraline-diff"

export interface DiffPreviewProps {
  oldText: string
  newText: string
  className?: string
}

/** Render intraline segments with the changed runs emphasized, else plain text. */
function IntralineText({
  segments,
  fallback,
  emphasis,
}: {
  segments: IntralineSegment[] | null
  fallback: string
  emphasis: string
}) {
  if (!segments) return <>{fallback}</>
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "equal" ? (
          <span key={i}>{seg.value}</span>
        ) : (
          <span key={i} className={cn("rounded-sm", emphasis)} data-testid="diff-intraline">
            {seg.value}
          </span>
        )
      )}
    </>
  )
}

export const DiffPreview = memo(function DiffPreview({
  oldText,
  newText,
  className,
}: DiffPreviewProps) {
  // Splitting the full before/after payloads is the only real work this
  // component does; memoize so re-renders driven by sibling streaming updates
  // (this block is also mounted inside the edit-card `.map` and the
  // tool-approval dialog) don't re-split unchanged strings.
  const oldLines = useMemo(() => (oldText.length > 0 ? oldText.split("\n") : []), [oldText])
  const newLines = useMemo(() => (newText.length > 0 ? newText.split("\n") : []), [newText])
  // Intraline pass, paired by line index (best-effort — naive pairing degrades
  // to whole-line color when the line was inserted/deleted rather than edited).
  const intraline = useMemo(
    () =>
      oldLines.map((line, i) =>
        newLines[i] !== undefined ? computeIntralineDiff(line, newLines[i]) : null
      ),
    [oldLines, newLines]
  )
  return (
    <div
      className={cn(
        "max-h-60 overflow-auto rounded border bg-muted/30 font-mono text-[11px] leading-5",
        className
      )}
      data-testid="diff-preview"
    >
      {oldLines.map((line, i) => (
        <div
          key={`o-${i}`}
          data-testid="diff-removed"
          className="whitespace-pre-wrap break-all bg-red-500/10 px-2 text-red-700 dark:text-red-300"
        >
          <span className="select-none">- </span>
          <IntralineText
            segments={intraline[i]?.removed ?? null}
            fallback={line}
            emphasis="bg-red-500/30"
          />
        </div>
      ))}
      {newLines.map((line, i) => (
        <div
          key={`n-${i}`}
          data-testid="diff-added"
          className="whitespace-pre-wrap break-all bg-emerald-500/10 px-2 text-emerald-700 dark:text-emerald-300"
        >
          <span className="select-none">+ </span>
          <IntralineText
            segments={i < oldLines.length ? (intraline[i]?.added ?? null) : null}
            fallback={line}
            emphasis="bg-emerald-500/30"
          />
        </div>
      ))}
    </div>
  )
})
