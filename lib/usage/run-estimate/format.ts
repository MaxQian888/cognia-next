/**
 * Render a {@link RunEstimate} as one line of text (ADR-0232).
 *
 * Shared by the React hint (`components/usage/run-estimate-hint.tsx`) and the
 * `/goal` system card, which has no React tree. Both pass a translator bound
 * to the `runEstimate` namespace, so the wording lives in one place.
 *
 * Cost is always labelled "at API prices": for an API-key user that is the
 * bill, for a subscription user it is the equivalent, and no quota percentage
 * is ever derived from tokens.
 */

import { formatTokens, formatUsd } from "@/lib/observability/format-utils"
import { formatDurationShort } from "@/lib/utils"

import type { Quantiles, RunEstimate } from "./estimate"

/** next-intl's `t` and the runtime translator both satisfy this. */
export type EstimateTranslator = (key: string, values?: Record<string, string | number>) => string

export interface FormattedRunEstimate {
  /** Cost, tokens and duration, or the "no estimate" sentence. */
  summary: string
  /** How much history backs it, and how often such runs stop early. */
  detail: string | null
}

/**
 * Minutes are as precise as a rough expectation of a long run gets, so past a
 * minute the seconds are dropped rather than printed as a constant "0s".
 */
function formatEstimateDuration(ms: number): string {
  if (ms < 60_000) return formatDurationShort(ms)
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const rest = minutes % 60
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`
}

function range(q: Quantiles, fmt: (n: number) => string) {
  return { typical: fmt(q.p50), low: fmt(q.p10), high: fmt(q.p90) }
}

export function formatRunEstimate(
  estimate: RunEstimate,
  t: EstimateTranslator,
  options: { dormant?: boolean } = {}
): FormattedRunEstimate {
  if (options.dormant) return { summary: t("unavailable"), detail: null }
  if (estimate.confidence === "none") return { summary: t("none"), detail: null }

  const parts: string[] = []
  if (estimate.costUsd) parts.push(t("cost", range(estimate.costUsd, formatUsd)))
  if (estimate.tokens) parts.push(t("tokens", range(estimate.tokens, formatTokens)))
  if (estimate.durationMs)
    parts.push(t("duration", range(estimate.durationMs, formatEstimateDuration)))
  if (parts.length === 0) return { summary: t("none"), detail: null }

  const detail = [t(`confidence.${estimate.confidence}`, { count: estimate.sampleCount })]
  if (estimate.stoppedShare !== null && estimate.stoppedShare > 0) {
    detail.push(t("stopped", { percent: Math.round(estimate.stoppedShare * 100) }))
  }
  return { summary: parts.join(" · "), detail: detail.join(" · ") }
}
