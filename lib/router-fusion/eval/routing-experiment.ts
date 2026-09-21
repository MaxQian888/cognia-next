/**
 * The routing experiment (ADR-0188 D12/D28, B6): accepted cost, a trained and
 * calibrated learned router, and the promotion gate that decides whether it may
 * ever act.
 *
 * All the mathematics lives in `@cognia/eval-core`'s `routing/*` — grouped
 * time-shifted splits, logistic heads, independent Platt calibration, sealed
 * manifests and the grouped bootstrap. This module is the host's part: it turns
 * stored samples into those calls, and it is where the two acceptance rules
 * this batch is judged on are enforced.
 *
 * **EVAL-03 — every cost in the numerator, only accepted runs in the
 * denominator.** `acceptedCost` is handed EVERY sample, including the degraded,
 * failed, cancelled and refused ones, and it divides by the accepted count
 * alone. A report never quietly drops the runs that spent money without
 * producing an accepted answer, because those are exactly the runs a cheaper
 * router is supposed to avoid.
 *
 * **EVAL-04 — a simulated report claims nothing.** A set of simulated samples
 * produces a report labelled `simulated`, carrying a disclaimer, with
 * `claims.quality` and `claims.costSavingMicrousd` both null no matter how
 * favourable the numbers look. A mixed set is refused outright.
 *
 * **Why the gate usually refuses.** Comparing two routing policies on a log is
 * a replay (off-policy) estimate, and it is only identifiable when the log
 * carries randomization: with a deterministic logging policy both arms collapse
 * onto the same rows and any "saving" is an artefact of the slice, not a causal
 * effect. So when every sample was logged with propensity 1 the gate answers
 * `DETERMINISTIC_LOGGING` and promotes nothing. That is not a limitation to be
 * worked around; it is the honest answer until an exploration arm exists.
 */

import {
  acceptedCost,
  groupedBootstrapGate,
  loadRoutingPredictor,
  publishRoutingPredictor,
  trainRoutingPredictor,
  type AcceptedCostSummary,
  type GroupedBootstrapGateResult,
  type PromotionObservation,
  type RoutingPredictor,
  type RoutingPredictorManifest,
  type RoutingSplitReport,
  type WithheldRoutingHead,
} from "@cognia/eval-core"

import type { FusionRoutingSampleRow } from "../db/types"
import {
  ROUTING_FEATURE_NAMES,
  ROUTING_FEATURES_VERSION,
  sampleSetLabel,
  toCostObservation,
  toTrainingSample,
} from "./routing-sample"

export const ROUTING_EXPERIMENT_SCHEMA = "cognia.routing-experiment/v1" as const

export const SIMULATED_ROUTING_DISCLAIMER =
  "SIMULATED: every sample in this report was generated deterministically from a seed. No model was called, no provider was reached and no money was spent, so the report makes no claim about real quality, cost or savings (EVAL-04)."
export const LIVE_ROUTING_DISCLAIMER =
  "LIVE: every sample is a run this device really made, labelled by its own result and costed from the Router + Fusion ledger."

export function routingDisclaimerFor(label: "live" | "simulated"): string {
  return label === "simulated" ? SIMULATED_ROUTING_DISCLAIMER : LIVE_ROUTING_DISCLAIMER
}

export interface ActionCostRow {
  actionId: string
  actionHash: string
  /** Mean actual spend of the samples of this action, integer microusd. */
  meanCostMicrousd: number
  sampleCount: number
}

/** Mean observed cost per action, by action hash. The learned policy prices actions with it. */
export function actionCostTable(
  rows: readonly FusionRoutingSampleRow[]
): Map<string, ActionCostRow> {
  const totals = new Map<string, { actionId: string; cost: number; count: number }>()
  for (const row of rows) {
    const entry = totals.get(row.actionHash) ?? { actionId: row.actionId, cost: 0, count: 0 }
    entry.cost += row.costMicrousd
    entry.count += 1
    totals.set(row.actionHash, entry)
  }
  const table = new Map<string, ActionCostRow>()
  for (const [actionHash, entry] of totals) {
    table.set(actionHash, {
      actionId: entry.actionId,
      actionHash,
      meanCostMicrousd: Math.round(entry.cost / entry.count),
      sampleCount: entry.count,
    })
  }
  return table
}

export interface LearnedRoutingChoice {
  actionId: string
  actionHash: string
  pPass: number
  /** `mean cost / p_pass`: the accepted cost the head predicts for this action. */
  expectedCostPerAcceptedMicrousd: number
  inDistribution: boolean
}

