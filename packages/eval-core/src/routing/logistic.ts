/**
 * L2-penalized logistic regression, one head per routing action (ADR-0188
 * D12, DESIGN §7.2: "standardized numeric features + one LogisticRegression
 * per action").
 *
 * The optimizer is damped Newton-Raphson (IRLS) with an Armijo backtracking
 * line search on the penalized negative log-likelihood. It is deterministic by
 * construction: no random initialization, no sampling, sums always taken in
 * input order, so the same inputs give bit-identical coefficients within one
 * JavaScript engine. The objective is strictly convex whenever `l2 > 0`, so
 * Newton converges in a handful of iterations. Once the Newton decrement is
 * below tolerance one more (polishing) step is taken, which in the quadratic
 * region leaves the coefficients accurate to near machine precision. With
 * `l2 = 0` on (quasi-)separable data the maximum-likelihood estimate does not
 * exist; the fit then reports `converged: false` (`separated`) instead of
 * returning runaway coefficients.
 *
 * Scale conventions follow scikit-learn's `LogisticRegression(C = 1 / l2)` on
 * `StandardScaler` output: the penalty is `(l2 / 2) · Σ β_j²` over the
 * standardized coefficients (never the intercept), added to the SUMMED (not
 * averaged) log loss, and standardization uses the population standard
 * deviation. A zero-variance feature carries no information, is left out of the
 * fit and gets a coefficient of exactly 0.
 *
 * Cost is O(iterations · n · d²) plus an O(d³) solve per iteration — sized for
 * the routing feature vector (tens to a few hundred columns), not for raw
 * high-dimensional embeddings.
 */

export type RoutingMathErrorCode =
  | "EMPTY_SAMPLE"
  | "DIMENSION_MISMATCH"
  | "NON_FINITE"
  | "INVALID_LABEL"
  | "SINGLE_CLASS"
  | "INVALID_OPTION"
  | "INVALID_SAMPLE"
  | "DUPLICATE_ID"
  | "INVALID_COST"

/** A caller error in the routing math: bad shapes, labels, options or ids. */
export class RoutingMathError extends Error {
  readonly code: RoutingMathErrorCode

  constructor(code: RoutingMathErrorCode, message: string) {
    super(message)
    this.name = "RoutingMathError"
    this.code = code
  }
}

export interface LogisticRegressionOptions {
  /** L2 strength on standardized coefficients (sklearn `1 / C`). Default 1. */
  l2?: number
  /** Newton iterations before giving up with `converged: false`. Default 100. */
  maxIterations?: number
  /** Stop when half the squared Newton decrement falls below this. Default 1e-10. */
  tolerance?: number
  /** Center and scale every feature before fitting. Default true. */
  standardize?: boolean
  /** One name per column; defaults to `x0 … x{d-1}`. */
  featureNames?: readonly string[]
}

export const DEFAULT_LOGISTIC_OPTIONS = {
  l2: 1,
  maxIterations: 100,
  tolerance: 1e-10,
  standardize: true,
} as const

export interface LogisticModel {
  featureNames: string[]
  /** Intercept of the fitted (standardized) model. */
  intercept: number
  /** Coefficients of the fitted (standardized) model, one per feature. */
  coefficients: number[]
  /** Per-feature centering; all 0 when `standardized` is false. */
  means: number[]
  /** Per-feature scaling; 1 for zero-variance features and when `standardized` is false. */
  scales: number[]
  /** The same model in raw feature units: `logit = rawIntercept + Σ rawCoefficients[j] · x[j]`. */
  rawIntercept: number
  rawCoefficients: number[]
  l2: number
  standardized: boolean
}

export type LogisticStopReason =
  | "converged"
  | "max_iterations"
  | "line_search_failed"
  | "singular_hessian"
  /** Unpenalized fit drove a hard-labelled row to certainty: the MLE does not exist. */
  | "separated"

