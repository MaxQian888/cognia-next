// Turning what the main window pushes into the rows the Capacity Dock paints:
// a `UsageGlanceSnapshotV1` in budget mode, the glance quota slice in quota
// mode (ADR-0225 §7).
//
// Pure, so the selection rules are pinned by tests rather than discovered by
// staring at a rail. Three of them are load-bearing:
//
//   * A row whose cost could not be priced reports a NULL ratio and an
//     "unknown" severity. It is never drawn as a full gauge at zero, which
//     would read as "this provider is free" instead of "we do not know".
//   * The collapsed rail shows the PREFERRED provider when the user pinned
//     one and it appears in the window, and otherwise the busiest. Falling
//     back silently to the busiest matters because a pinned provider the user
//     simply has not used today would otherwise collapse the rail to nothing.
//   * A quota row whose reading is not current (stale, failed, still loading)
//     keeps its last ratio but loses its colour, so an old number never
//     passes for a live one.

import type { GlanceQuotaSlice, GlanceQuotaState, GlanceQuotaWindow } from "@/lib/glance/snapshot"
import { formatCompactUsd } from "@/lib/usage/status-snapshot"
import { UNKNOWN_COST } from "@/lib/usage/session-analytics"
import type { UsageGlanceSnapshotV1 } from "@/lib/usage/usage-glance"

import { MAX_DOCK_ROWS, type UsageDockRow } from "./types"

function severityFor(ratio: number | null): UsageDockRow["severity"] {
  if (ratio == null || !Number.isFinite(ratio)) return "unknown"
  if (ratio >= 1) return "exceeded"
  if (ratio >= 0.95) return "crit"
  if (ratio >= 0.8) return "warn"
  return "ok"
}

/**
 * A provider's share of the gauge in budget mode: the provider against the
 * window's total known spend, which is the only per-provider denominator that
 * exists without a per-provider ceiling.
 */
export function rowRatio(snapshot: UsageGlanceSnapshotV1, providerCost: number): number | null {
  const total = snapshot.knownCostUsd
  if (!Number.isFinite(total) || total <= 0) return null
  return Math.min(1, Math.max(0, providerCost / total))
}

export interface BuildDockRowsOptions {
  snapshot: UsageGlanceSnapshotV1
  /** Providers the user pinned, in order. Empty means "the busiest". */
  providerIds?: readonly string[]
  maxRows?: number
}

function rowLimit(maxRows: number | undefined): number {
  return Math.max(1, Math.min(maxRows ?? MAX_DOCK_ROWS, MAX_DOCK_ROWS))
}

/** Build the rows an expanded budget rail renders, in display order. */
export function buildDockRows(opts: BuildDockRowsOptions): UsageDockRow[] {
  const { snapshot } = opts
  const limit = rowLimit(opts.maxRows)
  const byId = new Map(snapshot.topProviders.map((p) => [p.id, p]))

  const chosen = opts.providerIds?.length
    ? // A pinned provider with no traffic in the window is dropped rather than
      // rendered as an empty gauge: a rail full of blank rows says less than a
      // shorter rail of real ones.
      opts.providerIds.filter((id) => byId.has(id))
    : snapshot.topProviders.map((p) => p.id)

  return chosen.slice(0, limit).map((id) => {
    const leader = byId.get(id)
    const cost = leader?.knownCostUsd ?? 0
    const unpriced = leader?.unpricedTurns ?? 0
    const priced = (leader?.turns ?? 0) > unpriced
    const ratio = priced ? rowRatio(snapshot, cost) : null
    return {
      key: id,
      providerId: id,
      accountLabel: null,
      ratio,
      label: priced ? `${unpriced > 0 ? "≥" : ""}${formatCompactUsd(cost)}` : UNKNOWN_COST,
      knownCostUsd: cost,
      unpricedTurns: unpriced,
      severity: severityFor(ratio),
      quotaState: null,
      resetAt: null,
    }
  })
}

/**
 * Quota sources a rail shows: those that are queried. A `disabled` account or
 * a `discovered` login has no reading to draw; enabling one is a settings
 * action the panel offers, not something a gauge can do.
 */
const QUOTA_ROW_STATES: ReadonlySet<GlanceQuotaState> = new Set([
  "ok",
  "warn",
  "exhausted",
  "error",
  "stale",
  "refreshing",
])

/** States whose meters are a current reading. */
const CURRENT_QUOTA_STATES: ReadonlySet<GlanceQuotaState> = new Set(["ok", "warn", "exhausted"])

/** The window with the highest used share, or null when none has one. */
export function tightestWindow(windows: readonly GlanceQuotaWindow[]): GlanceQuotaWindow | null {
  let worst: GlanceQuotaWindow | null = null
  for (const w of windows) {
    if (typeof w.usedPct !== "number" || !Number.isFinite(w.usedPct)) continue
    if (!worst || w.usedPct > (worst.usedPct as number)) worst = w
  }
  return worst
}

export interface BuildDockQuotaRowsOptions {
  slice: GlanceQuotaSlice | null
  maxRows?: number
}

/**
 * Build the rows an expanded quota rail renders: one per queried source, by
 * its tightest window's used share (the convention of the tray panel's quota
 * module), tightest first. A source with no reading sorts last.
 */
export function buildDockQuotaRows(opts: BuildDockQuotaRowsOptions): UsageDockRow[] {
  if (!opts.slice) return []
  const rows = opts.slice.sources
    .filter((source) => QUOTA_ROW_STATES.has(source.state))
    .map((source): UsageDockRow => {
      const worst = tightestWindow(source.windows)
      const pct = worst ? (worst.usedPct as number) : null
      const ratio = pct === null ? null : Math.min(1, Math.max(0, pct / 100))
      const current = CURRENT_QUOTA_STATES.has(source.state)
      return {
        key: source.key,
        providerId: source.provider,
        accountLabel: source.accountLabel,
        ratio,
        label: pct === null ? UNKNOWN_COST : `${Math.round(pct)}%`,
        knownCostUsd: 0,
        unpricedTurns: 0,
        severity: current && worst ? worst.severity : "unknown",
        quotaState: source.state,
        resetAt: worst?.resetAt ?? null,
      }
    })
  const order = new Map(rows.map((row, index) => [row.key, index]))
  rows.sort((a, b) => {
    if (a.ratio === null || b.ratio === null) {
      if (a.ratio === b.ratio) return (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)
      return a.ratio === null ? 1 : -1
    }
    return b.ratio - a.ratio || (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)
  })
  return rows.slice(0, rowLimit(opts.maxRows))
}

/**
 * The single row a collapsed rail shows: the pinned provider when it is in the
 * window, else the first row (the busiest provider, or the tightest quota
 * source), else nothing. A quota rail matches the pin by source key or by its
 * provider.
 */
export function collapsedRow(
  rows: readonly UsageDockRow[],
  preferredProviderId: string | null
): UsageDockRow | null {
  if (preferredProviderId) {
    const pinned =
      rows.find((r) => r.key === preferredProviderId) ??
      rows.find((r) => r.providerId === preferredProviderId)
    if (pinned) return pinned
  }
  return rows[0] ?? null
}