/**
 * What the learned router would choose for one request.
 *
 * The objective is the metric the gate judges on: the action with the lowest
 * predicted cost per ACCEPTED run — mean observed spend divided by the head's
 * calibrated probability of acceptance. No hand-tuned quality/cost weight, and
 * an action whose head says it will not be accepted prices itself out on its
 * own. Actions whose features fall outside the head's training range are
 * skipped; if that leaves nothing, the learned router has no opinion and the
 * caller keeps the rules decision.
 */
export function learnedRoutingChoice(
  predictor: RoutingPredictor,
  features: readonly number[],
  costs: ReadonlyMap<string, ActionCostRow>
): LearnedRoutingChoice | null {
  let best: LearnedRoutingChoice | null = null
  for (const actionHash of [...predictor.actionHashes].sort()) {
    const cost = costs.get(actionHash)
    if (!cost) continue
    const prediction = predictor.predict({ actionId: cost.actionId, actionHash }, features)
    if (!prediction || !prediction.inDistribution || prediction.pPass <= 0) continue
    const expected = cost.meanCostMicrousd / prediction.pPass
    if (
      best === null ||
      expected < best.expectedCostPerAcceptedMicrousd ||
      (expected === best.expectedCostPerAcceptedMicrousd && cost.actionId < best.actionId)
    ) {
      best = {
        actionId: cost.actionId,
        actionHash,
        pPass: prediction.pPass,
        expectedCostPerAcceptedMicrousd: expected,
        inDistribution: prediction.inDistribution,
      }
    }
  }
  return best
}

export type RoutingGateRefusal = "DETERMINISTIC_LOGGING" | "NO_PREDICTOR"

export interface RoutingPromotionGateResult {
  /** Null when the comparison could not be attempted at all. */
  gate: GroupedBootstrapGateResult | null
  passed: boolean
  /** Why no comparison was attempted; empty when `gate` is set. */
  refusals: RoutingGateRefusal[]
  /** Samples whose logged action the learned router would also have chosen. */
  candidateMatched: number
  /** Samples whose logged action the rules router would also have chosen. */
  baselineMatched: number
  /** Samples logged with propensity 1: a deterministic decision, not a draw. */
  deterministicSamples: number
}

/**
 * Replay arms for the bootstrap gate: each policy keeps the logged samples it
 * would itself have chosen (Li et al.'s replay estimator), and the gate pairs
 * them by group.
 */
export function replayPromotionObservations(
  rows: readonly FusionRoutingSampleRow[],
  predictor: RoutingPredictor,
  costs: ReadonlyMap<string, ActionCostRow>
): { observations: PromotionObservation[]; candidateMatched: number; baselineMatched: number } {
  const observations: PromotionObservation[] = []
  let candidateMatched = 0
  let baselineMatched = 0
  for (const row of rows) {
    if (row.baselineActionId === row.actionId) {
      baselineMatched += 1
      observations.push({
        groupId: row.groupId,
        arm: "baseline",
        costMicrousd: row.costMicrousd,
        accepted: row.accepted,
      })
    }
    const choice = learnedRoutingChoice(predictor, row.features, costs)
    if (choice && choice.actionId === row.actionId) {
      candidateMatched += 1
      observations.push({
        groupId: row.groupId,
        arm: "candidate",
        costMicrousd: row.costMicrousd,
        accepted: row.accepted,
      })
    }
  }
  return { observations, candidateMatched, baselineMatched }
}

export interface RoutingGateOptions {
  seed: number
  iterations?: number
  confidenceLevel?: number
  minGroups?: number
  maxCostPerAcceptedDeltaMicrousd?: number
  minPassRateDelta?: number
}

/**
 * Decide whether the learned router may be promoted over the rules router.
 *
 * Refuses before the bootstrap when the log carries no randomization: with
 * every sample logged deterministically the candidate arm is a subset of the
 * baseline arm chosen by the very policy being judged, and the delta measures
 * which slice the candidate likes, not what it would save.
 */
