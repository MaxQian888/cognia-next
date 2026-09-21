/**
 * Accepted-cost metric and the grouped bootstrap promotion gate (DESIGN §7.3,
 * §19; ADR-0188 D12, EVAL-03).
 *
 * Accepted cost is `sum(all actual costs) / count(accepted runs)`: every run's
 * spend — degraded, failed, cancelled, unknown, refused — stays in the
 * numerator, and only independently accepted runs enter the denominator. With
 * zero accepted runs the figure is undefined (`null`), never 0.
 *
 * The promotion gate compares a candidate routing policy against a paired
 * baseline on the same groups (tasks / sessions). It resamples WHOLE GROUPS
 * with replacement — turns of one session are never treated as independent —
 * and recomputes both arms' accepted cost and pass rate on each replicate.
 * A candidate passes only when, at the one-sided confidence level:
 *
 *   - its cost per accepted run is lower: the upper bound of
 *     (candidate − baseline) is below `maxCostPerAcceptedDeltaMicrousd`
 *     (default 0), and
 *   - its pass rate is non-inferior: the lower bound of
 *     (candidate − baseline) is at least `minPassRateDelta` (default −1
 *     percentage point).
 *
 * Too few paired groups, an arm with nothing accepted, or any replicate in
 * which an arm accepted nothing make the verdict `inconclusive`, which never
 * promotes. The seeded resampling is independent of input order.
 */

import { createSeededRandom } from "./grouped-split"
import { RoutingMathError } from "./logistic"

export interface CostObservation {
  /** Actual spend of the run, integer microusd. */
  costMicrousd: number
  /**
   * True only for an independently accepted result. Degraded, unknown,
   * failed, cancelled and refused runs are false — and their cost still counts.
   */
  accepted: boolean
}

export interface AcceptedCostSummary {
  runCount: number
  acceptedCount: number
  totalCostMicrousd: number
  /** totalCost / acceptedCount; null when nothing was accepted. */
  costPerAcceptedMicrousd: number | null
  /** acceptedCount / runCount; null when there were no runs. */
  passRate: number | null
}

function checkObservation(observation: CostObservation, index: number): void {
  const cost = observation.costMicrousd
  if (!Number.isSafeInteger(cost) || cost < 0) {
    throw new RoutingMathError(
      "INVALID_COST",
      `observation ${index}: cost must be a non-negative integer microusd, got ${cost}`
    )
  }
  if (typeof observation.accepted !== "boolean") {
    throw new RoutingMathError("INVALID_LABEL", `observation ${index}: accepted must be a boolean`)
  }
}

/** EVAL-03 math: all cost in the numerator, only accepted runs in the denominator. */
export function acceptedCost(observations: Iterable<CostObservation>): AcceptedCostSummary {
  let runCount = 0
  let acceptedCount = 0
  let totalCostMicrousd = 0
  for (const observation of observations) {
    checkObservation(observation, runCount)
    runCount++
    totalCostMicrousd += observation.costMicrousd
    if (observation.accepted) acceptedCount++
  }
  if (!Number.isSafeInteger(totalCostMicrousd)) {
    throw new RoutingMathError("INVALID_COST", "total cost exceeds the safe integer range")
  }
  return {
    runCount,
    acceptedCount,
    totalCostMicrousd,
    costPerAcceptedMicrousd: acceptedCount === 0 ? null : totalCostMicrousd / acceptedCount,
    passRate: runCount === 0 ? null : acceptedCount / runCount,
  }
}

export type PromotionArm = "candidate" | "baseline"

export interface PromotionObservation extends CostObservation {
  /** Task / session the run belongs to; the resampling unit. */
  groupId: string
  arm: PromotionArm
}

export interface GroupedBootstrapGateOptions {
  seed: number
  /** Bootstrap replicates. Default 10 000. */
  iterations?: number
  /** One-sided confidence level of each bound. Default 0.95. */
  confidenceLevel?: number
  /** Paired groups required before any verdict but `inconclusive`. Default 30. */
  minGroups?: number
  /** The cost-delta upper bound must be strictly below this (microusd per accepted run). Default 0. */
  maxCostPerAcceptedDeltaMicrousd?: number
  /** The pass-rate-delta lower bound must be at least this. Default −0.01. */
  minPassRateDelta?: number
}

export const DEFAULT_BOOTSTRAP_GATE_OPTIONS = {
  iterations: 10_000,
  confidenceLevel: 0.95,
  minGroups: 30,
  maxCostPerAcceptedDeltaMicrousd: 0,
  minPassRateDelta: -0.01,
} as const

export type PromotionGateReason =
  | "INSUFFICIENT_GROUPS"
  | "NO_ACCEPTED_CANDIDATE"
  | "NO_ACCEPTED_BASELINE"
  | "UNDEFINED_REPLICATES"
  | "COST_NOT_REDUCED"
  | "PASS_RATE_BELOW_MARGIN"

