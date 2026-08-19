"use client"

/**
 * Label ↔ slider row with the live value rendered as a readable badge.
 *
 * The logs panel has fourteen bounded numeric settings and the old markup
 * repeated the same eleven-line `div/Label/span/Slider` block for every one,
 * each with slightly different type sizes. A slider with no visible number is
 * unusable for values like "2000 ms", so the readout is part of the row rather
 * than something each caller remembers to add.
 */

import type { ReactNode } from "react"

import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"

export interface SliderFieldProps {
  id: string
  label: string
  description?: ReactNode
  /** Rendered readout — pass the formatted value, not the raw number. */
  valueLabel: string
  value: number
  min: number
  max: number
  step?: number
  /**
   * Hides the label/readout row visually (it stays in the a11y tree). For rows
   * that already show the name and value in their own header, e.g. a sampling
   * rule that carries a delete button beside them.
   */
  hideLabel?: boolean
  disabled?: boolean
  onValueChange: (value: number) => void
  className?: string
  testid?: string
}

export function SliderField({
  id,
  label,
  description,
  valueLabel,
  value,
  min,
  max,
  step = 1,
  hideLabel = false,
  disabled = false,
  onValueChange,
  className,
  testid,
}: SliderFieldProps) {
  return (
    <div
      className={cn(
        "space-y-2 border-b border-border/50 pb-4 last:border-b-0 last:pb-0",
        disabled && "opacity-50",
        className
      )}
      data-testid={testid}
    >
      <div className={cn("flex items-center justify-between gap-3", hideLabel && "sr-only")}>
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums">
          {valueLabel}
        </span>
      </div>
      <Slider
        id={id}
        aria-label={label}
        className="touch-none"
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([next]) => onValueChange(next)}
      />
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  )
}