export function routingPromotionGate(
  rows: readonly FusionRoutingSampleRow[],
  predictor: RoutingPredictor | null,
  costs: ReadonlyMap<string, ActionCostRow>,
  options: RoutingGateOptions
): RoutingPromotionGateResult {
  const deterministicSamples = rows.filter((row) => row.propensity >= 1).length
  if (!predictor) {
    return {
      gate: null,
      passed: false,
      refusals: ["NO_PREDICTOR"],
      candidateMatched: 0,
      baselineMatched: 0,
      deterministicSamples,
    }
  }
  if (rows.length > 0 && deterministicSamples === rows.length) {
    return {
      gate: null,
      passed: false,
      refusals: ["DETERMINISTIC_LOGGING"],
      candidateMatched: 0,
      baselineMatched: 0,
      deterministicSamples,
    }
  }
  const randomized = rows.filter((row) => row.propensity < 1)
  const { observations, candidateMatched, baselineMatched } = replayPromotionObservations(
    randomized,
    predictor,
    costs
  )
  const gate = groupedBootstrapGate(observations, {
    seed: options.seed,
    ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
    ...(options.confidenceLevel === undefined ? {} : { confidenceLevel: options.confidenceLevel }),
    ...(options.minGroups === undefined ? {} : { minGroups: options.minGroups }),
    ...(options.maxCostPerAcceptedDeltaMicrousd === undefined
      ? {}
      : { maxCostPerAcceptedDeltaMicrousd: options.maxCostPerAcceptedDeltaMicrousd }),
    ...(options.minPassRateDelta === undefined
      ? {}
      : { minPassRateDelta: options.minPassRateDelta }),
  })
  return {
    gate,
    passed: gate.passed,
    refusals: [],
    candidateMatched,
    baselineMatched,
    deterministicSamples,
  }
}

export interface RoutingActionCostSummary extends AcceptedCostSummary {
  actionId: string
  actionHash: string
}

export interface RoutingExperimentHeadReport {
  actionId: string
  actionHash: string
  calibrated: boolean
  publishable: boolean
  withheldReasons: string[]
  trainingSamples: number
  calibrationSamples: number
  testSamples: number
  /** Brier score of the calibrated head on the test window; null when it has none. */
  testBrier: number | null
  testExpectedCalibrationError: number | null
}

export interface RoutingExperimentReport {
  schema: typeof ROUTING_EXPERIMENT_SCHEMA
  version: 1
  label: "live" | "simulated"
  disclaimer: string
  /**
   * What this report is willing to assert. Both members are null for a
   * simulated report and for any report whose gate did not pass (EVAL-04).
   */
  claims: { quality: string | null; costSavingMicrousd: number | null }
  createdAt: string
  featuresVersion: string
  sampleCount: number
  /** EVAL-03: every sample's cost, divided by the accepted ones alone. */
  acceptedCost: AcceptedCostSummary
  byAction: RoutingActionCostSummary[]
  split: RoutingSplitReport
  heads: RoutingExperimentHeadReport[]
  training: { manifestSha256: string }
  publication:
    | { status: "published"; manifestSha256: string; withheldHeads: WithheldRoutingHead[] }
    | {
        status: "refused"
        reason: string
        problems: string[]
        withheldHeads: WithheldRoutingHead[]
      }
  gate: RoutingPromotionGateResult
  /** Everything a reader must know before believing a number above. */
  caveats: string[]
}

export interface RoutingExperimentResult {
  report: RoutingExperimentReport
  trainingManifest: RoutingPredictorManifest
  publishedManifest: RoutingPredictorManifest | null
}

export interface RunRoutingExperimentOptions {
  /** ISO timestamp written into the manifests and the report. */
  createdAt: string
  /** Seeds the calibration draw and the bootstrap; the whole run is a pure function of it. */
  seed: number
  gate?: Omit<RoutingGateOptions, "seed">
  /** Bootstrap replicates; lowered by tests, never by the product. */
  iterations?: number
}

function acceptedCostByAction(rows: readonly FusionRoutingSampleRow[]): RoutingActionCostSummary[] {
  const byHash = new Map<string, { actionId: string; rows: FusionRoutingSampleRow[] }>()
  for (const row of rows) {
    const entry = byHash.get(row.actionHash) ?? { actionId: row.actionId, rows: [] }
    entry.rows.push(row)
    byHash.set(row.actionHash, entry)
  }
  return [...byHash.entries()]
    .map(([actionHash, entry]) => ({
      actionId: entry.actionId,
      actionHash,
      ...acceptedCost(entry.rows.map(toCostObservation)),
    }))
    .sort((left, right) => left.actionId.localeCompare(right.actionId))
}

/**
 * Train, calibrate, publish and judge one learned router over a stored sample
 * set. Pure: the same rows, `createdAt` and seed always give the same report.
 */