export interface GateDeltaInterval {
  /** Candidate minus baseline on the observed groups. */
  estimate: number | null
  /** One-sided lower bound at `confidenceLevel`. */
  low: number | null
  /** One-sided upper bound at `confidenceLevel`. */
  high: number | null
}

export interface GroupedBootstrapGateResult {
  verdict: "pass" | "fail" | "inconclusive"
  passed: boolean
  reasons: PromotionGateReason[]
  seed: number
  iterations: number
  confidenceLevel: number
  /** Groups with observations in both arms — the resampling units. */
  pairedGroupCount: number
  /** Groups with only one arm; left out of the comparison. */
  unpairedGroupCount: number
  candidate: AcceptedCostSummary
  baseline: AcceptedCostSummary
  costPerAcceptedDeltaMicrousd: GateDeltaInterval
  passRateDelta: GateDeltaInterval
  /** Replicates where an arm accepted nothing, so its accepted cost was undefined. */
  undefinedReplicates: number
  thresholds: { maxCostPerAcceptedDeltaMicrousd: number; minPassRateDelta: number }
}

interface ArmTotals {
  runs: number
  accepted: number
  cost: number
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * sorted.length)))
  return sorted[index]
}

function summary(totals: ArmTotals): AcceptedCostSummary {
  return {
    runCount: totals.runs,
    acceptedCount: totals.accepted,
    totalCostMicrousd: totals.cost,
    costPerAcceptedMicrousd: totals.accepted === 0 ? null : totals.cost / totals.accepted,
    passRate: totals.runs === 0 ? null : totals.accepted / totals.runs,
  }
}

function resolveGateOptions(options: GroupedBootstrapGateOptions) {
  const resolved = {
    seed: options.seed,
    iterations: options.iterations ?? DEFAULT_BOOTSTRAP_GATE_OPTIONS.iterations,
    confidenceLevel: options.confidenceLevel ?? DEFAULT_BOOTSTRAP_GATE_OPTIONS.confidenceLevel,
    minGroups: options.minGroups ?? DEFAULT_BOOTSTRAP_GATE_OPTIONS.minGroups,
    maxCostPerAcceptedDeltaMicrousd:
      options.maxCostPerAcceptedDeltaMicrousd ??
      DEFAULT_BOOTSTRAP_GATE_OPTIONS.maxCostPerAcceptedDeltaMicrousd,
    minPassRateDelta: options.minPassRateDelta ?? DEFAULT_BOOTSTRAP_GATE_OPTIONS.minPassRateDelta,
  }
  if (!Number.isInteger(resolved.seed)) {
    throw new RoutingMathError("INVALID_OPTION", `seed must be an integer, got ${resolved.seed}`)
  }
  if (!Number.isInteger(resolved.iterations) || resolved.iterations < 1) {
    throw new RoutingMathError("INVALID_OPTION", "iterations must be a positive integer")
  }
  if (!(resolved.confidenceLevel > 0.5 && resolved.confidenceLevel < 1)) {
    throw new RoutingMathError("INVALID_OPTION", "confidenceLevel must be within (0.5, 1)")
  }
  if (!Number.isInteger(resolved.minGroups) || resolved.minGroups < 1) {
    throw new RoutingMathError("INVALID_OPTION", "minGroups must be a positive integer")
  }
  if (!Number.isFinite(resolved.maxCostPerAcceptedDeltaMicrousd)) {
    throw new RoutingMathError("INVALID_OPTION", "maxCostPerAcceptedDeltaMicrousd must be finite")
  }
  if (!(resolved.minPassRateDelta >= -1 && resolved.minPassRateDelta <= 1)) {
    throw new RoutingMathError("INVALID_OPTION", "minPassRateDelta must be within [-1, 1]")
  }
  return resolved
}

/**
 * Decide whether a candidate routing policy may be promoted over its paired
 * baseline. Pure and seeded: the same observations (in any order) and seed
 * always give the same verdict and interval.
 */
