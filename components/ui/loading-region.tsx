"use client"

/**
 * `LoadingRegion` — one loading area, one announcement.
 *
 * Before this existed the repo had the failure at both ends: `Skeleton` was
 * silent (a dozen of them said nothing at all), while `Spinner` announced
 * unconditionally, so a button already labelled "Save" fired a second, English
 * live-region update every time it mounted. The fix is to move the
 * announcement up: the graphics are decorative, the *region* carries
 * `aria-busy` and a single polite status message.
 *
 * It also composes the anti-flicker gate and the escalation ladder, so a call
 * site gets all three behaviours by wrapping its area instead of wiring three
 * hooks. Both hooks remain exported for surfaces that need finer control.
 *
 * The status element is mounted only while the indicator is up. That is what
 * lets `useLoadingPhase` treat mount as its activation signal instead of taking
 * an `active` flag, which would need a synchronous set-state inside an effect.
 */

import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { useDeferredLoading } from "@/hooks/ui/use-deferred-loading"
import { useLoadingI18n } from "@/hooks/ui/use-loading-i18n"
import { useLoadingPhase } from "@/hooks/ui/use-loading-phase"
import { cn } from "@/lib/utils"

export interface LoadingRegionProps {
  /** True while the region's content is still being fetched. */
  loading: boolean
  /**
   * Identity of what is loading (session id, plugin id, route param). Changing
   * it resets the anti-flicker timers so a fast switch cannot inherit the
   * previous target's minimum-display debt.
   */
  loadingKey?: string | number | null
  /**
   * Localized description of what is loading — "Loading sessions", not
   * "Loading". Falls back to the generic label.
   */
  label?: string
  /** Rendered in place of `children` once the wait is worth showing. */
  fallback: ReactNode
  /**
   * Offered once the wait reaches the escalation threshold. Pass it ONLY when
   * cancelling genuinely stops the work — hiding the UI while the operation
   * keeps running is worse than offering nothing.
   */
  onCancel?: () => void
  children?: ReactNode
  className?: string
}

export function LoadingRegion({
  loading,
  loadingKey,
  label,
  fallback,
  onCancel,
  children,
  className,
}: LoadingRegionProps) {
  const showIndicator = useDeferredLoading(loading, { key: loadingKey })

  return (
    <div
      data-slot="loading-region"
      // Only while actually loading — not while the indicator lingers for its
      // minimum display, by which point the data is already in hand.
      aria-busy={loading || undefined}
      className={className}
    >
      {showIndicator ? <LoadingRegionStatus label={label} onCancel={onCancel} /> : null}
      {showIndicator ? fallback : children}
    </div>
  )
}

interface LoadingRegionStatusProps {
  label?: string
  onCancel?: () => void
}

/**
 * The region's single live message, plus the escalation row.
 *
 * Mounted only while the indicator is visible so its timers start with the
 * wait. `role="status"` + `aria-live="polite"` means the text change at the
 * prolonged threshold re-announces once — which is the whole point of
 * escalating — without interrupting whatever the user is doing.
 */
function LoadingRegionStatus({ label, onCancel }: LoadingRegionStatusProps) {
  const t = useLoadingI18n()
  const { phase, elapsedMs, offline } = useLoadingPhase({ canEscalate: Boolean(onCancel) })

  const base = label ?? t.loading
  const prolonged = phase === "prolonged" || phase === "escalated"
  const detail = offline ? t.offline : t.stillWorking(Math.round(elapsedMs / 1000))

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {prolonged ? `${base} — ${detail}` : base}
      </span>
      {prolonged ? (
        <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
          {/* aria-hidden: the live region above already said this. */}
          <span aria-hidden="true">{detail}</span>
          {phase === "escalated" && onCancel ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>
              {t.cancel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
