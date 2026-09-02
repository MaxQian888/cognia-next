// `UsageGlanceSnapshotV1`: the one projection every ambient surface reads.
//
// The tray title, the tray menu, the tray quick panel, the Capacity Dock, the
// CLI footer and the read-only MCP tool all answer the same question, so they
// all answer it from the same pure function. Before this, each surface derived
// its own totals and they disagreed at the edges (which is how a menu bar can
// say $4.20 while the panel behind it says $3.90).
//
// Two rules the shape enforces rather than documents:
//
//   * UNKNOWN IS NOT ZERO. A turn whose model has no known price contributes
//     to `unpricedTurns`, never to `knownCostUsd`. Renderers show a lower
//     bound ("at least $4.20") or a dash, never a confident total that quietly
//     omits money.
//   * THE OS-FACING PROJECTION CARRIES NO CONTENT. No project name, no session
//     title, no prompt, no path, no tool argument. This object is pushed to a
//     Rust process and painted into a menu bar, and everything on it is a
//     number, an id, or an enum.

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { effectiveCostUsdDetailed, localDay, type PricingResolver } from "./session-analytics"
import { resolveModelPricingUsd } from "./pricing"

export const USAGE_GLANCE_VERSION = 1

/** Windows an ambient surface can show. */
export type UsageGlancePeriod = "today" | "7d" | "30d" | "month" | "90d"

export const USAGE_GLANCE_PERIODS: readonly UsageGlancePeriod[] = [
  "today",
  "7d",
  "30d",
  "month",
  "90d",
]

/**
 * Whose spend is being shown. `cognia` is the default and the only scope that
 * can ever move a budget. `all-tools` folds in the external index and is
 * opt-in, because most people's Cognia bill is not their Codex bill.
 */
export type UsageGlanceScope = "cognia" | "all-tools"

export const USAGE_GLANCE_SCOPES: readonly UsageGlanceScope[] = ["cognia", "all-tools"]

/** What an ambient surface leads with. */
export type UsageGlanceMetric = "spend" | "tokens" | "quota" | "budget"

export const USAGE_GLANCE_METRICS: readonly UsageGlanceMetric[] = [
  "spend",
  "tokens",
  "quota",
  "budget",
]

/** How much of the answer we actually have. */
export type UsageGlanceFreshness = "fresh" | "stale" | "partial"

export interface UsageGlanceQuery {
  period: UsageGlancePeriod
  scope: UsageGlanceScope
  metric: UsageGlanceMetric
  /** Restrict to one provider, when a surface is pinned to one. */
  providerId?: string
  /** Restrict to one external source (all-tools scope only). */
  sourceId?: string
}

export interface UsageGlanceBucket {
  /** Local day, "YYYY-MM-DD". */
  day: string
  knownCostUsd: number
  tokens: number
  turns: number
}

export interface UsageGlanceLeader {
  /** Provider or model id. Never a display name, so the surface can translate. */
  id: string
  knownCostUsd: number
  tokens: number
  turns: number
  /** Turns in this group whose price was unknown. */
  unpricedTurns: number
}

/** Compact quota readout folded in from the subscription plane. */
export interface UsageGlanceQuota {
  /** Highest utilization across configured accounts, 0-100, or null. */
  worstUsedPct: number | null
  /** Which account that was, by its tray selection key. */
  worstAccountKey: string | null
  /** Epoch ms the worst meter resets, when known. */
  resetAt: number | null
}

/** Worst budget verdict in force, folded in from the cost-budget plane. */
export interface UsageGlanceBudget {
  /** 0-1+ ratio of the tightest budget in force, or null when none is set. */
  ratio: number | null
  target: string | null
  period: "day" | "month" | null
  blocked: boolean
}

export interface UsageGlanceSnapshotV1 {
  version: typeof USAGE_GLANCE_VERSION
  query: UsageGlanceQuery
  /** When this projection was computed. */
  generatedAt: number
  freshness: UsageGlanceFreshness
  /** Window actually covered, which can be narrower than the period asked for. */
  coverageFromMs: number
  coverageToMs: number

  /** Sum of turns whose price is known. Never includes an unknown as zero. */
  knownCostUsd: number
  /** Turns inside the window with no resolvable price. */
  unpricedTurns: number
  turns: number
  sessions: number

  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Fresh input + output. Cache tiers are reported separately above. */
  billableTokens: number

  daily: UsageGlanceBucket[]
  topProviders: UsageGlanceLeader[]
  topModels: UsageGlanceLeader[]
  /** Per-source split. Empty in the `cognia` scope by construction. */
  bySource: UsageGlanceLeader[]

  quota: UsageGlanceQuota | null
  budget: UsageGlanceBudget | null
}

const DAY_MS = 86_400_000

/** How far past `now` a row may be dated before it reads as a broken clock. */
export const FUTURE_TOLERANCE_MS = 5 * 60_000

/** Inclusive start instant of a period, in local time. */
export function periodStart(period: UsageGlancePeriod, now: number): number {
  const d = new Date(now)
  switch (period) {
    case "today":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    case "month":
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    case "7d":
      return startOfLocalDay(now - 6 * DAY_MS)
    case "30d":
      return startOfLocalDay(now - 29 * DAY_MS)
    case "90d":
      return startOfLocalDay(now - 89 * DAY_MS)
  }
}

