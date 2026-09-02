// Optimization findings (ADR-0165 Phase 4).
//
// A finding is a claim about the user's own spend, so the shape makes the
// claim's provenance non-optional:
//
//   * `detector` + `detectorVersion` say who said it and which revision, so a
//     detector change can retire its own old verdicts without touching the
//     ones beside them.
//   * `basis` says whether the impact was MEASURED from the ledger or
//     ESTIMATED from a model of what would happen. These are different kinds
//     of number and a UI that renders them identically is lying.
//   * `evidence` carries the counts the claim rests on. A finding drawn from
//     four turns and one drawn from four hundred should not look alike.
//   * `class` says what the user can do: `fix` has a reversible action,
//     `habit` is a change in how they work, `info` is context with no action.
//
// Every detector here is pure and deterministic over ledger rows. None asks a
// model. A recommendation that costs money to produce, and that returns a
// different answer on a re-run over identical data, is not something anyone
// should act on.

import type { SessionUsageRow } from "@/lib/db/session-usage"

import { analyzeWorkUnit, groupWorkUnits } from "../work-unit-analysis"
import { effectiveCostUsdDetailed, type PricingResolver } from "../session-analytics"
import { resolveModelPricingUsd } from "../pricing"

export const FINDING_SCHEMA_VERSION = 1

/** What the user can do about a finding. */
export type FindingClass = "fix" | "habit" | "info"

/** Where the impact figure came from. */
export type FindingBasis = "measured" | "estimated"

export type FindingSeverity = "high" | "medium" | "low"

/** Stable detector ids. New detectors append. */
export type DetectorId = "cacheColdStarts" | "retrySpend" | "unpricedSpend" | "runawaySession"

export interface FindingEvidence {
  /** Ledger rows the claim was computed over. */
  turns: number
  /** Sessions or work units involved. */
  units: number
  /** Days the window spans. */
  days: number
  /** Turns in the window whose cost could not be resolved. */
  unpricedTurns: number
}

export interface OptimizationFindingV1 {
  schemaVersion: typeof FINDING_SCHEMA_VERSION
  /** Stable id, so the same finding across runs is one row, not many. */
  id: string
  detector: DetectorId
  detectorVersion: number
  class: FindingClass
  severity: FindingSeverity
  basis: FindingBasis
  /**
   * 0-1. Low confidence is not a reason to hide a finding, it is a reason to
   * label it, because the user knows things the detector does not.
   */
  confidence: number
  /** Money the finding is about, over the analyzed window. */
  impactUsd: number
  /** Money a fix would plausibly save. Never larger than `impactUsd`. */
  estimatedSavingUsd: number
  evidence: FindingEvidence
  /** i18n leaf under `usageOptimizer.findings.<detector>.*`. */
  titleKey: string
  bodyKey: string
  /** Values for the i18n message. Numbers and ids only, never free text. */
  params: Record<string, string | number>
  /** Present on `fix` findings: what an action would change. */
  action?: {
    /** Which plane owns the change, and therefore how it is applied. */
    target: "cognia-setting" | "repo-file" | "external-config"
    /** Settings path, repo path, or config id. */
    key: string
    /** Serialized proposed value, for a settings target. */
    proposedValue?: string
  }
}

export interface DetectorInput {
  rows: readonly SessionUsageRow[]
  /** Window bounds, so evidence can report real days rather than row spread. */
  fromMs: number
  toMs: number
  resolve?: PricingResolver
}

const DAY_MS = 86_400_000

function windowDays(input: DetectorInput): number {
  return Math.max(1, Math.round((input.toMs - input.fromMs) / DAY_MS))
}

function totals(rows: readonly SessionUsageRow[], resolve: PricingResolver) {
  let knownCostUsd = 0
  let unpricedTurns = 0
  for (const row of rows) {
    const cost = effectiveCostUsdDetailed(row, resolve)
    if (cost.known) knownCostUsd += cost.cost
    else unpricedTurns += 1
  }
  return { knownCostUsd, unpricedTurns }
}

/* ── Detectors ─────────────────────────────────────────────────────────── */

/**
 * Prompt caching that is not paying off.
 *
 * A low cache-read share across many turns means each turn re-sent a prompt
 * the provider had already seen. The saving estimate is deliberately
 * conservative: it prices only the input tokens that a healthy cache rate
 * would have served as reads, at the standard cache-read discount.
 */
