/**
 * Canonical scorer registry — the ONE source of truth for the set of scorer
 * ids the default scorer tiers emit, each tagged with its dimension and whether
 * it needs an LLM judge client.
 *
 * The run-config dialog and the eval settings section both render scorer
 * pickers; before this catalog they each hardcoded their own id list, which
 * drifted from the real scorer factory ids (e.g. `redundancy` vs the real
 * `tool-redundancy`), silently breaking scorer-subset filtering. `catalog.test`
 * pins this list to the actual `deterministicScorers()` + `llmScorers()` output
 * so the drift can never recur.
 */

import type { EvalDimension } from "@/types/eval/eval"

export interface ScorerCatalogEntry {
  /** The scorer's stable id — matches the `Scorer.id` the factory produces. */
  id: string
  dimension: EvalDimension
  /** True for the L3 judge / RAG-generation scorers that call an LLM. */
  requiresLlm: boolean
}

/**
 * Every scorer id the standard tiers can produce, in report order (deterministic
 * L1+L2 first, then the L3 judge / RAG-generation tier). Consumers group by
 * {@link ScorerCatalogEntry.dimension} and gate the `requiresLlm` ones behind a
 * resolved judge client.
 */
export const SCORER_CATALOG: readonly ScorerCatalogEntry[] = [
  { id: "tool-selection", dimension: "tool-use", requiresLlm: false },
  { id: "tool-args", dimension: "tool-use", requiresLlm: false },
  { id: "tool-order", dimension: "tool-use", requiresLlm: false },
  { id: "tool-redundancy", dimension: "tool-use", requiresLlm: false },
  { id: "trajectory-unordered", dimension: "tool-use", requiresLlm: false },
  { id: "assertion", dimension: "response-quality", requiresLlm: false },
  { id: "cost", dimension: "cost", requiresLlm: false },
  { id: "rag-context-recall", dimension: "rag", requiresLlm: false },
  { id: "judge-task-completion", dimension: "response-quality", requiresLlm: true },
  { id: "judge-instruction-following", dimension: "response-quality", requiresLlm: true },
  { id: "rag-faithfulness", dimension: "rag", requiresLlm: true },
  { id: "rag-answer-relevancy", dimension: "rag", requiresLlm: true },
  { id: "rag-context-precision", dimension: "rag", requiresLlm: true },
] as const

/** All scorer ids, in catalog order. */
export const ALL_SCORER_IDS: readonly string[] = SCORER_CATALOG.map((s) => s.id)

/** The deterministic (no-LLM) scorer ids — the tier a run can always execute. */
export const DETERMINISTIC_SCORER_IDS: readonly string[] = SCORER_CATALOG.filter(
  (s) => !s.requiresLlm
).map((s) => s.id)

/** The four dimensions, in catalog order (each appears once). */
export const SCORER_DIMENSIONS: readonly EvalDimension[] = SCORER_CATALOG.reduce<EvalDimension[]>(
  (acc, s) => (acc.includes(s.dimension) ? acc : [...acc, s.dimension]),
  []
)

/** Catalog entries for one dimension, preserving catalog order. */
export function scorersForDimension(dimension: EvalDimension): ScorerCatalogEntry[] {
  return SCORER_CATALOG.filter((s) => s.dimension === dimension)
}

/** Drop ids not in the catalog (defends the persisted default against renames). */
export function sanitizeScorerIds(ids: readonly string[]): string[] {
  const known = new Set(ALL_SCORER_IDS)
  return ids.filter((id) => known.has(id))
}
