/**
 * CI/UI gate thresholds — turns an EvalReport into a pass/fail decision.
 * Stored optionally on EvalDataset (`gate` field, non-indexed) and consumed by
 * `lib/ai/eval/gate.ts:evaluateGate`, the run UI, and the `eval.gate` node.
 */

export interface GateThresholds {
  /** Minimum acceptable pass^k reliability. */
  minPassHatK?: number
  /** Minimum acceptable pass@1. */
  minPassAt1?: number
  /**
   * Per-scorer pass-rate floor: a single number applied to every scorer, or a
   * map of scorerId → floor (scorers absent from the report are ignored).
   */
  minScorerPassRate?: number | Record<string, number>
  /** Maximum acceptable total cost. */
  maxTotalCostUsd?: number
  /**
   * Maximum acceptable fraction of cases no scorer could grade (0..1).
   * Without this, a run where 95% of cases are ungraded and the remaining 5%
   * pass still clears `minPassAt1` — a high pass rate over almost nothing.
   */
  maxUngradedRatio?: number
  /**
   * Scorers that MUST have produced at least one verdict for the gate to mean
   * anything. Naming one here that graded nothing yields `inconclusive`, not a
   * pass — distinct from {@link minScorerPassRate}, whose map form documents
   * the opposite (absent scorers are ignored), because a floor says "if this
   * ran, clear this bar" while this says "this had to run".
   */
  requiredScorerIds?: string[]
}

/**
 * `inconclusive` is not a third flavour of failure — it means the run produced
 * too little evidence to answer. Before it existed a run that graded NOTHING
 * reported `passAt1: 0`, which every floor read as a catastrophic failure; "we
 * learned nothing" and "the agent failed everything" were the same output.
 */
export type GateVerdict = "pass" | "fail" | "inconclusive"

export interface GateResult {
  /** Retained for existing callers; exactly `verdict === "pass"`. */
  passed: boolean
  verdict: GateVerdict
  failures: string[]
  /** Why the run could not be judged. Empty unless `verdict` is inconclusive. */
  inconclusiveReasons: string[]
}
