"use client"

/**
 * Label + bounded number input + optional help text, as a settings row.
 *
 * Lives here rather than under `gateway/shared/` because it is not a gateway
 * component: the External Bridge's server panel renders it too, and reaching
 * across into another section's private folder for it was the giveaway.
 *
 * The draft/clamp/commit behaviour is entirely {@link ClampedNumberInput}'s —
 * this is layout. It used to carry its own copy, which had drifted in two ways
 * that mattered: an emptied field snapped to a `fallback` (the shared input
 * argues, correctly, that blanking a field is not a request to jump to the
 * minimum, and reverts to what is stored), and Escape did not abandon the edit.
 * `commitWhileTyping` is off here because each of these fields costs a Tauri
 * IPC plus a disk write.
 */

import type { ReactNode } from "react"

import { ClampedNumberInput } from "./clamped-number-input"
import { Label } from "@/components/ui/label"

export interface NumberRowProps {
  id: string
  label: string
  help?: string
  /**
   * Rendered beside the label but outside the `<label>`, so a status badge
   * (e.g. "needs restart") never becomes part of the input's accessible name.
   */
  adornment?: ReactNode
  value: number
  min: number
  max: number
  onCommit: (v: number) => void
}

export function NumberRow({
  id,
  label,
  help,
  adornment,
  value,
  min,
  max,
  onCommit,
}: NumberRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <Label htmlFor={id}>{label}</Label>
          {adornment}
        </div>
        <ClampedNumberInput
          id={id}
          className="w-28"
          value={value}
          min={min}
          max={max}
          integer
          commitWhileTyping={false}
          onCommit={onCommit}
        />
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}
