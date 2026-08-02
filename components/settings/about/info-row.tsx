"use client"

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface InfoRowProps {
  label: ReactNode
  value: ReactNode
  /** Render the value in a monospace, breakable style (paths, hashes). */
  mono?: boolean
  testid?: string
}

/**
 * A single label/value row used across the About cards — a spec-sheet line:
 * muted label, hairline divider, value right-aligned (and optionally
 * monospaced). Below `sm` the pair stacks so long paths and hashes never
 * squeeze the label; the last row in a group drops its divider.
 */
export function InfoRow({ label, value, mono, testid }: InfoRowProps) {
  return (
    <div
      className="flex flex-col gap-0.5 border-b border-border/50 py-2 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
      data-testid={testid}
    >
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 text-sm sm:text-right", mono && "font-mono text-xs break-all")}>
        {value}
      </span>
    </div>
  )
}
