import {
  applyPlattCalibration,
  brierScore,
  expectedCalibrationError,
  fitPlattCalibration,
  logLossScore,
  plattDataRefusals,
  probabilityMetrics,
} from "./platt"

/** Calibration rows from distinct groups that never fitted the head. */
function independent(count: number) {
  return {
    calibrationGroupIds: Array.from({ length: count }, (_, index) => `cal-${index}`),
    fittingGroupIds: ["train-a", "train-b"],
  }
}

describe("fitPlattCalibration", () => {
  it("reproduces Platt's smoothed targets on a hand-checked two-score set", () => {
    // score −1: 6 rows, 1 accepted; score +1: 6 rows, 5 accepted. N₊ = N₋ = 6,
    // so t₊ = 7/8 and t₋ = 1/8. The two-parameter model is saturated, so
    //   σ(a + b)  = (5·7/8 + 1·1/8) / 6 = 0.75
    //   σ(−a + b) = (1·7/8 + 5·1/8) / 6 = 0.25
    // which gives b = 0 and a = ln 3 exactly.
    const scores = [-1, -1, -1, -1, -1, -1, 1, 1, 1, 1, 1, 1]
    const labels = [true, false, false, false, false, false, true, true, true, true, true, false]
    const result = fitPlattCalibration(scores, labels, independent(12))
    expect(result.calibrated).toBe(true)
    if (!result.calibrated) return
    const { calibration } = result
    expect(calibration.positiveTarget).toBe(7 / 8)
    expect(calibration.negativeTarget).toBe(1 / 8)
    expect(calibration.slope).toBeCloseTo(Math.log(3), 9)
    expect(calibration.intercept).toBeCloseTo(0, 9)
    expect(applyPlattCalibration(calibration, 1)).toBeCloseTo(0.75, 9)
    expect(applyPlattCalibration(calibration, -1)).toBeCloseTo(0.25, 9)
    expect(calibration.converged).toBe(true)
    expect(calibration).toMatchObject({ sampleCount: 12, positiveCount: 6, negativeCount: 6 })
  })

  it("[ACC:EVAL-02] refuses calibration without independent data", () => {
    expect(fitPlattCalibration([], [], independent(0))).toMatchObject({
      calibrated: false,
      reasons: ["NO_CALIBRATION_DATA"],
      calibration: null,
    })
    // A calibration row from a group the head was fitted on is not independent.
    const dependent = fitPlattCalibration([-1, 1, 0.5], [false, true, true], {
      calibrationGroupIds: ["cal-0", "train-a", "cal-2"],
      fittingGroupIds: ["train-a", "train-b"],
    })
    expect(dependent).toMatchObject({
      calibrated: false,
      reasons: ["NOT_INDEPENDENT"],
      calibration: null,
    })
  })

  it("[ACC:EVAL-02] refuses a single-class calibration set", () => {
    expect(fitPlattCalibration([-1, 0, 2], [true, true, true], independent(3))).toMatchObject({
      calibrated: false,
      reasons: ["SINGLE_CLASS"],
      positiveCount: 3,
      negativeCount: 0,
    })
  })

  it("refuses too few rows per class when a minimum is set", () => {
    const result = fitPlattCalibration([-1, 0, 1, 2], [false, true, true, true], independent(4), {
      minPerClass: 2,
    })
    expect(result).toMatchObject({ calibrated: false, reasons: ["INSUFFICIENT_DATA"] })
  })

  it("refuses a head that ranks held-out rows backwards or not at all", () => {
    const backwards = fitPlattCalibration(
      [2, 1.5, 1, -1, -1.5, -2],
      [false, false, false, true, true, true],
      independent(6)
    )
    expect(backwards.calibrated).toBe(false)
    if (!backwards.calibrated) {
      expect(backwards.reasons).toContain("NON_POSITIVE_SLOPE")
      expect(backwards.calibration?.slope).toBeLessThan(0)
    }
    const flat = fitPlattCalibration(
      [0.3, 0.3, 0.3, 0.3],
      [true, false, true, false],
      independent(4)
    )
    expect(flat).toMatchObject({ calibrated: false, reasons: ["NON_POSITIVE_SLOPE"] })
  })

  it("is deterministic", () => {
    const scores = [-2, -1.2, -0.3, 0.1, 0.4, 1.1, 1.7, 2.5]
    const labels = [false, false, true, false, true, true, false, true]
    expect(fitPlattCalibration(scores, labels, independent(8))).toEqual(
      fitPlattCalibration(scores, labels, independent(8))
    )
  })

  it("rejects misaligned or non-finite input", () => {
    expect(() => fitPlattCalibration([1], [true, false], independent(2))).toThrow(
      expect.objectContaining({ code: "DIMENSION_MISMATCH" })
    )
    expect(() => fitPlattCalibration([Number.NaN, 1], [true, false], independent(2))).toThrow(
      expect.objectContaining({ code: "NON_FINITE" })
    )
    expect(() => plattDataRefusals([true], independent(2))).toThrow(
      expect.objectContaining({ code: "DIMENSION_MISMATCH" })
    )
  })
})

describe("probability metrics", () => {
  it("computes Brier, log loss and ECE on a hand-checked pair", () => {
    const probabilities = [0.8, 0.3]
    const labels = [true, false]
    // ((1 − 0.8)² + 0.3²) / 2
    expect(brierScore(probabilities, labels)).toBeCloseTo(0.065, 12)
    expect(logLossScore(probabilities, labels)).toBeCloseTo(
      -(Math.log(0.8) + Math.log(0.7)) / 2,
      12
    )
    // Bin 8 holds 0.8 (gap 0.2), bin 3 holds 0.3 (gap 0.3), half the rows each.
    expect(expectedCalibrationError(probabilities, labels, 10)).toBeCloseTo(0.25, 12)
    expect(probabilityMetrics(probabilities, labels)).toEqual({
      sampleCount: 2,
      positiveRate: 0.5,
      meanPrediction: 0.55,
      brier: expect.closeTo(0.065, 12),
      logLoss: expect.closeTo(-(Math.log(0.8) + Math.log(0.7)) / 2, 12),
      ece: expect.closeTo(0.25, 12),
      eceBins: 10,
    })
  })

  it("puts p = 1 in the last bin and pools a bin before measuring the gap", () => {
    // Both rows in the last bin: mean prediction 0.95, pass rate 0.5.
    expect(expectedCalibrationError([1, 0.9], [true, false], 10)).toBeCloseTo(0.45, 12)
  })

  it("reports an empty set as no signal, not a zero", () => {
    expect(brierScore([], [])).toBeNull()
    expect(logLossScore([], [])).toBeNull()
    expect(expectedCalibrationError([], [])).toBeNull()
    expect(probabilityMetrics([], [])).toBeNull()
  })

  it("rejects probabilities outside [0, 1]", () => {
    expect(() => brierScore([1.2], [true])).toThrow(expect.objectContaining({ code: "NON_FINITE" }))
    expect(() => expectedCalibrationError([0.5], [true], 0)).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" })
    )
  })
})
