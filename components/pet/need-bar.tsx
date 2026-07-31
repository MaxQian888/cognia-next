// A single pet "need" meter (energy / mood / bond): a labelled progress bar that
// turns amber then destructive as the value drops. Shared by the compact
// interaction panel (widget/popup) and the wide `/pet` nurture layout so both
// render needs identically.

"use client"

import { cn } from "@/lib/utils"
import type { PetNeedKind } from "@/types/pet"

export interface NeedBarProps {
  kind: PetNeedKind
  value: number
  label: string
  className?: string
}

export function NeedBar({ kind, value, label, className }: NeedBarProps) {
  return (
    <div
      data-need={kind}
      className={cn("grid grid-cols-[4rem_1fr_2.5rem] items-center gap-2", className)}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            value < 25 ? "bg-destructive" : value < 50 ? "bg-amber-400" : "bg-primary"
          )}
          style={{ width: `${Math.round(value)}%` }}
        />
      </div>
      <span className="text-right text-xs tabular-nums">{Math.round(value)}</span>
    </div>
  )
}