export interface LogisticDiagnostics {
  sampleCount: number
  /** Mean of the targets (the positive rate for hard labels). */
  targetMean: number
  /** Accepted Newton steps. */
  iterations: number
  converged: boolean
  stopReason: LogisticStopReason
  /** Final penalized objective: summed log loss + (l2 / 2) · Σ β_j². */
  objective: number
  /** Final mean (unpenalized) log loss on the training rows. */
  logLoss: number
  /** Max-abs gradient of the penalized objective at the returned solution. */
  gradientNorm: number
  /** Squared Newton decrement at the returned solution; null when the Hessian was singular. */
  newtonDecrement: number | null
  /** Zero-variance features left out of the fit (coefficient fixed at 0). */
  constantFeatures: string[]
}

export interface LogisticRegressionFit {
  model: LogisticModel
  diagnostics: LogisticDiagnostics
}

export interface LogisticClassificationFit extends LogisticRegressionFit {
  classCounts: { positive: number; negative: number }
}

/** Numerically stable logistic function. */
export function logisticSigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z)
    return 1 / (1 + e)
  }
  const e = Math.exp(z)
  return e / (1 + e)
}

/** log(1 + e^z) without overflow. */
function softplus(z: number): number {
  return z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z))
}

/** Cross-entropy of target `t` against logit `z`: softplus(z) − t·z. */
function logisticLoss(z: number, t: number): number {
  return softplus(z) - t * z
}

function resolveOptions(options: LogisticRegressionOptions, width: number) {
  const l2 = options.l2 ?? DEFAULT_LOGISTIC_OPTIONS.l2
  const maxIterations = options.maxIterations ?? DEFAULT_LOGISTIC_OPTIONS.maxIterations
  const tolerance = options.tolerance ?? DEFAULT_LOGISTIC_OPTIONS.tolerance
  const standardize = options.standardize ?? DEFAULT_LOGISTIC_OPTIONS.standardize
  if (!Number.isFinite(l2) || l2 < 0) {
    throw new RoutingMathError("INVALID_OPTION", `l2 must be a finite number >= 0, got ${l2}`)
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new RoutingMathError(
      "INVALID_OPTION",
      `maxIterations must be a positive integer, got ${maxIterations}`
    )
  }
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new RoutingMathError("INVALID_OPTION", `tolerance must be > 0, got ${tolerance}`)
  }
  const featureNames = options.featureNames
    ? [...options.featureNames]
    : Array.from({ length: width }, (_, index) => `x${index}`)
  if (featureNames.length !== width) {
    throw new RoutingMathError(
      "DIMENSION_MISMATCH",
      `featureNames has ${featureNames.length} names for ${width} columns`
    )
  }
  if (new Set(featureNames).size !== featureNames.length) {
    throw new RoutingMathError("INVALID_OPTION", "featureNames must be unique")
  }
  return { l2, maxIterations, tolerance, standardize, featureNames }
}

function validateMatrix(features: readonly (readonly number[])[], rows: number): number {
  if (features.length !== rows) {
    throw new RoutingMathError(
      "DIMENSION_MISMATCH",
      `${features.length} feature rows for ${rows} targets`
    )
  }
  if (rows === 0) throw new RoutingMathError("EMPTY_SAMPLE", "cannot fit on an empty sample")
  const width = features[0].length
  for (let i = 0; i < rows; i++) {
    const row = features[i]
    if (row.length !== width) {
      throw new RoutingMathError(
        "DIMENSION_MISMATCH",
        `row ${i} has ${row.length} features, expected ${width}`
      )
    }
    for (let j = 0; j < width; j++) {
      if (!Number.isFinite(row[j])) {
        throw new RoutingMathError("NON_FINITE", `feature [${i}][${j}] is not a finite number`)
      }
    }
  }
  return width
}

/**
 * Cholesky solve of the symmetric positive-definite system `A x = b` (A is
 * `size × size`, row-major). Returns null when A is not numerically
 * positive definite.
 */
