// MCP tool handlers for the user's own spend (ADR-0165 Phase 4).
//
//   * `usage_query`: totals for a window, split by provider and model.
//   * `session_health`: work-unit efficiency for one session or run.
//   * `optimization_findings`: what the detectors currently think.
//
// All three are READ-ONLY and sit behind one scope (`usage:read`, default
// OFF). None of them can change a setting, and none returns a project name, a
// session title, a prompt, a file path or a tool argument.
//
// Ids ARE returned, because an agent asked to look at a run needs to be able
// to name it back. They are pseudonymized first: a stable per-install hash, so
// the same session is recognizable across calls without the id itself
// disclosing which repository or customer it belongs to.
//
// Pure handlers plus Dexie reads. The MCP server layer owns the permission
// gate and the audit log, so policy refusals here return structured
// `{ ok: false, reason }` rather than throwing.

import { getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { attributeSpend, type AdoptionAttribution } from "@/lib/usage/adoption-attribution"
import { runDetectors, type OptimizationFindingV1 } from "@/lib/usage/optimization/findings"
import {
  aggregateByModel,
  effectiveCostUsdDetailed,
  type ModelUsageRow,
} from "@/lib/usage/session-analytics"
import { analyzeWorkUnit, type WorkUnitMetrics } from "@/lib/usage/work-unit-analysis"
import {
  buildUsageGlance,
  periodStart,
  USAGE_GLANCE_PERIODS,
  type UsageGlancePeriod,
  type UsageGlanceScope,
} from "@/lib/usage/usage-glance"

/** Hardest cap on rows any one call will read. */
export const MAX_USAGE_ROWS = 20_000

export type UsageToolFailure = { ok: false; reason: "invalidPeriod" | "unknownSession" | "empty" }

/**
 * Stable per-install pseudonym for an id.
 *
 * Deterministic so an agent can correlate across calls in a conversation, and
 * one-way so the pseudonym never reveals the repository, customer or branch
 * the real id encodes. Not cryptographic, and not required to be: the goal is
 * to stop an id from LEAKING meaning, not to resist an attacker who already
 * has the same install's data.
 */
export function pseudonymize(id: string): string {
  let h = 2166136261
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `id_${(h >>> 0).toString(36)}`
}

function isPeriod(value: string): value is UsageGlancePeriod {
  return (USAGE_GLANCE_PERIODS as readonly string[]).includes(value)
}

async function readRows(fromMs: number): Promise<SessionUsageRow[]> {
  return getDb().sessionUsage.where("at").aboveOrEqual(fromMs).limit(MAX_USAGE_ROWS).toArray()
}

/* ── usage_query ───────────────────────────────────────────────────────── */

export interface UsageQueryInput {
  period?: string
  scope?: UsageGlanceScope
  providerId?: string
}

export interface UsageQueryResult {
  ok: true
  period: UsageGlancePeriod
  scope: UsageGlanceScope
  /** Only turns whose price is known. Never a total that hides unknowns. */
  knownCostUsd: number
  unpricedTurns: number
  turns: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  topProviders: Array<{ id: string; knownCostUsd: number; turns: number }>
  topModels: Array<{ id: string; knownCostUsd: number; turns: number }>
  /** Per-day series, oldest first. */
  daily: Array<{ day: string; knownCostUsd: number; turns: number }>
}

export async function usageQuery(
  input: UsageQueryInput = {}
): Promise<UsageQueryResult | UsageToolFailure> {
  const period = input.period ?? "7d"
  if (!isPeriod(period)) return { ok: false, reason: "invalidPeriod" }
  const now = Date.now()
  const rows = await readRows(periodStart(period, now))
  const snapshot = buildUsageGlance({
    rows,
    query: {
      period,
      scope: input.scope ?? "cognia",
      metric: "spend",
      providerId: input.providerId,
    },
    now,
  })
  return {
    ok: true,
    period,
    scope: snapshot.query.scope,
    knownCostUsd: snapshot.knownCostUsd,
    unpricedTurns: snapshot.unpricedTurns,
    turns: snapshot.turns,
    sessions: snapshot.sessions,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    cacheReadTokens: snapshot.cacheReadTokens,
    // Provider and model ids are public vocabulary, so they pass through.
    topProviders: snapshot.topProviders.map((p) => ({
      id: p.id,
      knownCostUsd: p.knownCostUsd,
      turns: p.turns,
    })),
    topModels: snapshot.topModels.map((m) => ({
      id: m.id,
      knownCostUsd: m.knownCostUsd,
      turns: m.turns,
    })),
    daily: snapshot.daily.map((b) => ({
      day: b.day,
      knownCostUsd: b.knownCostUsd,
      turns: b.turns,
    })),
  }
}

/* ── session_health ────────────────────────────────────────────────────── */

export interface SessionHealthInput {
  sessionId: string
}

export interface SessionHealthResult {
  ok: true
  /** Pseudonymized, so the caller can name the session back without learning it. */
  sessionRef: string
  metrics: WorkUnitMetrics
  models: Array<Pick<ModelUsageRow, "model" | "turns">>
  attribution: Pick<
    AdoptionAttribution,
    "confidence" | "evidenceCoverage" | "acceptedFiles" | "acceptedLines"
  >
}

export async function sessionHealth(
  input: SessionHealthInput
): Promise<SessionHealthResult | UsageToolFailure> {
  const sessionId = (input.sessionId ?? "").trim()
  if (!sessionId) return { ok: false, reason: "unknownSession" }
  const db = getDb()
  const rows = await db.sessionUsage.where("sessionId").equals(sessionId).toArray()
  if (rows.length === 0) return { ok: false, reason: "unknownSession" }
  const adoption = await db.codeAdoptionTurns
    .where("sessionId")
    .equals(sessionId)
    .toArray()
    .catch(() => [])

  const metrics = analyzeWorkUnit({ rows, adoption })
  const attribution = attributeSpend({ rows, adoption })
  return {
    ok: true,
    sessionRef: pseudonymize(sessionId),
    metrics,
    // Turn counts per model, without the per-turn cost breakdown: the caller
    // asked how healthy the session was, not for a second copy of the bill.
    models: aggregateByModel(rows).map((m) => ({ model: m.model, turns: m.turns })),
    attribution: {
      confidence: attribution.confidence,
      evidenceCoverage: attribution.evidenceCoverage,
      acceptedFiles: attribution.acceptedFiles,
      acceptedLines: attribution.acceptedLines,
    },
  }
}

/* ── optimization_findings ─────────────────────────────────────────────── */

export interface OptimizationFindingsInput {
  period?: string
}

export interface OptimizationFindingsResult {
  ok: true
  period: UsageGlancePeriod
  findings: Array<Omit<OptimizationFindingV1, "action"> & { hasAction: boolean }>
}

export async function optimizationFindings(
  input: OptimizationFindingsInput = {}
): Promise<OptimizationFindingsResult | UsageToolFailure> {
  const period = input.period ?? "30d"
  if (!isPeriod(period)) return { ok: false, reason: "invalidPeriod" }
  const now = Date.now()
  const fromMs = periodStart(period, now)
  const rows = (await readRows(fromMs)).filter((r) => !r.sourceId && r.imported !== true)

  const findings = runDetectors({ rows, fromMs, toMs: now })
  return {
    ok: true,
    period,
    // The action is stripped: an external agent may READ that a fix exists,
    // and may not learn the settings key or the value to write. Applying stays
    // a decision the user makes in Cognia's own UI.
    findings: findings.map(({ action, ...rest }) => ({ ...rest, hasAction: Boolean(action) })),
  }
}

/** Total known spend in a set of rows. Exported for the server layer's summaries. */
export function knownSpendOf(rows: readonly SessionUsageRow[]): number {
  let total = 0
  for (const row of rows) {
    const cost = effectiveCostUsdDetailed(row)
    if (cost.known) total += cost.cost
  }
  return total
}
