/**
 * Subgoal decomposition for the `/goal` subsystem (ADR-0019 "Future Work").
 *
 * One LLM call turns a goal's redacted `safeObjective` into an ordered
 * checklist of sub-steps. Mirrors the judge (`lib/goal/judge.ts`):
 *   - reuses the `LlmClient` abstraction + `extractJson` parser,
 *   - is **fail-OPEN** — any parse / network failure returns `[]` rather than
 *     throwing, so a flaky model never wedges the UI,
 *   - is abort-aware via an optional `AbortSignal`.
 *
 * Only `safeObjective` (already PII-redacted) is ever sent — never
 * `rawObjective`.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractJson } from "@/lib/twin/distill/llm"
import type { Goal, GoalSubgoal } from "@/types/goal"
import { SUBGOAL_DECOMPOSE_SYSTEM_PROMPT, renderSubgoalDecomposeUserPrompt } from "./prompts"

/** Hard cap on generated steps — keeps the checklist scannable. */
export const MAX_SUBGOALS = 12

/** Max characters per step before truncation (defensive against runaway output). */
const MAX_STEP_LEN = 160

export interface DecomposeObjectiveInput {
  goal: Goal
  /** LLM client (same abstraction the judge uses). */
  client: LlmClient
  /** Abort signal — decomposition resolves to `[]` when fired. */
  signal?: AbortSignal
  /** Response token cap. Default 400 — the checklist is small. */
  maxTokens?: number
  /** Sampling temperature. Default 0.2 — slight variety, mostly deterministic. */
  temperature?: number
}

interface ParsedDecomposition {
  steps?: unknown
}

/**
 * Run one decomposition. Returns a cleaned, de-duplicated, capped list of step
 * strings. Never throws: returns `[]` on abort, network error, or unparseable
 * output (fail-OPEN — the caller renders an empty state + a retry affordance).
 */
export async function decomposeObjective(input: DecomposeObjectiveInput): Promise<string[]> {
  const { goal, client, signal, maxTokens, temperature } = input
  if (signal?.aborted) return []

  let raw: string
  try {
    raw = await client.complete(renderSubgoalDecomposeUserPrompt(goal), {
      system: SUBGOAL_DECOMPOSE_SYSTEM_PROMPT,
      maxTokens: maxTokens ?? 400,
      temperature: temperature ?? 0.2,
    })
  } catch {
    return []
  }

  if (signal?.aborted) return []

  let parsed: ParsedDecomposition
  try {
    parsed = extractJson<ParsedDecomposition>(raw)
  } catch {
    return []
  }

  if (!Array.isArray(parsed.steps)) return []

  const seen = new Set<string>()
  const steps: string[] = []
  for (const entry of parsed.steps) {
    if (typeof entry !== "string") continue
    const text = entry.trim().slice(0, MAX_STEP_LEN)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    steps.push(text)
    if (steps.length >= MAX_SUBGOALS) break
  }
  return steps
}

/** Build fresh `GoalSubgoal` rows from raw step strings (all incomplete). */
export function toSubgoals(steps: string[]): GoalSubgoal[] {
  return steps.map((text, order) => ({
    id: crypto.randomUUID(),
    text,
    done: false,
    order,
  }))
}

/**
 * Apply a judge-reported set of completed 0-based indices onto an existing
 * checklist. Out-of-range indices are ignored; completion is monotonic (a
 * step already `done` stays `done`). Returns a new array only when something
 * actually changed, else the original reference (so callers can skip a write).
 */
export function markSubgoalsComplete(
  subgoals: GoalSubgoal[],
  completedIndices: number[]
): GoalSubgoal[] {
  if (subgoals.length === 0 || completedIndices.length === 0) return subgoals
  const complete = new Set(completedIndices)
  let changed = false
  const next = subgoals.map((s) => {
    if (!s.done && complete.has(s.order)) {
      changed = true
      return { ...s, done: true }
    }
    return s
  })
  return changed ? next : subgoals
}
