// A single pet "need" meter (energy / mood / bond): a labelled progress bar that
// turns amber then destructive as the value drops. Shared by the compact
// interaction panel (widget/popup) and the wide `/pet` nurture layout so both
// render needs identically.

"use client"

import { cn } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"
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
      <Progress
        value={Math.round(value)}
        aria-label={label}
        className={cn(
          value < 25
            ? "[&>[data-slot=progress-indicator]]:bg-destructive"
            : value < 50
              ? "[&>[data-slot=progress-indicator]]:bg-muted-foreground"
              : undefined
        )}
      />
      <span className="text-right text-xs tabular-nums">{Math.round(value)}</span>
    </div>
  )
}
