"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangleIcon, MaximizeIcon, PinIcon, PinOffIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SreTimeRange } from "../evidence"
import type { SreHistogramBucket, SreLogPattern } from "../providers/types"
import type { SreRuntime } from "../runtime"
import type { SreIncident } from "../incident/model"
import { usePluginT } from "../use-plugin-t"

/** Bars the strip draws. Two densities, because a 360px column cannot hold 32. */
const BUCKETS_NARROW = 16
const BUCKETS_WIDE = 32
/** Templates listed inline. The rest are one widen away, not hidden forever. */
const PATTERN_LIMIT_NARROW = 3
const PATTERN_LIMIT_WIDE = 8

/**
 * One settled query, stamped with the request it answers.
 *
 * Keyed rather than reset-to-loading inside the effect: writing "loading"
 * synchronously in an effect body is a cascading render (and the repo's lint
 * rejects it), so the loading state is DERIVED from "the settled result does
 * not answer the request we are on".
 */
type LensResult =
  | { key: string; ok: true; buckets: SreHistogramBucket[]; patterns: SreLogPattern[] }
  | { key: string; ok: false; message: string }

type LensState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; buckets: SreHistogramBucket[]; patterns: SreLogPattern[] }

/** The window immediately before this one, same length — the delta's denominator. */
export function baselineWindow(window: SreTimeRange): SreTimeRange {
  const start = Date.parse(window.startTime)
  const end = Date.parse(window.endTime)
  const span = Math.max(1, end - start)
  return {
    startTime: new Date(start - span).toISOString(),
    endTime: new Date(start).toISOString(),
  }
}

/** Does the backend hold anything for this window at all? */
export function coversWindow(coverage: SreTimeRange | null, window: SreTimeRange): boolean {
  if (!coverage) return true
  return (
    Date.parse(coverage.startTime) <= Date.parse(window.endTime) &&
    Date.parse(coverage.endTime) >= Date.parse(window.startTime)
  )
}

function formatDelta(pattern: SreLogPattern, t: (key: string) => string): string {
  if (pattern.baselineCount === null) return t("lens.noBaseline")
  if (pattern.baselineCount === 0) return t("lens.new")
  const percent = Math.round((pattern.changeRatio ?? 0) * 100)
  return `${percent > 0 ? "+" : ""}${percent}%`
}

/**
 * The log-analysis surface, sized to fit inside an incident.
 *
 * A histogram plus the templates that moved is the smallest thing that answers
 * "what actually happened in this window" without handing the reader 14k lines.
 * It is not the whole workbench — widening the panel is the escape hatch, and
 * the button says so rather than implying a separate page exists.
 */