export async function runRoutingExperiment(
  rows: readonly FusionRoutingSampleRow[],
  options: RunRoutingExperimentOptions
): Promise<RoutingExperimentResult> {
  const label = sampleSetLabel(rows)
  if (label === null || rows.length === 0) {
    throw new Error("a routing experiment needs at least one sample")
  }
  const versions = new Set(rows.map((row) => row.featuresVersion))
  if (versions.size > 1) {
    throw new Error(
      `sample set spans feature versions ${[...versions].sort().join(", ")}; train on one encoding`
    )
  }
  const featuresVersion = [...versions][0]
  if (featuresVersion !== ROUTING_FEATURES_VERSION) {
    throw new Error(
      `samples encode ${featuresVersion}; this build encodes ${ROUTING_FEATURES_VERSION}`
    )
  }

  const training = await trainRoutingPredictor(rows.map(toTrainingSample), {
    featuresVersion,
    featureNames: ROUTING_FEATURE_NAMES,
    createdAt: options.createdAt,
    seed: options.seed,
  })
  const published = await publishRoutingPredictor(training.manifest, {
    publishedAt: options.createdAt,
  })

  let predictor: RoutingPredictor | null = null
  if (published.status === "published") {
    const loaded = await loadRoutingPredictor(published.manifest, {
      featuresVersion,
      featureNames: ROUTING_FEATURE_NAMES,
    })
    if (loaded.status === "loaded") predictor = loaded.predictor
  }

  // The gate judges the test window only: the rows the heads were neither
  // fitted nor calibrated on (EVAL-01).
  const testIds = new Set(training.split.test.map((sample) => sample.sampleId))
  const testRows = rows.filter((row) => testIds.has(row.sampleId))
  const costs = actionCostTable(rows)
  const gate = routingPromotionGate(testRows, predictor, costs, {
    seed: options.seed,
    ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
    ...(options.gate ?? {}),
  })

  const caveats: string[] = []
  if (label === "simulated") caveats.push(SIMULATED_ROUTING_DISCLAIMER)
  if (gate.refusals.includes("DETERMINISTIC_LOGGING")) {
    caveats.push(
      "Every sample was logged by the deterministic rules router (propensity 1), so no replay comparison is identifiable and nothing can be promoted on this evidence."
    )
  }
  if (gate.refusals.includes("NO_PREDICTOR")) {
    caveats.push("No head could be published, so there was no candidate router to compare against.")
  }
  if (gate.gate && gate.gate.verdict === "inconclusive") {
    caveats.push(
      `The bootstrap was inconclusive (${gate.gate.reasons.join(", ") || "no reason given"}); the learned router stays off.`
    )
  }
  if (rows.some((row) => row.costStatus !== "actual")) {
    caveats.push(
      "Some samples carry an estimated rather than a settled bill; their cost is an estimate in the numerator."
    )
  }

  // EVAL-04: a simulated set never yields a claim, whatever the gate said.
  const claimsAllowed = label === "live" && gate.passed && gate.gate !== null
  const report: RoutingExperimentReport = {
    schema: ROUTING_EXPERIMENT_SCHEMA,
    version: 1,
    label,
    disclaimer: routingDisclaimerFor(label),
    claims: {
      quality: claimsAllowed
        ? "pass rate non-inferior to the rules router at the configured confidence"
        : null,
      costSavingMicrousd:
        claimsAllowed &&
        gate.gate?.costPerAcceptedDeltaMicrousd.high !== null &&
        gate.gate?.costPerAcceptedDeltaMicrousd.high !== undefined
          ? -gate.gate.costPerAcceptedDeltaMicrousd.high
          : null,
    },
    createdAt: options.createdAt,
    featuresVersion,
    sampleCount: rows.length,
    acceptedCost: acceptedCost(rows.map(toCostObservation)),
    byAction: acceptedCostByAction(rows),
    split: training.manifest.split,
    heads: training.manifest.heads.map((head) => ({
      actionId: head.actionId,
      actionHash: head.actionHash,
      calibrated: head.calibrated,
      publishable: head.publishable,
      withheldReasons: [...head.withheldReasons],
      trainingSamples: head.counts.training.samples,
      calibrationSamples: head.counts.calibration.samples,
      testSamples: head.counts.test.samples,
      testBrier: head.metrics.test?.calibrated?.brier ?? null,
      testExpectedCalibrationError: head.metrics.test?.calibrated?.ece ?? null,
    })),
    training: { manifestSha256: training.manifest.sha256 },
    publication:
      published.status === "published"
        ? {
            status: "published",
            manifestSha256: published.manifest.sha256,
            withheldHeads: published.withheldHeads,
          }
        : {
            status: "refused",
            reason: published.reason,
            problems: published.problems,
            withheldHeads: published.withheldHeads,
          },
    gate,
    caveats,
  }

  return {
    report,
    trainingManifest: training.manifest,
    publishedManifest: published.status === "published" ? published.manifest : null,
  }
}
