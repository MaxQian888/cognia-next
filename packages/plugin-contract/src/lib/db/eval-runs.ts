/**
 * The plugin contract's share of `lib/db/eval-runs.ts`, which re-exports these.
 */
import type { EvalReport } from "../../types/eval/eval"

/** The persisted run row is exactly the aggregated report. */
export type EvalRunRow = EvalReport
