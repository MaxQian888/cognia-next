/**
 * Independent Platt calibration for routing heads (DESIGN §7.2: "an
 * independent calibration set uses sigmoid calibration; calibration data must
 * be independent of the data the base model was fitted on").
 *
 * The calibrated probability is `σ(slope · score + intercept)` where `score`
 * is the head's uncalibrated log-odds. Fitting follows Platt (1999) with the
 * Lin, Lin & Weng (2007) numerics: targets are smoothed to
 * `(N₊ + 1) / (N₊ + 2)` and `1 / (N₋ + 2)` so a small calibration set cannot
 * produce 0/1 probabilities, and the two-parameter problem is solved with the
 * same deterministic Newton optimizer as the heads (`logistic.ts`).
 *
 * Independence is part of the signature, not a convention: the caller passes
 * the group of every calibration row and the groups the head was fitted on,
 * and any overlap refuses calibration. So do an empty set, a single class, too
 * few rows per class, and a non-positive slope (the head ranks held-out rows
 * backwards). A refused head is `calibrated: false` and is never published as
 * a calibrated predictor (EVAL-02).
 */

import { fitLogisticTargets, logisticSigmoid, RoutingMathError } from "./logistic"

export interface PlattCalibration {
  method: "platt"
  /** Multiplier on the head's log-odds; > 0 for a calibrated head. */
  slope: number
  intercept: number
  sampleCount: number
  positiveCount: number
  negativeCount: number
  /** Smoothed target used for positive rows: (N₊ + 1) / (N₊ + 2). */
  positiveTarget: number
  /** Smoothed target used for negative rows: 1 / (N₋ + 2). */
  negativeTarget: number
  iterations: number
  converged: boolean
  /** Mean log loss of the calibrated probabilities against the hard labels. */
  logLoss: number
}

export type PlattRefusalReason =
  | "NO_CALIBRATION_DATA"
  | "NOT_INDEPENDENT"
  | "SINGLE_CLASS"
  | "INSUFFICIENT_DATA"
  | "NOT_CONVERGED"
  | "NON_POSITIVE_SLOPE"

/** Every refusal, in the order reports list them. */
export const PLATT_REFUSAL_REASONS: readonly PlattRefusalReason[] = [
  "NO_CALIBRATION_DATA",
  "NOT_INDEPENDENT",
  "SINGLE_CLASS",
  "INSUFFICIENT_DATA",
  "NOT_CONVERGED",
  "NON_POSITIVE_SLOPE",
]

export interface PlattIndependence {
  /** The group (session) of each calibration row, aligned with the scores. */
  calibrationGroupIds: readonly string[]
  /** Every group the head was fitted on. */
  fittingGroupIds: Iterable<string>
}

export interface PlattOptions {
  /** Minimum rows of EACH class. Default 1 (both classes present). */
  minPerClass?: number
}

export type PlattFitResult =
  | { calibrated: true; calibration: PlattCalibration }
  | {
      calibrated: false
      reasons: PlattRefusalReason[]
      /** Present when a fit ran but was refused (not converged, non-positive slope). */
      calibration: PlattCalibration | null
      sampleCount: number
      positiveCount: number
      negativeCount: number
    }

function countClasses(labels: readonly boolean[]): { positive: number; negative: number } {
  let positive = 0
  for (let i = 0; i < labels.length; i++) {
    if (typeof labels[i] !== "boolean") {
      throw new RoutingMathError("INVALID_LABEL", `label ${i} must be a boolean`)
    }
    if (labels[i]) positive++
  }
  return { positive, negative: labels.length - positive }
}

/**
 * The data-level reasons a calibration set cannot be used, before any fit:
 * empty, overlapping the fitting groups, single-class, or too small per class.
 * The training pipeline reports these even for heads that never got a model.
 */