export const CACHE_DETECTOR_VERSION = 1
const HEALTHY_CACHE_RATE = 0.5
const CACHE_READ_DISCOUNT = 0.9

export function detectCacheColdStarts(input: DetectorInput): OptimizationFindingV1 | null {
  const resolve = input.resolve ?? resolveModelPricingUsd
  const rows = input.rows
  if (rows.length < 20) return null

  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  for (const row of rows) {
    inputTokens += row.inputTokens ?? 0
    cacheReadTokens += row.cacheReadTokens ?? 0
    cacheCreationTokens += row.cacheCreationTokens ?? 0
  }
  const prompt = inputTokens + cacheReadTokens + cacheCreationTokens
  if (prompt === 0) return null
  const rate = cacheReadTokens / prompt
  if (rate >= HEALTHY_CACHE_RATE) return null

  const { knownCostUsd, unpricedTurns } = totals(rows, resolve)
  if (knownCostUsd <= 0) return null

  // Share of spend attributable to fresh input, scaled by how far the cache
  // rate falls short of healthy. An upper bound on what caching could return.
  const freshShare = inputTokens / prompt
  const shortfall = (HEALTHY_CACHE_RATE - rate) / HEALTHY_CACHE_RATE
  const estimatedSavingUsd = knownCostUsd * freshShare * shortfall * CACHE_READ_DISCOUNT

  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id: "cacheColdStarts",
    detector: "cacheColdStarts",
    detectorVersion: CACHE_DETECTOR_VERSION,
    class: "habit",
    severity: rate < 0.2 ? "high" : "medium",
    basis: "estimated",
    confidence: rows.length >= 100 ? 0.8 : 0.55,
    impactUsd: knownCostUsd,
    estimatedSavingUsd: Math.min(estimatedSavingUsd, knownCostUsd),
    evidence: {
      turns: rows.length,
      units: groupWorkUnits(rows).size,
      days: windowDays(input),
      unpricedTurns,
    },
    titleKey: "cacheColdStarts.title",
    bodyKey: "cacheColdStarts.body",
    params: { ratePct: Math.round(rate * 100), targetPct: HEALTHY_CACHE_RATE * 100 },
  }
}

/**
 * Spend on attempts that were superseded.
 *
 * MEASURED, not estimated: the ledger records each attempt, so the cost of
 * every superseded one is a fact rather than a model. Only reported when the
 * rows actually carry attempt identity, because otherwise the number would be
 * zero for a reason that has nothing to do with the user's retry rate.
 */
export const RETRY_DETECTOR_VERSION = 1
const RETRY_SHARE_THRESHOLD = 0.15

export function detectRetrySpend(input: DetectorInput): OptimizationFindingV1 | null {
  const resolve = input.resolve ?? resolveModelPricingUsd
  const units = groupWorkUnits(input.rows)
  let retryCostUsd = 0
  let measurable = 0
  let logicalTurns = 0
  for (const rows of units.values()) {
    const metrics = analyzeWorkUnit({ rows, resolve })
    if (metrics.retryCostUsd == null) continue
    measurable += 1
    retryCostUsd += metrics.retryCostUsd
    logicalTurns += metrics.logicalTurns ?? 0
  }
  if (measurable === 0) return null

  const { knownCostUsd, unpricedTurns } = totals(input.rows, resolve)
  if (knownCostUsd <= 0) return null
  const share = retryCostUsd / knownCostUsd
  if (share < RETRY_SHARE_THRESHOLD) return null

  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id: "retrySpend",
    detector: "retrySpend",
    detectorVersion: RETRY_DETECTOR_VERSION,
    class: "habit",
    severity: share > 0.3 ? "high" : "medium",
    // The money is measured. Whether changing anything recovers it is not,
    // which is why the saving is a fraction of it rather than all of it.
    basis: "measured",
    confidence: measurable >= 5 ? 0.75 : 0.5,
    impactUsd: retryCostUsd,
    estimatedSavingUsd: retryCostUsd * 0.5,
    evidence: {
      turns: input.rows.length,
      units: measurable,
      days: windowDays(input),
      unpricedTurns,
    },
    titleKey: "retrySpend.title",
    bodyKey: "retrySpend.body",
    params: { sharePct: Math.round(share * 100), logicalTurns },
  }
}

/**
 * Spend the pricing layer could not resolve.
 *
 * An `info` finding, not a fix: the user cannot make a model's price known,
 * but they should know that a chunk of their window is invisible before they
 * treat the headline as the whole bill.
 */
