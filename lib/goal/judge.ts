/**
 * Judge LLM caller for the `/goal` subsystem (ADR-0013).
 *
 * Runs a single LLM call with the templates from `lib/goal/prompts.ts`,
 * parses the strict-JSON response, and returns a discriminated result so
 * the turn driver can route the outcome through the seven-exit machinery
 * without having to know about LLM SDK details.
 *
 * **Fail-OPEN principle (Hermes carry-over):** when the JSON is
 * unparseable, we return `{ kind: "parse_error", raw }` instead of
 * throwing. The turn driver bumps `judgeFailureCount` and either retries
 * the next turn (default) or auto-pauses on the third consecutive
 * failure. The goal NEVER wedges on judge flakiness — that's the entire
 * value of the Hermes-style fail-open.
 *
 * **Cancellation:** every call accepts an `AbortSignal`. When the signal
 * fires (user `/goal pause` mid-judge, generationId rotation, terminal
 * exit), the result is `{ kind: "aborted" }` — no exception thrown into
 * the caller's await chain. Returning a sentinel keeps `handleTurnComplete`
 * straightforward to read.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractJson } from "@/lib/twin/distill/llm"
import type { Goal } from "@/types/goal"
import { JUDGE_SYSTEM_PROMPT, renderJudgeUserPrompt } from "./prompts"

/** Discriminated outcome of one `evaluateGoal` call. */
export type JudgeResult =
  | {
      kind: "decided"
      done: boolean
      reason: string
      rawResponse: string
      /**
       * 0-based indices of subgoals the judge reports as now complete. Only
       * present when the goal carried a subgoal checklist and the judge
       * returned a valid `completedSubgoals` array. Always sanitised to
       * non-negative integers. Undefined ⇒ the field was absent / malformed
       * (subgoal decomposition is optional and never affects `done`).
       */
      completedSubgoals?: number[]
    }
  | { kind: "parse_error"; raw: string; error: string }
  | { kind: "aborted" }

export interface EvaluateGoalInput {
  goal: Goal
  /** The agent's most recent assistant message text. */
  lastResponse: string
  /** LLM client mirroring the twin distill abstraction. */
  client: LlmClient
  /** AbortSignal — fires when goal is paused/stopped or generationId rotates. */
  signal?: AbortSignal
  /** Hard cap on judge response tokens. Default 200 — judge replies are tiny. */
  maxTokens?: number
  /** Sampling temperature. Default 0 — judge wants determinism. */
  temperature?: number
  /** System prompt override. Default `JUDGE_SYSTEM_PROMPT`. */
  system?: string
}

/**
 * Shape of the judge's expected JSON response. Loose typing because
 * `extractJson` is generic — we validate field types at the call site
 * before trusting them.
 */
interface ParsedJudgePayload {
  done?: unknown
  reason?: unknown
  completedSubgoals?: unknown
}

/**
 * Sanitise the judge's optional `completedSubgoals` field into non-negative
 * integers, or `undefined` when absent/malformed. Tolerant by design — a bad
 * value never affects the `done` verdict.
 */
function parseCompletedSubgoals(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: number[] = []
  for (const n of value) {
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) out.push(n)
  }
  return out.length > 0 ? out : undefined
}

/**
 * Run one judge evaluation. Never throws on judge-side flakiness — every
 * failure mode lands in a `JudgeResult` discriminant the caller can route.
 */
export async function evaluateGoal(input: EvaluateGoalInput): Promise<JudgeResult> {
  const { goal, lastResponse, client, signal, maxTokens, temperature, system } = input

  if (signal?.aborted) {
    return { kind: "aborted" }
  }

  const userPrompt = renderJudgeUserPrompt(goal, lastResponse)

  let raw: string
  try {
    raw = await client.complete(userPrompt, {
      system: system ?? JUDGE_SYSTEM_PROMPT,
      maxTokens: maxTokens ?? goal.config.judgeMaxTokens ?? 200,
      // Judge wants determinism — paraphrasing the same agent reply
      // shouldn't flip the verdict, otherwise we'd spuriously continue
      // when the agent's response is borderline. Per-goal override allowed.
      temperature: temperature ?? 0,
    })
  } catch (err) {
    if (signal?.aborted) {
      return { kind: "aborted" }
    }
    // Network / provider failure is treated as a parse error from the
    // judge's perspective — the turn driver will count it toward
    // `maxJudgeFailures` and pause if the failures pile up.
    return {
      kind: "parse_error",
      raw: "",
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (signal?.aborted) {
    return { kind: "aborted" }
  }

  let parsed: ParsedJudgePayload
  try {
    parsed = extractJson<ParsedJudgePayload>(raw)
  } catch (err) {
    return {
      kind: "parse_error",
      raw,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (typeof parsed.done !== "boolean") {
    return {
      kind: "parse_error",
      raw,
      error: `judge response missing or non-boolean "done" field`,
    }
  }
  const reason = typeof parsed.reason === "string" ? parsed.reason : ""
  return {
    kind: "decided",
    done: parsed.done,
    reason,
    rawResponse: raw,
    completedSubgoals: parseCompletedSubgoals(parsed.completedSubgoals),
  }
}
