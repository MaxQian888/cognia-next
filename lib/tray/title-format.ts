// The composable menu-bar title (ADR-0225 §11): an ordered list of fields the
// user picks, rendered as one short line next to the tray icon, e.g.
// `1D 103.3M · 7D 12.6B · ▶2 · ⚑1 · Q 82%`.
//
// Pure: field normalization, the migration from the single-metric title that
// came before it, and the text. The reactive half (which feeds run while the
// title is on) is `lib/tray/title.ts`.
//
// Two rules shape the text:
//   * A field with nothing to say is left out rather than shown as zero or a
//     dash: no work running, no quota reading, a window with no turns. The
//     title is the most expensive real estate the app has.
//   * Spend obeys the usage glance's honesty rule: a window where some turns
//     had no price reads "≥$x", and one where none had a price is left out.

import { lastLocalDays } from "@/lib/glance/build-usage"
import { formatCompactTokens, formatCompactUsd } from "@/lib/usage/status-snapshot"
import type {
  UsageGlanceBucket,
  UsageGlanceMetric,
  UsageGlancePeriod,
} from "@/lib/usage/usage-glance"

/** The usage windows a title field sums over: today, 7 and 30 local days. */
export type TrayTitlePeriod = "1d" | "7d" | "30d"
export const TRAY_TITLE_PERIODS: readonly TrayTitlePeriod[] = ["1d", "7d", "30d"]

/** What a usage field counts. */
export type TrayTitleMetric = "tokens" | "spend"
export const TRAY_TITLE_METRICS: readonly TrayTitleMetric[] = ["tokens", "spend"]

/**
 * One field of the title.
 *
 * - `usage`: tokens or spend over one window, in the tray's counted scope.
 * - `running`: Fleet tasks working now.
 * - `awaiting`: Fleet tasks waiting on an approval.
 * - `quota`: the highest used share among the quota windows, the panel's
 *   convention (the pinned subscription when one is pinned).
 * - `budget`: the tightest cost budget's used share.
 */
export type TrayTitleField =
  | { kind: "usage"; period: TrayTitlePeriod; metric: TrayTitleMetric }
  | { kind: "running" }
  | { kind: "awaiting" }
  | { kind: "quota" }
  | { kind: "budget" }

export type TrayTitleFieldKind = TrayTitleField["kind"]
export const TRAY_TITLE_FIELD_KINDS: readonly TrayTitleFieldKind[] = [
  "usage",
  "running",
  "awaiting",
  "quota",
  "budget",
]

/** More than this and the title crowds out the menu bar's other items. */
export const TRAY_TITLE_MAX_FIELDS = 6

/** What a new title shows once the user turns it on. */
export const DEFAULT_TRAY_TITLE_FIELDS: readonly TrayTitleField[] = [
  { kind: "usage", period: "1d", metric: "tokens" },
  { kind: "running" },
  { kind: "awaiting" },
]

/** Identity of a field: a title holds each at most once. */
export function titleFieldKey(field: TrayTitleField): string {
  return field.kind === "usage" ? `usage:${field.period}:${field.metric}` : field.kind
}

function parseField(raw: unknown): TrayTitleField | null {
  if (typeof raw !== "object" || raw === null) return null
  const v = raw as Record<string, unknown>
  switch (v.kind) {
    case "usage":
      if (!TRAY_TITLE_PERIODS.includes(v.period as TrayTitlePeriod)) return null
      if (!TRAY_TITLE_METRICS.includes(v.metric as TrayTitleMetric)) return null
      return {
        kind: "usage",
        period: v.period as TrayTitlePeriod,
        metric: v.metric as TrayTitleMetric,
      }
    case "running":
    case "awaiting":
    case "quota":
    case "budget":
      return { kind: v.kind }
    default:
      return null
  }
}

/**
 * A stored field list, cleaned: unknown or malformed fields dropped, repeats
 * dropped (first wins), capped. Null when `raw` is not a list at all, which is
 * what tells the caller to migrate rather than to honour an empty title.
 */
export function normalizeTitleFields(raw: unknown): TrayTitleField[] | null {
  if (!Array.isArray(raw)) return null
  const seen = new Set<string>()
  const out: TrayTitleField[] = []
  for (const entry of raw) {
    const field = parseField(entry)
    if (!field) continue
    const key = titleFieldKey(field)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(field)
    if (out.length === TRAY_TITLE_MAX_FIELDS) break
  }
  return out
}

