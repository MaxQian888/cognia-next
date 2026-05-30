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
 * A single label/value row used across the About cards. Label sits left in
 * muted text; value is right-aligned and may be monospaced.
 */
export function InfoRow({ label, value, mono, testid }: InfoRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5" data-testid={testid}>
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-right text-sm", mono && "break-all font-mono text-[12px]")}>
        {value}
      </span>
    </div>
  )
}
