import { Loader2Icon } from "lucide-react"

import { cn } from "@/lib/utils"

export interface SpinnerProps extends Omit<React.ComponentProps<"svg">, "aria-label"> {
  /**
   * Accessible name. Supply it ONLY when the spinner is the sole indication
   * that something is happening — a standalone glyph with no surrounding text
   * and no `LoadingRegion` around it.
   *
   * Leave it unset inside a button, beside a visible label, or within a
   * `LoadingRegion`: the enclosing control or region already carries the
   * announcement, and a second live region layered on top only makes a screen
   * reader say it twice on every mount.
   *
   * Must be localized by the caller — this file is shared UI with no
   * translation context of its own.
   */
  label?: string
}

/**
 * The house loading glyph.
 *
 * Decorative by default. It previously hard-coded `role="status"` plus an
 * English `aria-label="Loading"`, so every call site — most of them buttons
 * that already announce their own state — fired a redundant live-region update,
 * untranslated. Announcing is now opt-in via `label`.
 *
 * `animate-spin` is exempt from the reduce-motion guard (see `globals.css`), so
 * this keeps spinning when motion is reduced. That is deliberate: it is status,
 * not decoration, and a frozen spinner tells the user nothing.
 */
function Spinner({ label, className, ...props }: SpinnerProps) {
  return (
    <Loader2Icon
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