const LEGACY_PERIOD: Record<UsageGlancePeriod, TrayTitlePeriod> = {
  today: "1d",
  "7d": "7d",
  "30d": "30d",
  // The calendar month and the quarter have no title window; 30 days is the
  // nearest one that still reads as "this month".
  month: "30d",
  "90d": "30d",
}

/**
 * The title an install showed before titles were composable: the one number
 * `usageMetric` named, over `usagePeriod`. An upgraded install whose title was
 * on keeps showing the same thing.
 */
export function legacyTitleFields(display: {
  usageMetric: UsageGlanceMetric
  usagePeriod: UsageGlancePeriod
}): TrayTitleField[] {
  switch (display.usageMetric) {
    case "quota":
      return [{ kind: "quota" }]
    case "budget":
      return [{ kind: "budget" }]
    case "tokens":
    case "spend":
      return [
        { kind: "usage", period: LEGACY_PERIOD[display.usagePeriod], metric: display.usageMetric },
      ]
  }
}

/** True when some field reads the quota feed (which then has to run). */
export function titleNeedsQuota(fields: readonly TrayTitleField[]): boolean {
  return fields.some((field) => field.kind === "quota")
}

/** True when some field reads the usage ledger. */
export function titleNeedsUsage(fields: readonly TrayTitleField[]): boolean {
  return fields.some((field) => field.kind === "usage")
}

/** Everything the title can show, already read. */
export interface TrayTitleData {
  /** Daily usage buckets covering at least the last 30 local days, or null. */
  daily: readonly UsageGlanceBucket[] | null
  /** Fleet counts, or null where there is no Fleet. */
  fleet: { working: number; awaiting: number } | null
  /** Highest used share among quota windows, 0-100, or null. */
  quotaUsedPct: number | null
  /** Tightest budget's used share, 0-1+, or null when no budget is set. */
  budgetRatio: number | null
  now: number
}

/** The localized pieces of the title. Values arrive formatted. */
export interface TrayTitleLabels {
  usage: (period: TrayTitlePeriod, value: string) => string
  running: (count: number) => string
  awaiting: (count: number) => string
  quota: (pct: number) => string
  budget: (pct: number) => string
}

export const TRAY_TITLE_SEPARATOR = " · "

const PERIOD_DAYS: Record<TrayTitlePeriod, number> = { "1d": 1, "7d": 7, "30d": 30 }

function usageText(
  field: Extract<TrayTitleField, { kind: "usage" }>,
  daily: readonly UsageGlanceBucket[],
  now: number
): string | null {
  const days = new Set(lastLocalDays(now, PERIOD_DAYS[field.period]))
  let tokens = 0
  let cost = 0
  let turns = 0
  let unpriced = 0
  for (const bucket of daily) {
    if (!days.has(bucket.day)) continue
    tokens += bucket.tokens
    cost += bucket.knownCostUsd
    turns += bucket.turns
    unpriced += bucket.unpricedTurns
  }
  if (turns === 0) return null
  if (field.metric === "tokens") return formatCompactTokens(tokens)
  if (unpriced >= turns) return null
  const money = formatCompactUsd(cost)
  return unpriced > 0 ? `≥${money}` : money
}

function fieldText(field: TrayTitleField, data: TrayTitleData, labels: TrayTitleLabels) {
  switch (field.kind) {
    case "usage": {
      if (!data.daily) return null
      const value = usageText(field, data.daily, data.now)
      return value === null ? null : labels.usage(field.period, value)
    }
    case "running":
      return data.fleet && data.fleet.working > 0 ? labels.running(data.fleet.working) : null
    case "awaiting":
      return data.fleet && data.fleet.awaiting > 0 ? labels.awaiting(data.fleet.awaiting) : null
    case "quota":
      return data.quotaUsedPct !== null && Number.isFinite(data.quotaUsedPct)
        ? labels.quota(Math.max(0, Math.round(data.quotaUsedPct)))
        : null
    case "budget":
      return data.budgetRatio !== null && Number.isFinite(data.budgetRatio)
        ? labels.budget(Math.max(0, Math.round(data.budgetRatio * 100)))
        : null
  }
}

/** The title text, or null when no field has anything to say (the title clears). */
export function formatTrayTitle(
  fields: readonly TrayTitleField[],
  data: TrayTitleData,
  labels: TrayTitleLabels
): string | null {
  const parts: string[] = []
  for (const field of fields) {
    const text = fieldText(field, data, labels)
    if (text) parts.push(text)
  }
  return parts.length > 0 ? parts.join(TRAY_TITLE_SEPARATOR) : null
}
