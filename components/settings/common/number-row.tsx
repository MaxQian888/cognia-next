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

import { ClampedNumberInput } from "./clamped-number-input"
import { Label } from "@/components/ui/label"

export interface NumberRowProps {
  id: string
  label: string
  help?: string
  value: number
  min: number
  max: number
  onCommit: (v: number) => void
}

export function NumberRow({ id, label, help, value, min, max, onCommit }: NumberRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor={id} className="flex-1">
          {label}
        </Label>
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
