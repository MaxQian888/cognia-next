"use client"

/**
 * Shared coloured-label pill.
 *
 * Generalised from `components/inbox/label-chip.tsx` so the issue board and the
 * connector inbox render labels identically instead of drifting into two
 * lookalike components. Purely presentational — it takes a row and an optional
 * remove handler and owns no data access, so either surface can bind its own
 * store.
 *
 * The `label-chip-<id>` test id is a stability contract inherited from the
 * inbox version; existing inbox tests query by it.
 */

import { XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { LabelRow } from "@/types/labels"
import { defaultLabelColor } from "@/types/labels"
import { cn } from "@/lib/utils"

export interface LabelChipProps {
  label: Pick<LabelRow, "id" | "name" | "color">
  /** Renders a remove affordance when provided. */
  onRemove?: () => void
  /** Accessible label for the remove button — the caller localizes it. */
  removeLabel?: string
  className?: string
}

export function LabelChip({ label, onRemove, removeLabel, className }: LabelChipProps) {
  const color = label.color ?? defaultLabelColor(label.name)

  return (
    <Badge
      variant="secondary"
      className={cn("max-w-[12rem] gap-1.5 pr-1.5 font-normal", className)}
      data-testid={`label-chip-${label.id}`}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="truncate">{label.name}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? `Remove ${label.name}`}
          className="rounded-sm opacity-60 transition-opacity hover:opacity-100 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]"
          data-testid={`label-chip-remove-${label.id}`}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </Badge>
  )
}
