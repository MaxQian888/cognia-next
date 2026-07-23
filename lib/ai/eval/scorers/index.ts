/**
 * Scorer barrel + standard scorer-set builders.
 *
 * `deterministicScorers()` is the L1+L2 no-LLM tier the CI gate runs every
 * change (cheap, fast, no provider key needed). `llmScorers()` adds the L3
 * judge + RAG scorers for the full in-app run; the caller injects a
 * cross-model judge `LlmClient`.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import type { Scorer } from "@/types/eval/eval"
import {
  toolSelectionScorer,
  toolArgsScorer,
  toolOrderScorer,
  redundancyScorer,
} from "./tool-correctness"
import { trajectoryScorer, makeTrajectoryScorer } from "./trajectory"
import { assertionScorer } from "./assertion"
import { matchScorers } from "./match"
import { costScorer, makeCostScorer, type CostBudget } from "./cost"
import { makeJudgeScorer } from "./judge"
import { makeRagScorer } from "./rag"

export {
  toolSelectionScorer,
  toolArgsScorer,
  toolOrderScorer,
  redundancyScorer,
  trajectoryScorer,
  makeTrajectoryScorer,
  assertionScorer,
  costScorer,
  makeCostScorer,
  makeJudgeScorer,
  makeRagScorer,
}
export {
  exactMatchScorer,
  containsAnyScorer,
  regexMatchScorer,
  numericMatchScorer,
  choiceMatchScorer,
  matchScorers,
  normalizeAnswer,
  extractNumber,
  extractChoice,
} from "./match"

export interface DeterministicScorerOptions {
  /** Optional cost budget to turn the cost scorer into a gate. */
  costBudget?: CostBudget
}

/**
 * The L1+L2 deterministic tier — safe to run in CI with no LLM.
 *
 * Includes the five reference-answer matchers ({@link matchScorers}). Each is
 * inert unless the case's `reference.grading` selects its mode, so adding them
 * costs nothing on tool-use datasets while making imported benchmarks gradable
 * without a judge.
 */
export function deterministicScorers(options: DeterministicScorerOptions = {}): Scorer[] {
  return [
    toolSelectionScorer,
    toolArgsScorer,
    toolOrderScorer,
    redundancyScorer,
    trajectoryScorer,
    assertionScorer,
    ...matchScorers,
    options.costBudget ? makeCostScorer(options.costBudget) : costScorer,
    makeRagScorer({ metric: "context-recall" }),
  ]
}

export interface LlmScorerOptions {
  /** Cross-model judge client (build via `buildRendererLlmClient`). */
  client: LlmClient
  /** Include the RAG groundedness scorers. Default true. */
  includeRag?: boolean
}

/** The L3 judge + RAG tier for full in-app runs. Needs an LLM client. */
export function llmScorers(options: LlmScorerOptions): Scorer[] {
  const { client } = options
  const scorers: Scorer[] = [
    makeJudgeScorer({
      client,
      criterion: "task completion",
      rubric: "Pass only if the answer fully accomplishes what the user asked for.",
    }),
    makeJudgeScorer({
      client,
      criterion: "instruction following",
      rubric: "Pass only if the answer respects every explicit constraint in the request.",
    }),
  ]
  if (options.includeRag !== false) {
    scorers.push(
      makeRagScorer({ metric: "faithfulness", client }),
      makeRagScorer({ metric: "answer-relevancy", client }),
      makeRagScorer({ metric: "context-precision", client })
    )
  }
  return scorers
}
