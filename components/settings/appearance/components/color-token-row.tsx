"use client"

// One row of: label + color swatch picker + free-text color field. Used by the
// custom-theme tab's `TokenGroup` clusters. Pure presentational — owns no
// state. Caller passes `value` and gets `onChange` callbacks; the caller
// decides whether to debounce, validate, etc.
//
// The field accepts any colour CSS understands, not just `#rrggbb`. It used to
// be hex-only, which was survivable while the editor seeded drafts from a hex
// fallback palette and untenable the moment the real token defaults — every one
// of them an `oklch()`, two of them carrying alpha — became visible here: every
// row would have opened flagged `aria-invalid` with a red border. So parsing is
// culori's, the text field round-trips the author's exact notation, and the
// native picker (which speaks nothing but 6-digit hex) shows the nearest
// approximation of it.

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { isColorParsable, toHexApprox } from "@/lib/appearance/contrast"

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
  /** Pre-translated aria-label for the color swatch input. Falls back to "<label> swatch" if omitted. */
  swatchAriaLabel?: string
  /** Pre-translated aria-label for the text input. Falls back to "<label> hex" if omitted. */
  hexAriaLabel?: string
}

export function ColorTokenRow({
  tokenKey,
  label,
  value,
  onChange,
  hint,
  disabled,
  className,
  swatchAriaLabel,
  hexAriaLabel,
}: ColorTokenRowProps) {
  const valid = isColorParsable(value)
  // `color-mix()` and other computed notations are legitimate CSS that culori
  // cannot resolve; they stay editable but the picker has nothing to show, so
  // it falls back to a neutral grey rather than lying about the colour.
  const swatchValue = (valid ? toHexApprox(value) : null) ?? "#888888"
  return (
    <div
      className={cn(
        "flex flex-col gap-1 @sm/appearance-pane:flex-row @sm/appearance-pane:items-center @sm/appearance-pane:gap-3",
        className
      )}
    >
      <Label
        htmlFor={`color-token-${tokenKey}`}
        className="text-[11px] uppercase tracking-wide @sm/appearance-pane:w-32"
      >
        {label ?? tokenKey}
      </Label>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Input
          id={`color-token-${tokenKey}`}
          type="color"
          value={swatchValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={cn(
            "h-8 w-10 shrink-0 cursor-pointer rounded border border-border bg-transparent",
            disabled && "opacity-50"
          )}
          aria-label={swatchAriaLabel ?? `${label ?? tokenKey} swatch`}
          data-testid={`color-token-${tokenKey}-swatch`}
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={cn(
            "h-8 min-w-0 flex-1 font-mono text-[11px] @sm/appearance-pane:max-w-40",
            !valid && "border-destructive text-destructive"
          )}
          aria-label={hexAriaLabel ?? `${label ?? tokenKey} hex`}
          aria-invalid={!valid}
          data-testid={`color-token-${tokenKey}-hex`}
        />
      </div>
      {hint && (
        <p className="text-[11px] text-muted-foreground @sm/appearance-pane:ml-32">{hint}</p>
      )}
    </div>
  )
}