export function plattDataRefusals(
  labels: readonly boolean[],
  independence: PlattIndependence,
  options: PlattOptions = {}
): PlattRefusalReason[] {
  const minPerClass = options.minPerClass ?? 1
  if (!Number.isInteger(minPerClass) || minPerClass < 1) {
    throw new RoutingMathError("INVALID_OPTION", `minPerClass must be an integer >= 1`)
  }
  if (independence.calibrationGroupIds.length !== labels.length) {
    throw new RoutingMathError(
      "DIMENSION_MISMATCH",
      `${independence.calibrationGroupIds.length} calibration group ids for ${labels.length} rows`
    )
  }
  if (labels.length === 0) return ["NO_CALIBRATION_DATA"]
  const reasons: PlattRefusalReason[] = []
  const fitting = new Set(independence.fittingGroupIds)
  if (independence.calibrationGroupIds.some((groupId) => fitting.has(groupId))) {
    reasons.push("NOT_INDEPENDENT")
  }
  const { positive, negative } = countClasses(labels)
  if (positive === 0 || negative === 0) reasons.push("SINGLE_CLASS")
  else if (Math.min(positive, negative) < minPerClass) reasons.push("INSUFFICIENT_DATA")
  return reasons
}

/** Calibrated probability for one uncalibrated log-odds score. */
export function applyPlattCalibration(
  calibration: Pick<PlattCalibration, "slope" | "intercept">,
  score: number
): number {
  if (!Number.isFinite(score)) {
    throw new RoutingMathError("NON_FINITE", "calibration score must be a finite number")
  }
  return logisticSigmoid(calibration.slope * score + calibration.intercept)
}

/**
 * Fit Platt scaling on held-out scores. `scores` are the head's log-odds on
 * calibration rows it was NOT fitted on; `independence` proves it.
 */
export function fitPlattCalibration(
  scores: readonly number[],
  labels: readonly boolean[],
  independence: PlattIndependence,
  options: PlattOptions = {}
): PlattFitResult {
  if (scores.length !== labels.length) {
    throw new RoutingMathError(
      "DIMENSION_MISMATCH",
      `${scores.length} scores for ${labels.length} labels`
    )
  }
  for (let i = 0; i < scores.length; i++) {
    if (!Number.isFinite(scores[i])) {
      throw new RoutingMathError("NON_FINITE", `score ${i} is not a finite number`)
    }
  }
  const dataReasons = plattDataRefusals(labels, independence, options)
  const { positive, negative } = countClasses(labels)
  if (dataReasons.length > 0) {
    return {
      calibrated: false,
      reasons: dataReasons,
      calibration: null,
      sampleCount: labels.length,
      positiveCount: positive,
      negativeCount: negative,
    }
  }

  const positiveTarget = (positive + 1) / (positive + 2)
  const negativeTarget = 1 / (negative + 2)
  const fit = fitLogisticTargets(
    scores.map((score) => [score]),
    labels.map((label) => (label ? positiveTarget : negativeTarget)),
    { l2: 0, standardize: false, maxIterations: 100, tolerance: 1e-12, featureNames: ["score"] }
  )
  const slope = fit.model.rawCoefficients[0]
  const intercept = fit.model.rawIntercept
  let loss = 0
  for (let i = 0; i < scores.length; i++) {
    const p = Math.min(1 - 1e-15, Math.max(1e-15, logisticSigmoid(slope * scores[i] + intercept)))
    loss -= labels[i] ? Math.log(p) : Math.log(1 - p)
  }
  const calibration: PlattCalibration = {
    method: "platt",
    slope,
    intercept,
    sampleCount: labels.length,
    positiveCount: positive,
    negativeCount: negative,
    positiveTarget,
    negativeTarget,
    iterations: fit.diagnostics.iterations,
    converged: fit.diagnostics.converged,
    logLoss: loss / labels.length,
  }
  const reasons: PlattRefusalReason[] = []
  if (!fit.diagnostics.converged) reasons.push("NOT_CONVERGED")
  if (!(slope > 0)) reasons.push("NON_POSITIVE_SLOPE")
  if (reasons.length > 0) {
    return {
      calibrated: false,
      reasons,
      calibration,
      sampleCount: labels.length,
      positiveCount: positive,
      negativeCount: negative,
    }
  }
  return { calibrated: true, calibration }
}

