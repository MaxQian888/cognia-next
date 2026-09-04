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
import { Progress } from "@/components/ui/progress"
import { useDeferredLoading } from "@/hooks/ui/use-deferred-loading"
import { useLoadingI18n } from "@/hooks/ui/use-loading-i18n"
import { useLoadingPhase } from "@/hooks/ui/use-loading-phase"
import { cn } from "@/lib/utils"

/**
 * Determinate progress for a loading region.
 *
 * Pass this ONLY when the count is real. A determinate 0% bar is a claim; a
 * spinner is the truth. `total <= 0` is treated as "unknown" and falls back to
 * the indeterminate path rather than rendering an invented zero.
 */
export interface LoadingRegionProgress {
  processed: number
  total: number
  /** Localized phase text, folded into the single status message. */
  phaseLabel?: string
}

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
  /**
   * Determinate progress, when the operation genuinely reports one. Folded into
   * the region's single status message and rendered as a bar beside it — never
   * as a second announcement.
   */
  progress?: LoadingRegionProgress | null
  /**
   * Show the visible detail line ("Starting the plugin - 4/7", "Still
   * working... (23s)"). Defaults to true.
   *
   * Pass false where the region is a hairline inside something else, such as a
   * one-line list row: a text line there is taller than the row it describes,
   * so it either pushes the row's content around or overlaps it. The polite
   * live region still announces the same detail, so turning the line off costs
   * nothing to a screen reader.
   */
  showDetail?: boolean
  children?: ReactNode
  className?: string
}

export function LoadingRegion({
  loading,
  loadingKey,
  label,
  fallback,
  onCancel,
  progress,
  showDetail = true,
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
      {showIndicator ? (
        <LoadingRegionStatus
          label={label}
          onCancel={onCancel}
          progress={progress}
          showDetail={showDetail}
        />
      ) : null}
      {showIndicator ? fallback : children}
    </div>
  )
}

interface LoadingRegionStatusProps {
  label?: string
  onCancel?: () => void
  progress?: LoadingRegionProgress | null
  showDetail?: boolean
}

/**
 * The region's single live message, plus the escalation row.
 *
 * Mounted only while the indicator is visible so its timers start with the
 * wait. `role="status"` + `aria-live="polite"` means the text change at the
 * prolonged threshold re-announces once — which is the whole point of
 * escalating — without interrupting whatever the user is doing.
 */
function LoadingRegionStatus({
  label,
  onCancel,
  progress,
  showDetail = true,
}: LoadingRegionStatusProps) {
  const t = useLoadingI18n()
  const { phase, elapsedMs, offline } = useLoadingPhase({ canEscalate: Boolean(onCancel) })

  const base = label ?? t.loading
  const prolonged = phase === "prolonged" || phase === "escalated"

  // A caller that cannot supply a real total gets the indeterminate path. The
  // lesson from the local-provider model pull: inventing a 0% is a claim the
  // data does not support.
  const determinate = Boolean(progress && progress.total > 0)
  const percent = determinate
    ? Math.min(100, Math.max(0, Math.round((progress!.processed / progress!.total) * 100)))
    : 0

  // Offline still wins — it is the more actionable thing to say. Otherwise a
  // determinate region REPLACES the elapsed-seconds detail with the phase and
  // count: "Still working… (23s)" alongside a 4/7 bar is two voices saying the
  // same thing, less precisely.
  const progressDetail = determinate
    ? [progress!.phaseLabel, `${progress!.processed}/${progress!.total}`]
        .filter(Boolean)
        .join(" — ")
    : null
  const detail = offline
    ? t.offline
    : (progressDetail ?? t.stillWorking(Math.round(elapsedMs / 1000)))

  // Determinate regions speak on every phase boundary (at most 7 times); the
  // indeterminate ones only once the wait becomes prolonged.
  const announceDetail = determinate || prolonged
  // The announcement is unconditional. Only the visible line is suppressed,
  // and never when there is a cancel button to reach inside it.
  const showDetailRow = (prolonged || determinate) && (showDetail || Boolean(onCancel))

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {announceDetail ? `${base} — ${detail}` : base}
      </span>
      {determinate ? (
        // A SIBLING of the status element, never a descendant: Radix gives this
        // an implicit role="progressbar", and inside a live region every value
        // change would be announced on top of the polite message above.
        <Progress
          value={percent}
          aria-label={base}
          aria-valuetext={detail}
          className="h-1 w-full"
        />
      ) : null}
      {showDetailRow ? (
        <div
          className={cn(
            "flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
          )}
        >
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
