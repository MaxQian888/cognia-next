// Turning a `UsageGlanceSnapshotV1` into the rows the Capacity Dock paints.
//
// Pure, so the selection rules are pinned by tests rather than discovered by
// staring at a rail. Two of them are load-bearing:
//
//   * A row whose cost could not be priced reports a NULL ratio and an
//     "unknown" severity. It is never drawn as a full gauge at zero, which
//     would read as "this provider is free" instead of "we do not know".
//   * The collapsed rail shows the PREFERRED provider when the user pinned
//     one and it appears in the window, and otherwise the busiest. Falling
//     back silently to the busiest matters because a pinned provider the user
//     simply has not used today would otherwise collapse the rail to nothing.

import { formatCompactUsd } from "@/lib/usage/status-snapshot"
import { UNKNOWN_COST } from "@/lib/usage/session-analytics"
import type { UsageGlanceSnapshotV1 } from "@/lib/usage/usage-glance"

import { MAX_DOCK_ROWS, type DockGaugeMode, type UsageDockRow } from "./types"

function severityFor(ratio: number | null): UsageDockRow["severity"] {
  if (ratio == null || !Number.isFinite(ratio)) return "unknown"
  if (ratio >= 1) return "exceeded"
  if (ratio >= 0.95) return "crit"
  if (ratio >= 0.8) return "warn"
  return "ok"
}

/**
 * A provider's share of the gauge.
 *
 * `budget` mode measures the provider against the window's total known spend,
 * which is the only per-provider denominator that exists without a per-provider
 * ceiling. `quota` mode measures against the plan headroom the snapshot folded
 * in, which is account-wide rather than per-provider, so every row shows the
 * same figure and the rail reads as one meter split across rows.
 */
export function rowRatio(
  snapshot: UsageGlanceSnapshotV1,
  providerCost: number,
  mode: DockGaugeMode
): number | null {
  if (mode === "quota") {
    const pct = snapshot.quota?.worstUsedPct
    return typeof pct === "number" && Number.isFinite(pct) ? Math.min(1, pct / 100) : null
  }
  const total = snapshot.knownCostUsd
  if (!Number.isFinite(total) || total <= 0) return null
  return Math.min(1, Math.max(0, providerCost / total))
}

export interface BuildDockRowsOptions {
  snapshot: UsageGlanceSnapshotV1
  /** Providers the user pinned, in order. Empty means "the busiest". */
  providerIds?: readonly string[]
  gaugeMode?: DockGaugeMode
  maxRows?: number
}

/** Build the rows an expanded rail renders, in display order. */
export function buildDockRows(opts: BuildDockRowsOptions): UsageDockRow[] {
  const { snapshot } = opts
  const mode = opts.gaugeMode ?? "budget"
  const limit = Math.max(1, Math.min(opts.maxRows ?? MAX_DOCK_ROWS, MAX_DOCK_ROWS))
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
    const ratio = priced ? rowRatio(snapshot, cost, mode) : null
    return {
      providerId: id,
      ratio,
      label: priced ? `${unpriced > 0 ? "≥" : ""}${formatCompactUsd(cost)}` : UNKNOWN_COST,
      knownCostUsd: cost,
      unpricedTurns: unpriced,
      severity: severityFor(ratio),
    }
  })
}

/**
 * The single row a collapsed rail shows: the pinned provider when it is in the
 * window, else the busiest one, else nothing.
 */
export function collapsedRow(
  rows: readonly UsageDockRow[],
  preferredProviderId: string | null
): UsageDockRow | null {
  if (preferredProviderId) {
    const pinned = rows.find((r) => r.providerId === preferredProviderId)
    if (pinned) return pinned
  }
  return rows[0] ?? null
}
