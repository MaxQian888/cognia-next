import {
  fitLogisticRegression,
  fitLogisticTargets,
  logisticLogit,
  logisticProbability,
  logisticSigmoid,
  RoutingMathError,
} from "./logistic"
import { createSeededRandom } from "./grouped-split"

const logit = (p: number) => Math.log(p / (1 - p))

/** Root of a monotone function on [lo, hi] by bisection — an independent solver for the checks. */
function bisect(f: (x: number) => number, lo: number, hi: number): number {
  let low = lo
  let high = hi
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2
    if (Math.sign(f(mid)) === Math.sign(f(low))) low = mid
    else high = mid
  }
  return (low + high) / 2
}

function syntheticDataset(seed: number, rows: number) {
  const random = createSeededRandom(seed)
  const features: number[][] = []
  const labels: boolean[] = []
  for (let i = 0; i < rows; i++) {
    const a = random() * 4 - 2
    const b = random() * 10 + 5
    const c = random() < 0.3 ? 1 : 0
    features.push([a, b, c])
    labels.push(random() < logisticSigmoid(1.5 * a - 0.2 * (b - 10) + 0.8 * c - 0.3))
  }
  return { features, labels }
}

describe("fitLogisticRegression", () => {
  it("recovers logit(mean) for an intercept-only head", () => {
    const labels = [true, true, true, false]
    const fit = fitLogisticRegression(
      labels.map(() => []),
      labels
    )
    expect(fit.model.intercept).toBeCloseTo(Math.log(3), 10)
    expect(fit.model.coefficients).toEqual([])
    expect(fit.diagnostics.converged).toBe(true)
    expect(fit.classCounts).toEqual({ positive: 3, negative: 1 })
  })

  it("matches the closed-form MLE of a saturated binary feature when unpenalized", () => {
    // x = 0: 1 of 4 accepted; x = 1: 3 of 4 accepted.
    const features = [[0], [0], [0], [0], [1], [1], [1], [1]]
    const labels = [true, false, false, false, true, true, true, false]
    const fit = fitLogisticRegression(features, labels, { l2: 0, standardize: false })
    expect(fit.diagnostics.converged).toBe(true)
    expect(fit.model.rawIntercept).toBeCloseTo(logit(0.25), 9)
    expect(fit.model.rawCoefficients[0]).toBeCloseTo(logit(0.75) - logit(0.25), 9)
    expect(logisticProbability(fit.model, [0])).toBeCloseTo(0.25, 9)
    expect(logisticProbability(fit.model, [1])).toBeCloseTo(0.75, 9)
  })

  it("solves the hand-derived L2 stationarity equation 8σ(β) + λβ = 6", () => {
    // Four rows at x = +1 (3 accepted), four at x = −1 (1 accepted). The
    // column is already standardized (mean 0, population sd 1) and symmetric,
    // so β0 = 0 and the coefficient solves 8σ(β) − 6 + λβ = 0.
    const features = [[1], [1], [1], [1], [-1], [-1], [-1], [-1]]
    const labels = [true, true, true, false, true, false, false, false]
    for (const l2 of [0, 0.5, 2, 10]) {
      const expected = bisect((beta) => 8 * logisticSigmoid(beta) - 6 + l2 * beta, -10, 10)
      const fit = fitLogisticRegression(features, labels, { l2 })
      expect(fit.diagnostics.converged).toBe(true)
      expect(fit.model.intercept).toBeCloseTo(0, 9)
      expect(fit.model.coefficients[0]).toBeCloseTo(expected, 9)
      expect(fit.model.scales[0]).toBeCloseTo(1, 12)
    }
    expect(bisect((beta) => 8 * logisticSigmoid(beta) - 6, -10, 10)).toBeCloseTo(Math.log(3), 9)
  })

  it("satisfies the penalized first-order conditions on a realistic dataset", () => {
    const { features, labels } = syntheticDataset(7, 400)
    const l2 = 1.5
    const fit = fitLogisticRegression(features, labels, { l2 })
    expect(fit.diagnostics.converged).toBe(true)
    // Recompute the gradient independently in standardized space.
    const { means, scales, intercept, coefficients } = fit.model
    const gradient = [0, 0, 0, 0]
    features.forEach((row, i) => {
      const z = row.map((value, j) => (value - means[j]) / scales[j])
      const p = logisticSigmoid(
        intercept + z.reduce((sum, value, j) => sum + value * coefficients[j], 0)
      )
      const residual = p - (labels[i] ? 1 : 0)
      gradient[0] += residual
      z.forEach((value, j) => (gradient[j + 1] += residual * value))
    })
    coefficients.forEach((coefficient, j) => (gradient[j + 1] += l2 * coefficient))
    for (const component of gradient) expect(Math.abs(component)).toBeLessThan(1e-6)
    expect(fit.diagnostics.gradientNorm).toBeLessThan(1e-6)
    // The generating signs survive: a helps, b hurts, c helps.
    expect(coefficients[0]).toBeGreaterThan(0)
    expect(coefficients[1]).toBeLessThan(0)
    expect(coefficients[2]).toBeGreaterThan(0)
  })

  it("reports raw-unit coefficients that give the same predictions as the standardized model", () => {
    const { features, labels } = syntheticDataset(11, 200)
    const fit = fitLogisticRegression(features, labels)
    const { model } = fit
    for (const row of features.slice(0, 25)) {
      const raw =
        model.rawIntercept +
        row.reduce((sum, value, j) => sum + value * model.rawCoefficients[j], 0)
      expect(raw).toBeCloseTo(logisticLogit(model, row), 9)
    }
    model.coefficients.forEach((coefficient, j) => {
      expect(model.rawCoefficients[j]).toBeCloseTo(coefficient / model.scales[j], 12)
    })
  })

  it("leaves a zero-variance feature out of the fit with a coefficient of exactly 0", () => {
    const features = [
      [0, 5],
      [0, 5],
      [1, 5],
      [1, 5],
      [0, 5],
      [1, 5],
    ]
    const labels = [false, true, true, true, false, false]
    const fit = fitLogisticRegression(features, labels, { featureNames: ["signal", "flat"] })
    expect(fit.model.coefficients[1]).toBe(0)
    expect(fit.model.rawCoefficients[1]).toBe(0)
    expect(fit.diagnostics.constantFeatures).toEqual(["flat"])
    expect(fit.diagnostics.converged).toBe(true)
  })

  it("is bit-for-bit deterministic", () => {
    const { features, labels } = syntheticDataset(3, 300)
    expect(fitLogisticRegression(features, labels, { l2: 0.7 })).toEqual(
      fitLogisticRegression(features, labels, { l2: 0.7 })
    )
  })

  it("reports non-convergence instead of runaway coefficients on separable unpenalized data", () => {
    const features = [[-2], [-1], [1], [2]]
    const labels = [false, false, true, true]
    const unpenalized = fitLogisticRegression(features, labels, { l2: 0, maxIterations: 50 })
    expect(unpenalized.diagnostics.converged).toBe(false)
    expect(unpenalized.diagnostics.stopReason).not.toBe("converged")
    const penalized = fitLogisticRegression(features, labels, { l2: 1 })
    expect(penalized.diagnostics.converged).toBe(true)
    expect(Number.isFinite(penalized.model.coefficients[0])).toBe(true)
  })

  it("refuses a single-class sample", () => {
    expect(() => fitLogisticRegression([[1], [2]], [true, true])).toThrow(
      expect.objectContaining({ code: "SINGLE_CLASS" })
    )
  })

  it("refuses malformed input with typed errors", () => {
    expect(() => fitLogisticRegression([], [])).toThrow(RoutingMathError)
    expect(() => fitLogisticRegression([[1], [1, 2]], [true, false])).toThrow(
      expect.objectContaining({ code: "DIMENSION_MISMATCH" })
    )
    expect(() => fitLogisticRegression([[1], [Number.NaN]], [true, false])).toThrow(
      expect.objectContaining({ code: "NON_FINITE" })
    )
    expect(() => fitLogisticRegression([[1], [2]], [true, false], { l2: -1 })).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" })
    )
    expect(() =>
      fitLogisticRegression([[1], [2]], [true, false], { featureNames: ["a", "b"] })
    ).toThrow(expect.objectContaining({ code: "DIMENSION_MISMATCH" }))
    expect(() => fitLogisticTargets([[1]], [1.5])).toThrow(
      expect.objectContaining({ code: "INVALID_LABEL" })
    )
  })

  it("refuses a prediction on a vector of the wrong width", () => {
    const fit = fitLogisticRegression([[0], [1], [0], [1]], [false, true, true, false])
    expect(() => logisticLogit(fit.model, [1, 2])).toThrow(
      expect.objectContaining({ code: "DIMENSION_MISMATCH" })
    )
    expect(() => logisticLogit(fit.model, [Number.POSITIVE_INFINITY])).toThrow(
      expect.objectContaining({ code: "NON_FINITE" })
    )
  })
})

describe("logisticSigmoid", () => {
  it("is stable at extreme logits", () => {
    expect(logisticSigmoid(0)).toBe(0.5)
    expect(logisticSigmoid(800)).toBe(1)
    expect(logisticSigmoid(-800)).toBe(0)
    expect(logisticSigmoid(Math.log(3))).toBeCloseTo(0.75, 12)
  })
})
