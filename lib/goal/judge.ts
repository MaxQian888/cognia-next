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
  | { kind: "decided"; done: boolean; reason: string; rawResponse: string }
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
}

/**
 * Shape of the judge's expected JSON response. Loose typing because
 * `extractJson` is generic — we validate field types at the call site
 * before trusting them.
 */
interface ParsedJudgePayload {
  done?: unknown
  reason?: unknown
}

/**
 * Run one judge evaluation. Never throws on judge-side flakiness — every
 * failure mode lands in a `JudgeResult` discriminant the caller can route.
 */
export async function evaluateGoal(input: EvaluateGoalInput): Promise<JudgeResult> {
  const { goal, lastResponse, client, signal, maxTokens } = input

  if (signal?.aborted) {
    return { kind: "aborted" }
  }

  const userPrompt = renderJudgeUserPrompt(goal, lastResponse)

  let raw: string
  try {
    raw = await client.complete(userPrompt, {
      system: JUDGE_SYSTEM_PROMPT,
      maxTokens: maxTokens ?? 200,
      // Judge wants determinism — paraphrasing the same agent reply
      // shouldn't flip the verdict, otherwise we'd spuriously continue
      // when the agent's response is borderline.
      temperature: 0,
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
  }
}
