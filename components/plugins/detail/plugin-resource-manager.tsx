"use client"

// Rate limits — the token buckets `PluginRateLimiter` keeps for every plugin
// (`lib/plugin/security/rate-limiter.ts`, `DEFAULT_RATE_LIMITS`), phrased for a
// reader: "60 per minute, bursts up to 60".
//
// What this deliberately does NOT draw is a usage bar. The limiter keeps its
// buckets in memory and exposes no read of them, and the only per-plugin
// counters on disk are the analytics rows, which are all-time totals keyed by
// event name. A bar of "all-time count / per-window limit" compares two
// different things, and it rendered "0 / 60" before analytics had even loaded.
// So the row states the rule, and an all-time count only where the analytics
// table has one under the operation's key, labelled as all-time.
//
// Every plugin gets every default bucket (the limiter is keyed by plugin and
// operation, not by declared permission), so the caller always passes a
// non-empty list; the list is not given an empty state of its own.

import { useFormatter, useTranslations } from "next-intl"
import { Skeleton } from "@/components/ui/skeleton"
import { usePluginAnalytics } from "@/hooks/plugins"

export interface RateLimitMeta {
  /** The limiter's operation key, e.g. `network:fetch`. */
  key: string
  /** Calls allowed per `windowMs` at the sustained rate. */
  limit: number
  /**
   * The window `limit` refills over. `0` means the bucket never refills: `limit`
   * is a total, not a rate.
   */
  windowMs: number
  /** Calls allowed back to back before the sustained rate applies. */
  burst?: number
}

interface Props {
  pluginId: string
  /** Limits live in `lib/plugin/security/rate-limiter.ts`. We accept them as
   * a prop so this component stays test-friendly and decoupled from the
   * singleton. Default to the manager's published defaults at the call site. */
  limits: RateLimitMeta[]
}

/** Local date + time to the second, the precision the line always carried. */
const LAST_EVENT_FORMAT = { dateStyle: "medium", timeStyle: "medium" } as const

/** A usable instant, or null for a missing (0) or unparseable one. */
function toEventDate(at: number | undefined): Date | null {
  if (!at) return null
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? null : date
}

const WINDOW_UNITS = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
] as const

export type RateWindowUnit = (typeof WINDOW_UNITS)[number][0] | "millisecond"

/**
 * The largest whole unit `windowMs` is a multiple of, so 60 000 reads "per
 * minute" and 90 000 "every 90 seconds" rather than "every 1.5 minutes".
 */
export function rateWindow(windowMs: number): { unit: RateWindowUnit; count: number } {
  for (const [unit, ms] of WINDOW_UNITS) {
    if (windowMs % ms === 0) return { unit, count: windowMs / ms }
  }
  return { unit: "millisecond", count: windowMs }
}

export function PluginResourceManager({ pluginId, limits }: Props) {
  const t = useTranslations("plugins.resourceManager")
  const format = useFormatter()
  const analytics = usePluginAnalytics()
  const entry = analytics.byPlugin.find((p) => p.pluginId === pluginId)

  const rateText = (rule: RateLimitMeta): string => {
    if (rule.windowMs <= 0) return t("rate.total", { limit: rule.limit })
    const { unit, count } = rateWindow(rule.windowMs)
    return t(`rate.${unit}`, { limit: rule.limit, count })
  }

  return (
    <div className="@container space-y-2" data-testid="plugin-resource-manager">
      <p className="text-xs text-muted-foreground">{t("note")}</p>

      {/* Skeletons are hidden from assistive tech; the list announces the
          wait once instead of once per row. */}
      {analytics.loading && (
        <span role="status" className="sr-only">
          {t("loadingUsage")}
        </span>
      )}
      <ul className="divide-y" aria-label={t("title")} aria-busy={analytics.loading}>
        {limits.map((rule) => {
          const counter = entry?.byKey[rule.key]
          const lastEvent = toEventDate(counter?.lastEventAt)
          return (
            <li
              key={rule.key}
              className="flex flex-col gap-0.5 py-1.5 text-xs @sm:flex-row @sm:items-baseline @sm:justify-between @sm:gap-3"
            >
              <code className="min-w-0 truncate font-mono">{rule.key}</code>
              <div className="flex flex-col gap-0.5 @sm:items-end">
                <span>
                  {rule.burst !== undefined
                    ? t("rateWithBurst", { rate: rateText(rule), burst: rule.burst })
                    : rateText(rule)}
                </span>
                {analytics.loading ? (
                  <Skeleton className="h-3 w-28" data-testid={`rate-usage-loading-${rule.key}`} />
                ) : counter ? (
                  <span className="text-muted-foreground">
                    {lastEvent
                      ? t.rich("recordedLast", {
                          recorded: t("recorded", { count: counter.count }),
                          date: format.dateTime(lastEvent, LAST_EVENT_FORMAT),
                          time: (chunks) => (
                            <time dateTime={lastEvent.toISOString()}>{chunks}</time>
                          ),
                        })
                      : t("recorded", { count: counter.count })}
                  </span>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
