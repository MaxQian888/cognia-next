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
}

export interface GateResult {
  passed: boolean
  failures: string[]
}
