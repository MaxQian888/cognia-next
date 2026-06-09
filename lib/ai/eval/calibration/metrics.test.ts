/**
 * Tests for the judge-calibration agreement metrics (pure math).
 *
 * The single highest-value correctness trap is degenerate input: empty sets and
 * single-class gold labels make Cohen's κ / TPR / TNR mathematically undefined.
 * A naive implementation emits NaN or 0 there; these tests pin them to `null`.
 */

import {
  computeAgreement,
  confusionMatrix,
  cohenKappa,
  disagreementCount,
  type LabelPair,
} from "./metrics"

/** Build N pairs with the given (gold, judge) booleans. */
function pairs(...specs: Array<[boolean, boolean]>): LabelPair[] {
  return specs.map(([gold, judge]) => ({ gold, judge }))
}

describe("confusionMatrix", () => {
  it("counts tp/fp/tn/fn with gold-pass as the positive class", () => {
    const m = confusionMatrix(
      pairs(
        [true, true], // tp
        [true, true], // tp
        [true, false], // fn (gold pass, judge fail)
        [false, true], // fp (gold fail, judge pass)
        [false, false] // tn
      )
    )
    expect(m).toEqual({ tp: 2, fp: 1, tn: 1, fn: 1 })
  })

  it("returns an all-zero matrix for empty input", () => {
    expect(confusionMatrix([])).toEqual({ tp: 0, fp: 0, tn: 0, fn: 0 })
  })
})

describe("cohenKappa", () => {
  it("is 1 for perfect agreement", () => {
    const m = confusionMatrix(pairs([true, true], [false, false], [true, true], [false, false]))
    expect(cohenKappa(m)).toBe(1)
  })

  it("is negative for systematic disagreement", () => {
    const m = confusionMatrix(pairs([true, false], [false, true], [true, false], [false, true]))
    const k = cohenKappa(m)
    expect(k).not.toBeNull()
    expect(k as number).toBeLessThan(0)
  })

  it("matches a hand-computed value (tp=20 fp=5 fn=10 tn=15)", () => {
    // n=50, po=(20+15)/50=0.7
    // pe = (30/50)*(25/50) + (20/50)*(25/50) = 0.6*0.5 + 0.4*0.5 = 0.3+0.2 = 0.5
    // κ = (0.7-0.5)/(1-0.5) = 0.2/0.5 = 0.4
    const m = { tp: 20, fp: 5, fn: 10, tn: 15 }
    expect(cohenKappa(m)).toBeCloseTo(0.4, 10)
  })

  it("returns null for an empty matrix (n=0)", () => {
    expect(cohenKappa({ tp: 0, fp: 0, tn: 0, fn: 0 })).toBeNull()
  })

  it("returns null when gold labels are single-class (no reference variance)", () => {
    // All gold pass, judge mixed → no negative reference class; κ degenerate.
    const m = confusionMatrix(pairs([true, true], [true, false], [true, true]))
    expect(cohenKappa(m)).toBeNull()
  })

  it("returns null when both raters always agree on a single class", () => {
    // All gold pass AND all judge pass → po=1 but pe=1 too → undefined.
    const m = confusionMatrix(pairs([true, true], [true, true]))
    expect(cohenKappa(m)).toBeNull()
  })
})

describe("computeAgreement", () => {
  it("computes the full metric bundle on a mixed set", () => {
    const a = computeAgreement(
      pairs(
        [true, true], // tp
        [true, true], // tp
        [true, false], // fn
        [false, true], // fp
        [false, false] // tn
      )
    )
    expect(a.matrix).toEqual({ tp: 2, fp: 1, tn: 1, fn: 1 })
    expect(a.n).toBe(5)
    expect(a.tpr).toBeCloseTo(2 / 3, 10) // tp/(tp+fn)
    expect(a.tnr).toBeCloseTo(1 / 2, 10) // tn/(tn+fp)
    expect(a.precision).toBeCloseTo(2 / 3, 10) // tp/(tp+fp)
    expect(a.accuracy).toBeCloseTo(3 / 5, 10) // (tp+tn)/n
    expect(a.f1).toBeCloseTo((2 * (2 / 3) * (2 / 3)) / (2 / 3 + 2 / 3), 10)
    expect(a.cohenKappa).not.toBeNull()
  })

  it("returns all-null metrics for an empty set", () => {
    const a = computeAgreement([])
    expect(a.matrix).toEqual({ tp: 0, fp: 0, tn: 0, fn: 0 })
    expect(a.n).toBe(0)
    expect(a.tpr).toBeNull()
    expect(a.tnr).toBeNull()
    expect(a.precision).toBeNull()
    expect(a.f1).toBeNull()
    expect(a.accuracy).toBeNull()
    expect(a.cohenKappa).toBeNull()
  })

  it("nulls TPR when there is no positive (gold-pass) class", () => {
    const a = computeAgreement(pairs([false, false], [false, true]))
    expect(a.tpr).toBeNull() // tp+fn = 0
    expect(a.tnr).not.toBeNull()
    expect(a.cohenKappa).toBeNull() // single gold class
  })

  it("nulls TNR when there is no negative (gold-fail) class", () => {
    const a = computeAgreement(pairs([true, true], [true, false]))
    expect(a.tnr).toBeNull() // tn+fp = 0
    expect(a.tpr).not.toBeNull()
  })

  it("nulls precision and f1 when the judge never predicts pass", () => {
    const a = computeAgreement(pairs([true, false], [false, false]))
    expect(a.precision).toBeNull() // tp+fp = 0
    expect(a.f1).toBeNull()
  })

  it("gives precision/recall/accuracy = 1 on a perfect classifier", () => {
    const a = computeAgreement(pairs([true, true], [false, false], [true, true], [false, false]))
    expect(a.precision).toBe(1)
    expect(a.tpr).toBe(1)
    expect(a.accuracy).toBe(1)
    expect(a.f1).toBe(1)
    expect(a.cohenKappa).toBe(1)
  })
})

describe("disagreementCount", () => {
  it("counts pairs where gold and judge differ", () => {
    expect(
      disagreementCount(pairs([true, true], [true, false], [false, true], [false, false]))
    ).toBe(2)
  })

  it("is 0 for an empty set", () => {
    expect(disagreementCount([])).toBe(0)
  })
})