export function LogLens({
  incident,
  runtime,
  wide,
  enabled,
  pinnedIds,
  onPin,
  onRequestWide,
}: {
  incident: SreIncident
  runtime: SreRuntime
  wide: boolean
  /**
   * False while another panel is in front. A workbench panel stays MOUNTED when
   * it loses the surface, so without this the lens would keep re-querying the
   * backend for a view nobody is looking at.
   */
  enabled: boolean
  pinnedIds: readonly string[]
  onPin: (evidenceIds: string[]) => void
  onRequestWide?: () => void
}) {
  const t = usePluginT()
  const [result, setResult] = useState<LensResult | null>(null)

  const coverage = useMemo(() => runtime.provider().coverage, [runtime])
  const inCoverage = coversWindow(coverage, incident.window)
  const filter = useMemo(
    () => ({ environment: incident.environment, ...incident.window }),
    [incident.environment, incident.window]
  )
  const bucketCount = wide ? BUCKETS_WIDE : BUCKETS_NARROW
  const requestKey = `${filter.environment}|${filter.startTime}|${filter.endTime}|${bucketCount}`

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    Promise.all([
      runtime.histogram(filter, bucketCount),
      runtime.patterns(filter, baselineWindow(filter)),
    ])
      .then(([buckets, patterns]) => {
        if (!cancelled) setResult({ key: requestKey, ok: true, buckets, patterns })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setResult({
          key: requestKey,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        })
      })
    return () => {
      cancelled = true
    }
  }, [runtime, filter, bucketCount, requestKey, enabled])

  const state: LensState = useMemo(() => {
    if (!enabled) return { status: "idle" }
    if (!result || result.key !== requestKey) return { status: "loading" }
    return result.ok
      ? { status: "ready", buckets: result.buckets, patterns: result.patterns }
      : { status: "error", message: result.message }
  }, [enabled, result, requestKey])

  const pinned = useMemo(() => new Set(pinnedIds), [pinnedIds])
  const pinGroup = useCallback((pattern: SreLogPattern) => onPin(pattern.evidenceIds), [onPin])

  const totals = useMemo(() => {
    if (state.status !== "ready") return { records: 0, errors: 0, peak: 0 }
    return state.buckets.reduce(
      (acc, bucket) => ({
        records: acc.records + bucket.total,
        errors: acc.errors + bucket.byLevel.error,
        peak: Math.max(acc.peak, bucket.total),
      }),
      { records: 0, errors: 0, peak: 0 }
    )
  }, [state])

  return (
    <section className="space-y-2" data-testid="sre-log-lens">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">{t("lens.title")}</h3>
        {onRequestWide && !wide ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={onRequestWide}
            data-testid="sre-lens-widen"
          >
            <MaximizeIcon className="size-3" />
            {t("lens.expand")}
          </Button>
        ) : null}
      </div>

      {!inCoverage && coverage ? (
        <p
          className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-500"
          data-testid="sre-lens-coverage"
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          {t("lens.outsideCoverage", { start: coverage.startTime, end: coverage.endTime })}
        </p>
      ) : null}

      {state.status === "loading" ? (
        <p className="text-xs text-muted-foreground">{t("lens.loading")}</p>
      ) : null}

      {state.status === "error" ? (
        <p className="text-xs text-destructive" data-testid="sre-lens-error">
          {t("lens.failed", { message: state.message })}
        </p>
      ) : null}

      {state.status === "ready" ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t("lens.records", { count: totals.records.toLocaleString() })}
            {totals.errors > 0 ? (
              <span className="ml-2 text-destructive">
                {t("lens.errors", { count: totals.errors.toLocaleString() })}
              </span>
            ) : null}
          </p>

          <div className="flex h-10 items-end gap-px" data-testid="sre-lens-histogram">
            {state.buckets.map((bucket) => {
              const ratio = totals.peak > 0 ? bucket.total / totals.peak : 0
              return (
                <span
                  key={bucket.startTime}
                  className={cn(
                    "min-h-px flex-1 rounded-xs",
                    bucket.byLevel.error > 0
                      ? "bg-destructive"
                      : bucket.byLevel.warn > 0
                        ? "bg-amber-500"
                        : "bg-muted-foreground/40"
                  )}
                  style={{ height: `${Math.round(ratio * 100)}%` }}
                />
              )
            })}
          </div>

          <h4 className="pt-1 text-xs text-muted-foreground">{t("lens.patterns")}</h4>
          {state.patterns.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="sre-lens-empty">
              {t("lens.empty")}
            </p>
          ) : (
            <ul className="divide-y">
              {state.patterns
                .slice(0, wide ? PATTERN_LIMIT_WIDE : PATTERN_LIMIT_NARROW)
                .map((pattern) => {
                  const allPinned = pattern.evidenceIds.every((id) => pinned.has(id))
                  return (
                    <li
                      key={pattern.id}
                      className="flex items-center gap-2 py-1.5"
                      data-testid="sre-lens-pattern"
                    >
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-xs"
                        title={pattern.template}
                      >
                        {pattern.template}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums">
                        {pattern.count.toLocaleString()}
                      </span>
                      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
                        {formatDelta(pattern, t)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0"
                        aria-label={allPinned ? t("lens.pinned") : t("lens.pinGroup")}
                        disabled={allPinned}
                        onClick={() => pinGroup(pattern)}
                      >
                        {allPinned ? (
                          <PinOffIcon className="size-3" />
                        ) : (
                          <PinIcon className="size-3" />
                        )}
                      </Button>
                    </li>
                  )
                })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  )
}
