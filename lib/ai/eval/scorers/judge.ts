/**
 * LLM-as-judge scorer (L3 tier — needs an LLM).
 *
 * Encodes the applied-evals best practices: ONE judge per criterion, BINARY
 * pass/fail (not Likert), chain-of-thought before the verdict, and fail-open
 * (a flaky judge never crashes the run — it yields an errored Score the report
 * treats as not-applicable). Cross-model judging (don't judge with the model
 * that generated the answer, to dodge self-preference bias) is the caller's
 * responsibility: build the {@link LlmClient} via `buildRendererLlmClient` with
 * a different `modelOverride` than the target.
 *
 * Pointwise single-candidate judging has no position bias, so no order-swap is
 * needed here (that matters for pairwise comparisons).
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractJson } from "@/lib/twin/distill/llm"
import type { EvalCase, EvalDimension, EvalSample, Score, Scorer } from "@/types/eval/eval"

const JUDGE_SYSTEM_PROMPT =
  "You are a strict, impartial evaluator of an AI assistant's answer. You judge " +
  "exactly one criterion. Reason briefly step by step, then output ONLY a JSON " +
  'object: {"pass": true|false, "reasoning": "<one sentence>"}. Be conservative: ' +
  "if the criterion is not clearly satisfied, return false."

export interface JudgeScorerOptions {
  /** Judge LLM client. Build cross-model via `buildRendererLlmClient`. */
  client: LlmClient
  /** The single criterion this judge evaluates, e.g. "task completion". */
  criterion: string
  /** Rubric text describing what pass vs fail means for this criterion. */
  rubric: string
  /** Scorer id; defaults to `judge-<slugified criterion>`. */
  id?: string
  /** Dimension grouping; defaults to "response-quality". */
  dimension?: EvalDimension
  /** Hard cap on judge response tokens. Default 300. */
  maxTokens?: number
}

interface JudgePayload {
  pass?: unknown
  reasoning?: unknown
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function renderHistory(evalCase: EvalCase): string {
  if (!evalCase.history || evalCase.history.length === 0) return ""
  const turns = evalCase.history.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n")
  return `Prior conversation:\n${turns}\n\n`
}

export function makeJudgeScorer(options: JudgeScorerOptions): Scorer {
  const dimension: EvalDimension = options.dimension ?? "response-quality"
  const id = options.id ?? `judge-${slug(options.criterion)}`
  const maxTokens = options.maxTokens ?? 300

  return {
    id,
    dimension,
    requiresLlm: true,
    async score(sample: EvalSample, evalCase: EvalCase): Promise<Score> {
      const referenceBlock = evalCase.reference?.expectedOutput
        ? `Reference (gold) answer:\n${evalCase.reference.expectedOutput}\n\n`
        : ""
      const prompt =
        `Criterion: ${options.criterion}\n` +
        `Rubric: ${options.rubric}\n\n` +
        `${renderHistory(evalCase)}` +
        `User request:\n${evalCase.input}\n\n` +
        `${referenceBlock}` +
        `Assistant answer:\n${sample.output}\n\n` +
        `Does the answer satisfy the criterion? Reason, then output the JSON verdict.`

      let raw: string
      try {
        raw = await options.client.complete(prompt, {
          system: JUDGE_SYSTEM_PROMPT,
          temperature: 0,
          maxTokens,
        })
      } catch (err) {
        return {
          scorerId: id,
          dimension,
          value: 0,
          passed: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }

      let parsed: JudgePayload
      try {
        parsed = extractJson<JudgePayload>(raw)
      } catch (err) {
        return {
          scorerId: id,
          dimension,
          value: 0,
          passed: false,
          error: `judge parse error: ${err instanceof Error ? err.message : String(err)}`,
        }
      }

      if (typeof parsed.pass !== "boolean") {
        return {
          scorerId: id,
          dimension,
          value: 0,
          passed: false,
          error: 'judge response missing or non-boolean "pass" field',
        }
      }

      return {
        scorerId: id,
        dimension,
        value: parsed.pass ? 1 : 0,
        passed: parsed.pass,
        ...(typeof parsed.reasoning === "string" ? { reasoning: parsed.reasoning } : {}),
      }
    },
  }
}
