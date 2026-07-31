"use client"

import type { ReactNode } from "react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  description?: string
  icon?: ReactNode
}

interface SegmentedControlProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: SegmentedOption<T>[]
  /**
   * `inline` — horizontal pills, label only (compact selectors like search type).
   * `cards` — responsive grid where each item stacks an optional icon, label and
   * description (richer choices like search depth, safety level, verify mode).
   */
  variant?: "inline" | "cards"
  disabled?: boolean
  className?: string
  "aria-label"?: string
}

/**
 * SegmentedControl — the single selected-state control for the search settings.
 * Wraps the shared `ToggleGroup` (radio semantics via `type="single"`) so every
 * choice group shares one visual selected state instead of the three bespoke
 * button styles the section used to hand-roll.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  variant = "inline",
  disabled,
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  // Radix single toggle-groups emit "" when the active item is re-clicked.
  // Ignore that so the control always keeps a value (true radio behaviour).
  const handleChange = (next: string) => {
    if (!next) return
    onValueChange(next as T)
  }

  if (variant === "cards") {
    return (
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={handleChange}
        disabled={disabled}
        variant="outline"
        spacing={2}
        aria-label={ariaLabel}
        className={cn("grid w-full grid-cols-2 gap-2 sm:grid-cols-3", className)}
      >
        {options.map((opt) => (
          <ToggleGroupItem
            key={opt.value}
            value={opt.value}
            variant="outline"
            aria-label={opt.label}
            className={cn(
              "flex h-auto min-h-16 w-auto flex-col items-center justify-center gap-1 whitespace-normal rounded-lg px-3 py-2.5 text-center",
              "data-[state=on]:border-primary data-[state=on]:bg-primary/5 data-[state=on]:text-primary"
            )}
          >
            {opt.icon}
            <span className="text-xs font-medium">{opt.label}</span>
            {opt.description && (
              <span className="text-[10px] font-normal text-muted-foreground">
                {opt.description}
              </span>
            )}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    )
  }

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={handleChange}
      disabled={disabled}
      variant="outline"
      spacing={2}
      aria-label={ariaLabel}
      className={cn("flex flex-wrap", className)}
    >
      {options.map((opt) => (
        <ToggleGroupItem
          key={opt.value}
          value={opt.value}
          variant="outline"
          className={cn(
            "gap-1.5 rounded-md text-xs font-medium",
            "data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
          )}
        >
          {opt.icon}
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
