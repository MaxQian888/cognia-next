/**
 * Eval dataset import model.
 *
 * A {@link FieldSpec} maps arbitrary source columns onto the canonical
 * {@link import("./eval").EvalCase} fields (Inspect-style), so any CSV / JSON /
 * JSONL / YAML file imports without reshaping it. Parsers live in
 * `lib/ai/eval/import/*`; foreign-tool adapters in `lib/ai/eval/import/foreign/*`.
 */

import type { EvalCase } from "./eval"

export type ImportFormat = "csv" | "jsonl" | "json" | "yaml"
export type ForeignFormat = "promptfoo" | "openai-evals" | "langsmith"

/** Column-name → canonical-field mapping. */
export interface FieldSpec {
  /** Source column(s) for the case input. Multiple → combined per `combine`. */
  input: string | string[]
  /** Source column(s) for the reference / expected output. */
  expected?: string | string[]
  /** Source column for an explicit case id. */
  id?: string
  /** Source columns copied verbatim into `metadata`. */
  metadata?: string[]
  /** How to combine multiple `input` columns. Default "concat". */
  combine?: "json" | "concat"
  /** Source column carrying the split name (train / test / validation). */
  split?: string
  /**
   * Split applied to EVERY imported case, for sources that carry it outside the
   * rows — a HuggingFace URI names its split in the query string, and dropping
   * it is why `CaseSubset.split` never matched an imported case: the field
   * existed everywhere except on the rows that needed it.
   */
  splitLiteral?: string
  /**
   * How the imported cases should be graded. Stamped onto every case's
   * `reference.grading`, because nothing deterministic can score an
   * `expectedOutput` without being told how to compare it.
   */
  grading?: import("./grading").GradingSpec
  /**
   * Provenance for the imported cases. Defaults to `"handwritten"`, which is
   * accurate for a hand-authored CSV and wrong for everything else.
   */
  sourceKind?: EvalCase["source"]
}

/** Normalized tabular/structured rows produced by a parser. */
export interface ParsedRows {
  columns: string[]
  rows: Record<string, unknown>[]
}

/** Result of mapping rows to cases — successes + skipped rows with reasons. */
export interface ImportPreview {
  cases: EvalCase[]
  skipped: { row: number; reason: string }[]
}