function choleskySolve(a: Float64Array, b: Float64Array, size: number): Float64Array | null {
  const l = new Float64Array(size * size)
  for (let j = 0; j < size; j++) {
    let diagonal = a[j * size + j]
    for (let m = 0; m < j; m++) diagonal -= l[j * size + m] * l[j * size + m]
    if (!(diagonal > 1e-12 * Math.max(a[j * size + j], Number.MIN_VALUE))) return null
    const pivot = Math.sqrt(diagonal)
    l[j * size + j] = pivot
    for (let i = j + 1; i < size; i++) {
      let sum = a[i * size + j]
      for (let m = 0; m < j; m++) sum -= l[i * size + m] * l[j * size + m]
      l[i * size + j] = sum / pivot
    }
  }
  const y = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    let sum = b[i]
    for (let m = 0; m < i; m++) sum -= l[i * size + m] * y[m]
    y[i] = sum / l[i * size + i]
  }
  const x = new Float64Array(size)
  for (let i = size - 1; i >= 0; i--) {
    let sum = y[i]
    for (let m = i + 1; m < size; m++) sum -= l[m * size + i] * x[m]
    x[i] = sum / l[i * size + i]
  }
  for (let i = 0; i < size; i++) if (!Number.isFinite(x[i])) return null
  return x
}

interface CoreResult {
  beta: Float64Array
  iterations: number
  stopReason: LogisticStopReason
  objective: number
  sumLoss: number
  gradientNorm: number
  newtonDecrement: number | null
}

/**
 * Newton-Raphson on `Σ loss(β0 + z_i·β, t_i) + (l2 / 2)·Σ β_j²` where `z` is
 * the `rows × width` design (row-major, intercept column implicit).
 */