export interface ProbabilityMetrics {
  sampleCount: number
  positiveRate: number
  meanPrediction: number
  /** Mean squared error of the probabilities. */
  brier: number
  /** Mean cross-entropy, probabilities clipped to [1e-15, 1 − 1e-15]. */
  logLoss: number
  /** Expected calibration error over `eceBins` equal-width bins. */
  ece: number
  eceBins: number
}

function checkProbabilities(probabilities: readonly number[], labels: readonly boolean[]): void {
  if (probabilities.length !== labels.length) {
    throw new RoutingMathError(
      "DIMENSION_MISMATCH",
      `${probabilities.length} probabilities for ${labels.length} labels`
    )
  }
  for (let i = 0; i < probabilities.length; i++) {
    const p = probabilities[i]
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new RoutingMathError("NON_FINITE", `probability ${i} must be within [0, 1]`)
    }
    if (typeof labels[i] !== "boolean") {
      throw new RoutingMathError("INVALID_LABEL", `label ${i} must be a boolean`)
    }
  }
}

/** Mean squared error between probabilities and 0/1 outcomes; null when empty. */
export function brierScore(
  probabilities: readonly number[],
  labels: readonly boolean[]
): number | null {
  checkProbabilities(probabilities, labels)
  if (labels.length === 0) return null
  let sum = 0
  for (let i = 0; i < labels.length; i++) sum += (probabilities[i] - (labels[i] ? 1 : 0)) ** 2
  return sum / labels.length
}

/** Mean cross-entropy with clipped probabilities; null when empty. */
export function logLossScore(
  probabilities: readonly number[],
  labels: readonly boolean[]
): number | null {
  checkProbabilities(probabilities, labels)
  if (labels.length === 0) return null
  let sum = 0
  for (let i = 0; i < labels.length; i++) {
    const p = Math.min(1 - 1e-15, Math.max(1e-15, probabilities[i]))
    sum -= labels[i] ? Math.log(p) : Math.log(1 - p)
  }
  return sum / labels.length
}

/**
 * Expected calibration error: rows are binned by predicted probability into
 * `bins` equal-width bins (p = 1 lands in the last bin), and the gap between
 * each bin's mean prediction and its observed pass rate is weighted by the
 * bin's share of rows. Null when empty.
 */
export function expectedCalibrationError(
  probabilities: readonly number[],
  labels: readonly boolean[],
  bins = 10
): number | null {
  checkProbabilities(probabilities, labels)
  if (!Number.isInteger(bins) || bins < 1) {
    throw new RoutingMathError("INVALID_OPTION", `bins must be a positive integer, got ${bins}`)
  }
  if (labels.length === 0) return null
  const counts = new Array<number>(bins).fill(0)
  const predicted = new Array<number>(bins).fill(0)
  const observed = new Array<number>(bins).fill(0)
  for (let i = 0; i < labels.length; i++) {
    const bin = Math.min(bins - 1, Math.floor(probabilities[i] * bins))
    counts[bin]++
    predicted[bin] += probabilities[i]
    if (labels[i]) observed[bin]++
  }
  let ece = 0
  for (let b = 0; b < bins; b++) {
    if (counts[b] === 0) continue
    ece +=
      (counts[b] / labels.length) * Math.abs(predicted[b] / counts[b] - observed[b] / counts[b])
  }
  return ece
}

/** Brier, log loss and ECE together; null for an empty set (no signal, not a zero). */
export function probabilityMetrics(
  probabilities: readonly number[],
  labels: readonly boolean[],
  options: { bins?: number } = {}
): ProbabilityMetrics | null {
  const bins = options.bins ?? 10
  const brier = brierScore(probabilities, labels)
  const logLoss = logLossScore(probabilities, labels)
  const ece = expectedCalibrationError(probabilities, labels, bins)
  if (brier === null || logLoss === null || ece === null) return null
  let positives = 0
  let predictionSum = 0
  for (let i = 0; i < labels.length; i++) {
    if (labels[i]) positives++
    predictionSum += probabilities[i]
  }
  return {
    sampleCount: labels.length,
    positiveRate: positives / labels.length,
    meanPrediction: predictionSum / labels.length,
    brier,
    logLoss,
    ece,
    eceBins: bins,
  }
}
