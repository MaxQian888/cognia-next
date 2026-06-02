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