function newtonFit(
  design: Float64Array,
  targets: readonly number[],
  rows: number,
  width: number,
  l2: number,
  maxIterations: number,
  tolerance: number
): CoreResult {
  const size = width + 1
  const beta = new Float64Array(size)
  const targetMean = targets.reduce((sum, t) => sum + t, 0) / rows
  const clamped = Math.min(1 - 1e-6, Math.max(1e-6, targetMean))
  beta[0] = Math.log(clamped / (1 - clamped))

  const eta = new Float64Array(rows)
  const linear = (coefficients: Float64Array, out: Float64Array) => {
    for (let i = 0; i < rows; i++) {
      let sum = coefficients[0]
      const offset = i * width
      for (let j = 0; j < width; j++) sum += coefficients[j + 1] * design[offset + j]
      out[i] = sum
    }
  }
  const objectiveOf = (coefficients: Float64Array, logits: Float64Array) => {
    let loss = 0
    for (let i = 0; i < rows; i++) loss += logisticLoss(logits[i], targets[i])
    let penalty = 0
    for (let j = 1; j < size; j++) penalty += coefficients[j] * coefficients[j]
    return { loss, objective: loss + (l2 / 2) * penalty }
  }

  linear(beta, eta)
  let current = objectiveOf(beta, eta)
  const gradient = new Float64Array(size)
  const hessian = new Float64Array(size * size)
  const trialEta = new Float64Array(rows)
  let iterations = 0
  let stopReason: LogisticStopReason = "max_iterations"
  let newtonDecrement: number | null = null
  let polished = false

  for (;;) {
    gradient.fill(0)
    hessian.fill(0)
    for (let i = 0; i < rows; i++) {
      const p = logisticSigmoid(eta[i])
      const residual = p - targets[i]
      const weight = p * (1 - p)
      const offset = i * width
      gradient[0] += residual
      hessian[0] += weight
      for (let j = 0; j < width; j++) {
        const zj = design[offset + j]
        gradient[j + 1] += residual * zj
        const wz = weight * zj
        hessian[j + 1] += wz
        const rowOffset = (j + 1) * size
        for (let k = j; k < width; k++) hessian[rowOffset + k + 1] += wz * design[offset + k]
      }
    }
    for (let j = 1; j < size; j++) {
      gradient[j] += l2 * beta[j]
      hessian[j * size + j] += l2
      // Mirror the upper triangle (and the intercept row) into the lower one.
      for (let k = 0; k < j; k++) hessian[j * size + k] = hessian[k * size + j]
    }

    const step = choleskySolve(hessian, gradient, size)
    if (!step) {
      stopReason = "singular_hessian"
      newtonDecrement = null
      break
    }
    let decrement = 0
    for (let j = 0; j < size; j++) decrement += gradient[j] * step[j]
    newtonDecrement = decrement
    const withinTolerance = decrement / 2 <= tolerance
    if (withinTolerance && polished) {
      stopReason = "converged"
      break
    }
    if (iterations >= maxIterations) {
      stopReason = withinTolerance ? "converged" : "max_iterations"
      break
    }

    let scale = 1
    let accepted = false
    const trial = new Float64Array(size)
    while (scale >= 1e-10) {
      for (let j = 0; j < size; j++) trial[j] = beta[j] - scale * step[j]
      linear(trial, trialEta)
      const next = objectiveOf(trial, trialEta)
      if (next.objective <= current.objective - 1e-4 * scale * decrement) {
        beta.set(trial)
        eta.set(trialEta)
        current = next
        accepted = true
        break
      }
      scale /= 2
    }
    if (!accepted) {
      // No representable decrease left: at the floating-point floor of the
      // optimum this is convergence, anywhere else it is a failure.
      stopReason =
        withinTolerance || decrement / 2 <= 1e-8 * Math.max(1, Math.abs(current.objective))
          ? "converged"
          : "line_search_failed"
      break
    }
    iterations++
    // The step taken inside the tolerance is the polishing step; the next
    // decrement check ends the fit.
    if (withinTolerance) polished = true
  }

  let gradientNorm = 0
  for (let j = 0; j < size; j++) gradientNorm = Math.max(gradientNorm, Math.abs(gradient[j]))
  if (l2 === 0 && width > 0) {
    // Without a penalty, a hard-labelled row fitted to within 1e-9 of
    // certainty means the likelihood keeps improving as a coefficient grows
    // without bound: (quasi-)complete separation, no finite MLE.
    for (let i = 0; i < rows; i++) {
      const t = targets[i]
      if ((t === 0 || t === 1) && Math.abs(logisticSigmoid(eta[i]) - t) < 1e-9) {
        stopReason = "separated"
        break
      }
    }
  }
  return {
    beta,
    iterations,
    stopReason,
    objective: current.objective,
    sumLoss: current.loss,
    gradientNorm,
    newtonDecrement,
  }
}

/**
 * Fit on soft targets in [0, 1] (Platt scaling fits on smoothed targets).
 * Hard-label callers use {@link fitLogisticRegression}, which also refuses a
 * single-class sample.
 */
