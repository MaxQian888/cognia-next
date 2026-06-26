"use client"

// Minimal before/after diff block shared by the edit/multi_edit tool cards
// and the tool-approval dialog. Dependency-free: renders the removed lines
// (-, red) followed by the added lines (+, green) — adequate for the
// old_string/new_string payloads these tools carry, without pulling a diff
// library into the renderer bundle.

import { memo, useMemo } from "react"
import { cn } from "@/lib/utils"

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
  // Splitting the full before/after payloads is the only real work this
  // component does; memoize so re-renders driven by sibling streaming updates
  // (this block is also mounted inside the edit-card `.map` and the
  // tool-approval dialog) don't re-split unchanged strings.
  const oldLines = useMemo(() => (oldText.length > 0 ? oldText.split("\n") : []), [oldText])
  const newLines = useMemo(() => (newText.length > 0 ? newText.split("\n") : []), [newText])
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
          {line}
        </div>
      ))}
      {newLines.map((line, i) => (
        <div
          key={`n-${i}`}
          data-testid="diff-added"
          className="whitespace-pre-wrap break-all bg-emerald-500/10 px-2 text-emerald-700 dark:text-emerald-300"
        >
          <span className="select-none">+ </span>
          {line}
        </div>
      ))}
    </div>
  )
})
