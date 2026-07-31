/**
 * Judge-calibration agreement metrics (pure math, no I/O).
 *
 * Quantifies how well an LLM-judge agrees with human gold labels over a
 * calibration set — the missing half of eval spec §10. Mirrors the pure-style
 * of `error-analysis/coding.ts`: total functions over plain value objects,
 * exhaustively unit-tested.
 *
 * Convention: the human gold `pass` verdict is the POSITIVE class.
 *  - tp = judge pass  & gold pass
 *  - fp = judge pass  & gold fail
 *  - fn = judge fail  & gold pass
 *  - tn = judge fail  & gold fail
 *
 * Degenerate inputs (empty set, single-class gold labels) make several metrics
 * mathematically undefined. Every such case returns `null` — never NaN or a
 * misleading 0 — so the UI can render an em-dash instead of a fake number.
 *
 * Errored judge verdicts (fail-open) must be filtered out by the caller before
 * the pairs reach this module; an errored verdict is "not-applicable", not a
 * "fail", and counting it would poison TNR / κ.
 */

/** One (gold, judge) label pair. `true` = pass (the positive class). */
export interface LabelPair {
  gold: boolean
  judge: boolean
}

/** 2×2 confusion matrix with gold-pass as the positive class. */
export interface ConfusionMatrix {
  tp: number
  fp: number
  tn: number
  fn: number
}

/** The full agreement bundle for one calibration run. */
export interface AgreementMetrics {
  matrix: ConfusionMatrix
  /** Scored pairs (errored verdicts already excluded). */
  n: number
  /** TPR / recall / sensitivity = tp/(tp+fn); null when no positives. */
  tpr: number | null
  /** TNR / specificity = tn/(tn+fp); null when no negatives. */
  tnr: number | null
  /** precision = tp/(tp+fp); null when the judge never predicts pass. */
  precision: number | null
  /** harmonic mean of precision & recall; null when either is null/zero-denominator. */
  f1: number | null
  /** (tp+tn)/n; null when n=0. */
  accuracy: number | null
  /** Cohen's κ (chance-corrected); null when undefined (n=0 or single-class). */
  cohenKappa: number | null
}

/** Count tp/fp/tn/fn over label pairs. */
export function confusionMatrix(pairs: LabelPair[]): ConfusionMatrix {
  const m: ConfusionMatrix = { tp: 0, fp: 0, tn: 0, fn: 0 }
  for (const { gold, judge } of pairs) {
    if (gold && judge) m.tp += 1
    else if (!gold && judge) m.fp += 1
    else if (gold && !judge) m.fn += 1
    else m.tn += 1
  }
  return m
}

/** Safe ratio: `null` when the denominator is 0. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

/**
 * Cohen's κ for a 2-rater / 2-category confusion matrix.
 *
 *   po = (tp + tn) / n                              observed agreement
 *   pe = P(both say pass by chance) + P(both say fail by chance)
 *      = ((tp+fn)/n)·((tp+fp)/n) + ((fp+tn)/n)·((fn+tn)/n)
 *   κ  = (po − pe) / (1 − pe)
 *
 * Returns `null` when:
 *  - n=0 (nothing scored), or
 *  - the gold labels are single-class (all pass or all fail). κ then measures
 *    nothing useful — without both reference classes you cannot tell whether the
 *    judge discriminates — and the formula degenerates (pe→1 / 0÷0). This guard
 *    subsumes the strict pe=1 division-by-zero case.
 */
export function cohenKappa(m: ConfusionMatrix): number | null {
  const n = m.tp + m.fp + m.tn + m.fn
  if (n === 0) return null
  // Single-class gold ⇒ no positive (tp+fn=0) or no negative (fp+tn=0) reference.
  if (m.tp + m.fn === 0 || m.fp + m.tn === 0) return null

  const po = (m.tp + m.tn) / n
  const goldPass = (m.tp + m.fn) / n
  const judgePass = (m.tp + m.fp) / n
  const goldFail = (m.fp + m.tn) / n
  const judgeFail = (m.fn + m.tn) / n
  const pe = goldPass * judgePass + goldFail * judgeFail

  if (pe === 1) return null
  return (po - pe) / (1 - pe)
}

/** Compute the full agreement bundle from label pairs. */
export function computeAgreement(pairs: LabelPair[]): AgreementMetrics {
  const matrix = confusionMatrix(pairs)
  const n = matrix.tp + matrix.fp + matrix.tn + matrix.fn

  const tpr = ratio(matrix.tp, matrix.tp + matrix.fn)
  const tnr = ratio(matrix.tn, matrix.tn + matrix.fp)
  const precision = ratio(matrix.tp, matrix.tp + matrix.fp)
  const accuracy = ratio(matrix.tp + matrix.tn, n)
  const f1 =
    precision !== null && tpr !== null && precision + tpr > 0
      ? (2 * precision * tpr) / (precision + tpr)
      : null

  return {
    matrix,
    n,
    tpr,
    tnr,
    precision,
    f1,
    accuracy,
    cohenKappa: cohenKappa(matrix),
  }
}

/** Number of pairs where the judge disagrees with the gold label. */
export function disagreementCount(pairs: LabelPair[]): number {
  let count = 0
  for (const { gold, judge } of pairs) if (gold !== judge) count += 1
  return count
}
