"use client"

// One row of: label + color swatch picker + hex text input. Used by both
// the new UI custom-theme tab and the (future) HTML export editor refactor.
// Pure presentational — owns no state. Caller passes `value` and gets
// `onChange` callbacks; the caller decides whether to debounce, validate,
// etc.

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { isHexColor } from "@/lib/appearance/vscode-theme/color-utils"

export interface ColorTokenRowProps {
  /** Stable key — used for `htmlFor` and as a fallback display label. */
  tokenKey: string
  /** Display label (often a localised string). Falls back to `tokenKey`. */
  label?: string
  value: string
  onChange: (next: string) => void
  /** Optional helper text rendered below the row. */
  hint?: string
  /** Disable both inputs. */
  disabled?: boolean
  className?: string
}

export function ColorTokenRow({
  tokenKey,
  label,
  value,
  onChange,
  hint,
  disabled,
  className,
}: ColorTokenRowProps) {
  const hexValid = isHexColor(value)
  // The native `<input type="color">` only accepts 6-digit hex; if the
  // current value isn't valid we fall back to a neutral gray so the
  // picker stays interactive.
  const swatchValue = hexValid ? value : "#888888"
  return (
    <div className={cn("flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3", className)}>
      <Label
        htmlFor={`color-token-${tokenKey}`}
        className="text-[11px] uppercase tracking-wide sm:w-32"
      >
        {label ?? tokenKey}
      </Label>
      <div className="flex flex-1 items-center gap-2">
        <input
          id={`color-token-${tokenKey}`}
          type="color"
          value={swatchValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={cn(
            "h-8 w-10 shrink-0 cursor-pointer rounded border border-border bg-transparent",
            disabled && "opacity-50"
          )}
          aria-label={`${label ?? tokenKey} swatch`}
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={cn(
            "h-8 flex-1 font-mono text-[11px] sm:max-w-32",
            !hexValid && "border-destructive text-destructive"
          )}
          aria-label={`${label ?? tokenKey} hex`}
          aria-invalid={!hexValid}
        />
      </div>
      {hint && <p className="text-[11px] text-muted-foreground sm:ml-32">{hint}</p>}
    </div>
  )
}