export function groupedBootstrapGate(
  observations: readonly PromotionObservation[],
  options: GroupedBootstrapGateOptions
): GroupedBootstrapGateResult {
  const resolved = resolveGateOptions(options)
  const byGroup = new Map<string, { candidate: ArmTotals; baseline: ArmTotals }>()
  observations.forEach((observation, index) => {
    checkObservation(observation, index)
    if (typeof observation.groupId !== "string" || observation.groupId.length === 0) {
      throw new RoutingMathError("INVALID_SAMPLE", `observation ${index} has no group id`)
    }
    if (observation.arm !== "candidate" && observation.arm !== "baseline") {
      throw new RoutingMathError("INVALID_SAMPLE", `observation ${index} has an unknown arm`)
    }
    let group = byGroup.get(observation.groupId)
    if (!group) {
      group = {
        candidate: { runs: 0, accepted: 0, cost: 0 },
        baseline: { runs: 0, accepted: 0, cost: 0 },
      }
      byGroup.set(observation.groupId, group)
    }
    const arm = group[observation.arm]
    arm.runs++
    arm.cost += observation.costMicrousd
    if (observation.accepted) arm.accepted++
  })

  const paired = [...byGroup.entries()]
    .filter(([, group]) => group.candidate.runs > 0 && group.baseline.runs > 0)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, group]) => group)
  const candidateTotals: ArmTotals = { runs: 0, accepted: 0, cost: 0 }
  const baselineTotals: ArmTotals = { runs: 0, accepted: 0, cost: 0 }
  for (const group of paired) {
    candidateTotals.runs += group.candidate.runs
    candidateTotals.accepted += group.candidate.accepted
    candidateTotals.cost += group.candidate.cost
    baselineTotals.runs += group.baseline.runs
    baselineTotals.accepted += group.baseline.accepted
    baselineTotals.cost += group.baseline.cost
  }
  if (!Number.isSafeInteger(candidateTotals.cost) || !Number.isSafeInteger(baselineTotals.cost)) {
    throw new RoutingMathError("INVALID_COST", "total cost exceeds the safe integer range")
  }
  const candidate = summary(candidateTotals)
  const baseline = summary(baselineTotals)

  const reasons: PromotionGateReason[] = []
  if (paired.length < resolved.minGroups) reasons.push("INSUFFICIENT_GROUPS")
  if (paired.length > 0 && candidate.acceptedCount === 0) reasons.push("NO_ACCEPTED_CANDIDATE")
  if (paired.length > 0 && baseline.acceptedCount === 0) reasons.push("NO_ACCEPTED_BASELINE")

  const costEstimate =
    candidate.costPerAcceptedMicrousd !== null && baseline.costPerAcceptedMicrousd !== null
      ? candidate.costPerAcceptedMicrousd - baseline.costPerAcceptedMicrousd
      : null
  const passEstimate =
    candidate.passRate !== null && baseline.passRate !== null
      ? candidate.passRate - baseline.passRate
      : null

  const costDelta: GateDeltaInterval = { estimate: costEstimate, low: null, high: null }
  const passDelta: GateDeltaInterval = { estimate: passEstimate, low: null, high: null }
  let undefinedReplicates = 0

  if (paired.length > 0) {
    const random = createSeededRandom(resolved.seed)
    const costReplicates: number[] = []
    const passReplicates = new Array<number>(resolved.iterations)
    const size = paired.length
    for (let iteration = 0; iteration < resolved.iterations; iteration++) {
      let cRuns = 0
      let cAccepted = 0
      let cCost = 0
      let bRuns = 0
      let bAccepted = 0
      let bCost = 0
      for (let draw = 0; draw < size; draw++) {
        const group = paired[Math.floor(random() * size)]
        cRuns += group.candidate.runs
        cAccepted += group.candidate.accepted
        cCost += group.candidate.cost
        bRuns += group.baseline.runs
        bAccepted += group.baseline.accepted
        bCost += group.baseline.cost
      }
      passReplicates[iteration] = cAccepted / cRuns - bAccepted / bRuns
      if (cAccepted === 0 || bAccepted === 0) undefinedReplicates++
      else costReplicates.push(cCost / cAccepted - bCost / bAccepted)
    }
    const tail = 1 - resolved.confidenceLevel
    passReplicates.sort((left, right) => left - right)
    passDelta.low = percentile(passReplicates, tail)
    passDelta.high = percentile(passReplicates, 1 - tail)
    if (undefinedReplicates === 0) {
      costReplicates.sort((left, right) => left - right)
      costDelta.low = percentile(costReplicates, tail)
      costDelta.high = percentile(costReplicates, 1 - tail)
    } else if (
      !reasons.includes("NO_ACCEPTED_CANDIDATE") &&
      !reasons.includes("NO_ACCEPTED_BASELINE")
    ) {
      reasons.push("UNDEFINED_REPLICATES")
    }
  }

  let verdict: GroupedBootstrapGateResult["verdict"] = "inconclusive"
  if (reasons.length === 0) {
    // Both bounds exist here: paired groups, accepted runs in both arms, and
    // no undefined replicate.
    const costHigh = costDelta.high
    const passLow = passDelta.low
    if (costHigh === null || costHigh >= resolved.maxCostPerAcceptedDeltaMicrousd) {
      reasons.push("COST_NOT_REDUCED")
    }
    if (passLow === null || passLow < resolved.minPassRateDelta) {
      reasons.push("PASS_RATE_BELOW_MARGIN")
    }
    verdict = reasons.length === 0 ? "pass" : "fail"
  }
  return {
    verdict,
    passed: verdict === "pass",
    reasons,
    seed: resolved.seed,
    iterations: resolved.iterations,
    confidenceLevel: resolved.confidenceLevel,
    pairedGroupCount: paired.length,
    unpairedGroupCount: byGroup.size - paired.length,
    candidate,
    baseline,
    costPerAcceptedDeltaMicrousd: costDelta,
    passRateDelta: passDelta,
    undefinedReplicates,
    thresholds: {
      maxCostPerAcceptedDeltaMicrousd: resolved.maxCostPerAcceptedDeltaMicrousd,
      minPassRateDelta: resolved.minPassRateDelta,
    },
  }
}