export function fitLogisticTargets(
  features: readonly (readonly number[])[],
  targets: readonly number[],
  options: LogisticRegressionOptions = {}
): LogisticRegressionFit {
  const rows = targets.length
  const width = validateMatrix(features, rows)
  for (let i = 0; i < rows; i++) {
    const t = targets[i]
    if (!Number.isFinite(t) || t < 0 || t > 1) {
      throw new RoutingMathError("INVALID_LABEL", `target ${i} must be within [0, 1], got ${t}`)
    }
  }
  const { l2, maxIterations, tolerance, standardize, featureNames } = resolveOptions(options, width)

  const means = new Array<number>(width).fill(0)
  const scales = new Array<number>(width).fill(1)
  const active: number[] = []
  const constantFeatures: string[] = []
  for (let j = 0; j < width; j++) {
    let sum = 0
    for (let i = 0; i < rows; i++) sum += features[i][j]
    const mean = sum / rows
    let squares = 0
    for (let i = 0; i < rows; i++) squares += (features[i][j] - mean) ** 2
    const deviation = Math.sqrt(squares / rows)
    if (deviation <= 1e-12 * Math.max(1, Math.abs(mean))) {
      constantFeatures.push(featureNames[j])
      if (standardize) means[j] = mean
      continue
    }
    active.push(j)
    if (standardize) {
      means[j] = mean
      scales[j] = deviation
    }
  }

  const activeWidth = active.length
  const design = new Float64Array(rows * activeWidth)
  for (let i = 0; i < rows; i++) {
    for (let a = 0; a < activeWidth; a++) {
      const j = active[a]
      design[i * activeWidth + a] = (features[i][j] - means[j]) / scales[j]
    }
  }

  const core = newtonFit(design, targets, rows, activeWidth, l2, maxIterations, tolerance)
  const coefficients = new Array<number>(width).fill(0)
  for (let a = 0; a < activeWidth; a++) coefficients[active[a]] = core.beta[a + 1]
  const intercept = core.beta[0]
  const rawCoefficients = coefficients.map((coefficient, j) => coefficient / scales[j])
  let rawIntercept = intercept
  for (let j = 0; j < width; j++) rawIntercept -= (coefficients[j] * means[j]) / scales[j]

  return {
    model: {
      featureNames,
      intercept,
      coefficients,
      means,
      scales,
      rawIntercept,
      rawCoefficients,
      l2,
      standardized: standardize,
    },
    diagnostics: {
      sampleCount: rows,
      targetMean: targets.reduce((sum, t) => sum + t, 0) / rows,
      iterations: core.iterations,
      converged: core.stopReason === "converged",
      stopReason: core.stopReason,
      objective: core.objective,
      logLoss: core.sumLoss / rows,
      gradientNorm: core.gradientNorm,
      newtonDecrement: core.newtonDecrement,
      constantFeatures,
    },
  }
}

/**
 * Fit one routing head on hard pass/fail labels. A sample with a single class
 * has no finite maximum-likelihood intercept, so it is refused
 * (`SINGLE_CLASS`) rather than fitted to a meaningless extreme (EVAL-02).
 */
export function fitLogisticRegression(
  features: readonly (readonly number[])[],
  labels: readonly boolean[],
  options: LogisticRegressionOptions = {}
): LogisticClassificationFit {
  let positive = 0
  for (let i = 0; i < labels.length; i++) {
    if (typeof labels[i] !== "boolean") {
      throw new RoutingMathError("INVALID_LABEL", `label ${i} must be a boolean`)
    }
    if (labels[i]) positive++
  }
  const negative = labels.length - positive
  if (labels.length > 0 && (positive === 0 || negative === 0)) {
    throw new RoutingMathError(
      "SINGLE_CLASS",
      `logistic regression needs both classes (positive ${positive}, negative ${negative})`
    )
  }
  const fit = fitLogisticTargets(
    features,
    labels.map((label) => (label ? 1 : 0)),
    options
  )
  return { ...fit, classCounts: { positive, negative } }
}

function checkInput(model: LogisticModel, features: readonly number[]): void {
  if (features.length !== model.featureNames.length) {
    throw new RoutingMathError(
      "DIMENSION_MISMATCH",
      `expected ${model.featureNames.length} features, got ${features.length}`
    )
  }
  for (let j = 0; j < features.length; j++) {
    if (!Number.isFinite(features[j])) {
      throw new RoutingMathError("NON_FINITE", `feature ${j} is not a finite number`)
    }
  }
}

/** The model's log-odds for one feature vector. */
export function logisticLogit(model: LogisticModel, features: readonly number[]): number {
  checkInput(model, features)
  let logit = model.intercept
  for (let j = 0; j < features.length; j++) {
    const coefficient = model.coefficients[j]
    if (coefficient !== 0) logit += (coefficient * (features[j] - model.means[j])) / model.scales[j]
  }
  return logit
}

/** The model's (uncalibrated) probability for one feature vector. */
export function logisticProbability(model: LogisticModel, features: readonly number[]): number {
  return logisticSigmoid(logisticLogit(model, features))
}