function startOfLocalDay(at: number): number {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * True when a row belongs in the requested scope.
 *
 * The `cognia` scope is exactly "spend this install paid", which is the same
 * predicate the budget uses. That equality is the point: a user who sees $12
 * in the menu bar and a budget that fires at $12 is looking at one number.
 */
export function rowInScope(row: SessionUsageRow, scope: UsageGlanceScope): boolean {
  const external = Boolean(row.sourceId) || row.imported === true
  return scope === "cognia" ? !external : true
}

function leadersFrom(groups: Map<string, UsageGlanceLeader>, limit: number): UsageGlanceLeader[] {
  return [...groups.values()]
    .sort((a, b) => {
      if (b.knownCostUsd !== a.knownCostUsd) return b.knownCostUsd - a.knownCostUsd
      return b.tokens - a.tokens
    })
    .slice(0, limit)
}

function bump(
  groups: Map<string, UsageGlanceLeader>,
  id: string,
  cost: { cost: number; known: boolean },
  tokens: number
): void {
  const entry = groups.get(id) ?? {
    id,
    knownCostUsd: 0,
    tokens: 0,
    turns: 0,
    unpricedTurns: 0,
  }
  entry.knownCostUsd += cost.known ? cost.cost : 0
  entry.tokens += tokens
  entry.turns += 1
  if (!cost.known) entry.unpricedTurns += 1
  groups.set(id, entry)
}

export interface BuildUsageGlanceInput {
  rows: readonly SessionUsageRow[]
  query: UsageGlanceQuery
  now?: number
  freshness?: UsageGlanceFreshness
  quota?: UsageGlanceQuota | null
  budget?: UsageGlanceBudget | null
  resolve?: PricingResolver
  /** How many providers / models / sources the leaders lists hold. */
  topN?: number
}

/**
 * Project raw ledger rows into the ambient snapshot. Pure and clock-injectable,
 * so the tray's node-env tests, the CLI and the renderer all exercise the same
 * arithmetic.
 */
export function buildUsageGlance(input: BuildUsageGlanceInput): UsageGlanceSnapshotV1 {
  const now = input.now ?? Date.now()
  const resolve = input.resolve ?? resolveModelPricingUsd
  const topN = input.topN ?? 5
  const from = periodStart(input.query.period, now)

  const providers = new Map<string, UsageGlanceLeader>()
  const models = new Map<string, UsageGlanceLeader>()
  const sources = new Map<string, UsageGlanceLeader>()
  const buckets = new Map<string, UsageGlanceBucket>()
  const sessions = new Set<string>()

  let knownCostUsd = 0
  let unpricedTurns = 0
  let turns = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let coverageFromMs = Number.POSITIVE_INFINITY
  let coverageToMs = 0

  // Rows are admitted slightly past `now`. The caller's clock is a shared
  // ticker rather than a fresh read, so a turn committed since the last tick is
  // legitimately "in the future" by a few seconds, and dropping it would make
  // the menu bar lag the write it is supposed to reflect. A timestamp beyond
  // the tolerance is a broken clock, not a fast one, and stays excluded.
  const ceiling = now + FUTURE_TOLERANCE_MS

  for (const row of input.rows) {
    if (!Number.isFinite(row.at) || row.at < from || row.at > ceiling) continue
    if (!rowInScope(row, input.query.scope)) continue
    if (input.query.providerId && row.providerId !== input.query.providerId) continue
    if (input.query.sourceId && row.sourceId !== input.query.sourceId) continue

    const cost = effectiveCostUsdDetailed(row, resolve)
    const rowTokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0)

    turns += 1
    sessions.add(row.sessionId)
    if (cost.known) knownCostUsd += cost.cost
    else unpricedTurns += 1
    inputTokens += row.inputTokens ?? 0
    outputTokens += row.outputTokens ?? 0
    cacheReadTokens += row.cacheReadTokens ?? 0
    cacheCreationTokens += row.cacheCreationTokens ?? 0
    if (row.at < coverageFromMs) coverageFromMs = row.at
    if (row.at > coverageToMs) coverageToMs = row.at

    if (row.providerId) bump(providers, row.providerId, cost, rowTokens)
    if (row.model) bump(models, row.model, cost, rowTokens)
    if (row.sourceId) bump(sources, row.sourceId, cost, rowTokens)

    const day = localDay(row.at)
    const bucket = buckets.get(day) ?? { day, knownCostUsd: 0, tokens: 0, turns: 0 }
    bucket.knownCostUsd += cost.known ? cost.cost : 0
    bucket.tokens += rowTokens
    bucket.turns += 1
    buckets.set(day, bucket)
  }

  return {
    version: USAGE_GLANCE_VERSION,
    query: input.query,
    generatedAt: now,
    freshness: input.freshness ?? "fresh",
    coverageFromMs: turns > 0 ? coverageFromMs : from,
    coverageToMs: turns > 0 ? coverageToMs : from,
    knownCostUsd,
    unpricedTurns,
    turns,
    sessions: sessions.size,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    billableTokens: inputTokens + outputTokens,
    daily: [...buckets.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    topProviders: leadersFrom(providers, topN),
    topModels: leadersFrom(models, topN),
    bySource: leadersFrom(sources, topN),
    quota: input.quota ?? null,
    budget: input.budget ?? null,
  }
}

/** An honest zero: no data yet, and saying so rather than claiming $0.00. */
export function emptyUsageGlance(
  query: UsageGlanceQuery,
  now: number = Date.now()
): UsageGlanceSnapshotV1 {
  return buildUsageGlance({ rows: [], query, now, freshness: "stale" })
}
