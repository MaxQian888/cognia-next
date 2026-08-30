/**
 * Score one finished production trace under one policy.
 *
 * Honest about what this can and cannot know. A trace carries no reference
 * answer, so every reference-based scorer reports `not-applicable` and the
 * trace comes back UNGRADED. That is the correct answer, not a bug: the value
 * of the deterministic tier online is the trajectory scorers (which read tool
 * calls, available whatever the content-capture setting) and the escalation
 * signal. Rubric judges are what grade free-text quality, and they cost money,
 * which is why they are sampled and capped.
 */

import {
  buildObservation,
  builtInEvaluatorVersionId,
  deterministicScorers,
  parseBuiltInEvaluatorVersionId,
  safeScore,
  selectScorers,
  type EvalCase,
  type EvalObservationV1,
  type EvalSample,
  type OnlineEvalPolicyV1,
  type Scorer,
} from "@cognia/eval-core"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { assembleSampleFromSpans } from "@/lib/ai/eval/targets/chat"

/**
 * Turn a trace into the case/sample pair scorers consume.
 *
 * `output` comes from the root span's `outputPreview`, which is only present
 * when content capture is ON. With it off — the default — the answer text is
 * genuinely unavailable, and the resulting empty string makes the text scorers
 * report `not-applicable` rather than grading a blank as a failure.
 */
export function traceToEvalInput(
  spans: readonly AgentTraceSpan[],
  traceId: string
): { evalCase: EvalCase; sample: EvalSample } | undefined {
  if (spans.length === 0) return undefined
  const root = spans.find((span) => !span.parentSpanId) ?? spans[0]
  const sample = assembleSampleFromSpans([...spans], { output: root.outputPreview ?? "" })
  const evalCase: EvalCase = {
    id: `trace:${traceId}`,
    datasetId: "online",
    input: root.inputPreview ?? "",
    capability: root.surface,
    // Not `real-trace` by accident — this case WAS a real trace, and labelling
    // it so is what lets the promotion path tell it from a handwritten one.
    source: "real-trace",
    sourceTraceId: traceId,
    createdAt: root.startTime,
    updatedAt: root.endTime ?? root.startTime,
  }
  return { evalCase, sample }
}

/**
 * Resolve a policy's deterministic evaluator versions to scorers.
 *
 * Unknown ids are dropped rather than defaulting to "all scorers": a policy
 * that names an evaluator this build does not have should evaluate less, never
 * silently more.
 */
export function resolveDeterministicScorers(policy: OnlineEvalPolicyV1): Scorer[] {
  const scorerIds = policy.deterministicEvaluatorVersionIds
    .map(parseBuiltInEvaluatorVersionId)
    .filter((id): id is string => id !== undefined)
  if (scorerIds.length === 0) return []
  return selectScorers(deterministicScorers(), scorerIds)
}

export interface EvaluateTraceInput {
  policy: OnlineEvalPolicyV1
  traceId: string
  spans: readonly AgentTraceSpan[]
  now: number
  newId: (evaluatorVersionId: string) => string
}

export interface EvaluateTraceResult {
  observations: EvalObservationV1[]
  /** True when at least one observation carries a real verdict. */
  graded: boolean
}

export async function evaluateTraceDeterministically(
  input: EvaluateTraceInput
): Promise<EvaluateTraceResult> {
  const prepared = traceToEvalInput(input.spans, input.traceId)
  if (!prepared) return { observations: [], graded: false }

  const scorers = resolveDeterministicScorers(input.policy)
  const scores = await Promise.all(
    scorers.map((scorer) => safeScore(scorer, prepared.sample, prepared.evalCase))
  )

  // Stamped from the SCORER, never from the policy's id list by index. Those
  // are two different index spaces: `selectScorers` filters the factory list,
  // so `scorers` is in catalog order while `deterministicEvaluatorVersionIds`
  // is in author order — and unresolvable ids are dropped, so the arrays can
  // differ in length too. Indexing one by the other attributes each score to
  // whichever evaluator happens to sit at that position, and
  // `evaluatorVersionId` is the indexed column whose whole purpose is making
  // "this score came from that evaluator" answerable later.
  const observations = scores.map((score, index) =>
    buildObservation({
      id: input.newId(scorers[index].id),
      scope: { traceId: input.traceId, caseId: prepared.evalCase.id },
      origin: "online",
      evaluatorVersionId: builtInEvaluatorVersionId(scorers[index].id),
      score,
      createdAt: input.now,
    })
  )

  return {
    observations,
    graded: observations.some((observation) => observation.score.status === "scored"),
  }
}
