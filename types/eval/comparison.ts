/**
 * Run-comparison model. `lib/ai/eval/compare.ts:buildComparison` folds N
 * {@link import("./eval").EvalReport}s + their per-case verdicts into a
 * rows×runs grid the comparison view renders (delta + regression vs baseline).
 */

export interface ComparisonCell {
  runId: string
  /** scorerId → verdict for this case in this run. */
  scores: Record<string, { value: number; passed: boolean }>
  /** Did the case pass ALL applied scorers on repetition 1? */
  passAt1: boolean
  /** passAt1 (0/1) delta vs the baseline (first) run; undefined for baseline. */
  delta?: number
  /** Baseline passed but this run failed. */
  regression: boolean
}

export interface ComparisonRow {
  caseId: string
  input: string
  cells: ComparisonCell[]
}

export interface RunComparison {
  runIds: string[]
  rows: ComparisonRow[]
}
