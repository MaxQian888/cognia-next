"use client"

// Minimal before/after diff block shared by the edit/multi_edit tool cards
// and the tool-approval dialog. Dependency-free: renders the removed lines
// (-, red) followed by the added lines (+, green) — adequate for the
// old_string/new_string payloads these tools carry, without pulling a diff
// library into the renderer bundle.

import { cn } from "@/lib/utils"

export interface DiffPreviewProps {
  oldText: string
  newText: string
  className?: string
}

export function DiffPreview({ oldText, newText, className }: DiffPreviewProps) {
  const oldLines = oldText.length > 0 ? oldText.split("\n") : []
  const newLines = newText.length > 0 ? newText.split("\n") : []
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
}