export const UNPRICED_DETECTOR_VERSION = 1
const UNPRICED_SHARE_THRESHOLD = 0.1

export function detectUnpricedSpend(input: DetectorInput): OptimizationFindingV1 | null {
  const resolve = input.resolve ?? resolveModelPricingUsd
  const rows = input.rows
  if (rows.length === 0) return null
  const { knownCostUsd, unpricedTurns } = totals(rows, resolve)
  const share = unpricedTurns / rows.length
  if (share < UNPRICED_SHARE_THRESHOLD) return null

  const models = new Set(
    rows
      .filter((r) => effectiveCostUsdDetailed(r, resolve).known === false)
      .map((r) => r.model)
      .filter((m): m is string => Boolean(m))
  )

  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id: "unpricedSpend",
    detector: "unpricedSpend",
    detectorVersion: UNPRICED_DETECTOR_VERSION,
    class: "info",
    severity: share > 0.4 ? "medium" : "low",
    basis: "measured",
    confidence: 1,
    // The impact is unknown by construction, so it is reported as zero rather
    // than as a guess. The evidence carries the real story.
    impactUsd: 0,
    estimatedSavingUsd: 0,
    evidence: {
      turns: rows.length,
      units: groupWorkUnits(rows).size,
      days: windowDays(input),
      unpricedTurns,
    },
    titleKey: "unpricedSpend.title",
    bodyKey: "unpricedSpend.body",
    params: {
      sharePct: Math.round(share * 100),
      models: models.size,
      knownCostUsd: Math.round(knownCostUsd * 100) / 100,
    },
  }
}

/**
 * One work unit that dominated the window.
 *
 * `info` rather than `fix`, because an expensive task is often exactly the
 * task that was worth doing. What the user gets is visibility, not a verdict.
 */
export const RUNAWAY_DETECTOR_VERSION = 1
const RUNAWAY_SHARE_THRESHOLD = 0.35

export function detectRunawaySession(input: DetectorInput): OptimizationFindingV1 | null {
  const resolve = input.resolve ?? resolveModelPricingUsd
  const { knownCostUsd, unpricedTurns } = totals(input.rows, resolve)
  if (knownCostUsd <= 0) return null
  const units = groupWorkUnits(input.rows)
  if (units.size < 3) return null

  let worst: { key: string; cost: number; turns: number } | null = null
  for (const [key, rows] of units) {
    const cost = totals(rows, resolve).knownCostUsd
    if (!worst || cost > worst.cost) worst = { key, cost, turns: rows.length }
  }
  if (!worst) return null
  const share = worst.cost / knownCostUsd
  if (share < RUNAWAY_SHARE_THRESHOLD) return null

  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id: `runawaySession:${worst.key}`,
    detector: "runawaySession",
    detectorVersion: RUNAWAY_DETECTOR_VERSION,
    class: "info",
    severity: share > 0.6 ? "medium" : "low",
    basis: "measured",
    confidence: 1,
    impactUsd: worst.cost,
    estimatedSavingUsd: 0,
    evidence: {
      turns: input.rows.length,
      units: units.size,
      days: windowDays(input),
      unpricedTurns,
    },
    titleKey: "runawaySession.title",
    bodyKey: "runawaySession.body",
    // The unit key is a run or session id, never a title or a path.
    params: { sharePct: Math.round(share * 100), turns: worst.turns },
  }
}

/** Every detector, in the order findings are reported. */
export const DETECTORS: ReadonlyArray<(input: DetectorInput) => OptimizationFindingV1 | null> = [
  detectRetrySpend,
  detectCacheColdStarts,
  detectRunawaySession,
  detectUnpricedSpend,
]

/**
 * Run every detector over a window.
 *
 * Findings are sorted by what they are worth: severity first, then estimated
 * saving. A detector that throws is skipped rather than sinking the report,
 * because one bad detector must not cost the user the other three.
 */
export function runDetectors(input: DetectorInput): OptimizationFindingV1[] {
  const findings: OptimizationFindingV1[] = []
  for (const detector of DETECTORS) {
    try {
      const finding = detector(input)
      if (finding) findings.push(finding)
    } catch {
      // A detector is an opinion, never a dependency.
    }
  }
  return findings.sort((a, b) => {
    const rank = { high: 2, medium: 1, low: 0 } as const
    if (rank[a.severity] !== rank[b.severity]) return rank[b.severity] - rank[a.severity]
    return b.estimatedSavingUsd - a.estimatedSavingUsd
  })
}
