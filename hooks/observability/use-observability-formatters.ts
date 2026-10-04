"use client"

/**
 * Locale-aware formatters for the agent-trace UI, routed through next-intl's
 * `useFormatter` so units, separators, currency and dates follow the APP
 * locale (zh-CN or en), not the browser's.
 *
 * `lib/observability/format-utils.ts` still has the compact, locale-neutral
 * forms for pure modules; this is what a component reaches for when the unit
 * is user-facing text. The pieces that used to be hand-rolled in components —
 * `${n}ms`, `${in}/${out}t`, `${s}s` cadence labels, `${v}/s` rates — all
 * became untranslatable string concatenation the moment the UI shipped in a
 * second language. Compound labels ("{value}/s", "{in} in / {out} out") are
 * messages that take these formatted numbers as arguments, so word order stays
 * the translator's call.
 */

import { useMemo } from "react"
import { useFormatter, type DateTimeFormatOptions } from "next-intl"

/** next-intl's own option type for `dateTime` — narrower than
 * `Intl.DateTimeFormatOptions` (e.g. `timeZoneName` is "long" | "short"). */
export type DateTimeOptions = DateTimeFormatOptions

export interface ObservabilityFormatters {
  /** Duration in ms → "850 ms" / "1.24 s" / "2.5 min" (narrow unit display). */
  duration: (ms: number | null | undefined) => string
  /** USD with adaptive precision: sub-cent amounts keep 4 fraction digits. */
  usd: (value: number | null | undefined) => string
  /** Compact count: "1.2K", "3.4M" (or "1.2万" in zh-CN). */
  compact: (value: number | null | undefined) => string
  /** Plain grouped integer. */
  integer: (value: number | null | undefined) => string
  /** Plain decimal with up to `digits` fraction digits (for message slots). */
  decimal: (value: number | null | undefined, digits?: number) => string
  /** Fraction (0..1) → "12.5%" / "12.5 %" with exactly `digits` fraction digits. */
  percent: (fraction: number | null | undefined, digits?: number) => string
  /** Date + time with explicit `Intl.DateTimeFormat` options (chart axes). */
  dateTimeWith: (ts: number, options: DateTimeOptions) => string
  /** Time of day ("14:03:22"). */
  time: (ts: number) => string
  /** Date + time, short ("Oct 3, 14:03"). */
  dateTime: (ts: number) => string
}

const DASH = "—"

export function useObservabilityFormatters(): ObservabilityFormatters {
  const format = useFormatter()
  return useMemo<ObservabilityFormatters>(() => {
    const finite = (value: number | null | undefined): value is number =>
      typeof value === "number" && Number.isFinite(value)

    return {
      duration: (ms) => {
        if (!finite(ms)) return DASH
        const value = Math.max(0, ms)
        if (value < 1000) {
          return format.number(Math.round(value), {
            style: "unit",
            unit: "millisecond",
            unitDisplay: "narrow",
          })
        }
        if (value < 60_000) {
          return format.number(value / 1000, {
            style: "unit",
            unit: "second",
            unitDisplay: "narrow",
            maximumFractionDigits: 2,
          })
        }
        return format.number(value / 60_000, {
          style: "unit",
          unit: "minute",
          unitDisplay: "narrow",
          maximumFractionDigits: 1,
        })
      },
      usd: (value) => {
        if (!finite(value)) return DASH
        const small = value !== 0 && Math.abs(value) < 0.01
        return format.number(value, {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: small ? 4 : 2,
          maximumFractionDigits: small ? 4 : 2,
        })
      },
      compact: (value) =>
        finite(value)
          ? format.number(value, { notation: "compact", maximumFractionDigits: 1 })
          : DASH,
      integer: (value) =>
        finite(value) ? format.number(Math.round(value), { maximumFractionDigits: 0 }) : DASH,
      decimal: (value, digits = 2) =>
        finite(value) ? format.number(value, { maximumFractionDigits: digits }) : DASH,
      percent: (fraction, digits = 0) =>
        finite(fraction)
          ? format.number(fraction, {
              style: "percent",
              minimumFractionDigits: digits,
              maximumFractionDigits: digits,
            })
          : DASH,
      dateTimeWith: (ts, options) => format.dateTime(ts, options),
      time: (ts) => format.dateTime(ts, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      dateTime: (ts) =>
        format.dateTime(ts, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
    }
  }, [format])
}
