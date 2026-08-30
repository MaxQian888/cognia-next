/**
 * Assertion scorer (L1 tier — no LLM).
 *
 * Reference-based substring check on the final output. Cheapest possible
 * response-quality signal: the case lists substrings the answer MUST contain
 * (`reference.expectedContains`); value is the fraction present. Matching is
 * case-insensitive to reduce brittleness on free-form text.
 */

import type { EvalCase, EvalSample, Score, Scorer } from "../domain/eval"

export const assertionScorer: Scorer = {
  id: "assertion",
  dimension: "response-quality",
  requiresLlm: false,
  gating: true,
  score(sample: EvalSample, evalCase: EvalCase): Score {
    const expected = evalCase.reference?.expectedContains
    if (!expected || expected.length === 0) {
      return {
        scorerId: this.id,
        dimension: "response-quality",
        status: "not-applicable",
        value: 0,
        passed: false,
        error: "not-applicable: no expectedContains reference",
      }
    }
    const haystack = sample.output.toLowerCase()
    const missing = expected.filter((needle) => !haystack.includes(needle.toLowerCase()))
    const value = (expected.length - missing.length) / expected.length
    return {
      scorerId: this.id,
      dimension: "response-quality",
      status: "scored",
      value,
      passed: value >= 1,
      metadata: { missing, total: expected.length },
    }
  },
}
