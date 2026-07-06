/**
 * `dispatchStructured` — typed structured output over `dispatchTeammate`
 * (ADR-0022 addendum). The ultracode quality patterns need verifiers / judges /
 * critics / synthesizers to return typed verdicts, scores, findings, and
 * reports. There is no forced-JSON tool on the sidecar path, so this helper
 * mirrors Claude Code's StructuredOutput semantics in a channel-uniform way:
 * instruct the teammate to emit one fenced JSON block, parse it with the
 * existing `parseProposedPlan`, validate against a Zod schema, and retry up to
 * `maxAttempts` times with the validation error fed back.
 *
 * Empty-output / LLM failures propagate from `dispatchTeammate` (already
 * breaker-recorded); only parse/validation failures trigger the in-loop retry.
 *
 * Forward-progress: `acceptOnExhaustion` (opt-in) borrows omp's bounded-retry-
 * then-accept policy — after the budget is spent, rather than throwing away a
 * long subagent run, return the last JSON-parseable payload with
 * `schemaOverridden: true` so a fan-out of many subagents isn't sunk by one
 * that never quite matched the schema. Default stays strict (throw) so existing
 * callers are unchanged.
 */

import type { z } from "zod"
import { dispatchTeammate, type DispatchTeammateArgs } from "./dispatch-teammate"
import { parseProposedPlan } from "../agent-team-runtime"
import type { TeamRunContext } from "./team-run-context"

const JSON_INSTRUCTION =
  "\n\nWhen you are done, respond with ONLY a single fenced JSON code block " +
  "(```json … ```) that matches the required schema. Put no prose before or after the block."

/** Default retry budget — kept at 2 so existing strict callers are unchanged. */
const DEFAULT_MAX_ATTEMPTS = 2

export interface DispatchStructuredOptions {
  /** Human-readable schema description appended to the prompt for the model. */
  schemaHint?: string
  /** Retry budget (total attempts, ≥ 1). Defaults to `DEFAULT_MAX_ATTEMPTS` (2). */
  maxAttempts?: number
  /**
   * When true, after the retry budget is spent WITHOUT a schema-valid response,
   * return the last JSON-parseable payload (cast to `T`) with
   * `schemaOverridden: true` instead of throwing — a forward-progress guarantee
   * for fan-outs. If no attempt ever produced parseable JSON there is nothing to
   * accept, so it still throws. Default false (strict: throw on exhaustion).
   */
  acceptOnExhaustion?: boolean
}

export interface DispatchStructuredResult<T> {
  value: T
  teammateId: string
  raw: string
  /**
   * True when the value was accepted past schema validation via
   * `acceptOnExhaustion` — it parsed as JSON but did NOT satisfy the schema, so
   * consumers must read it defensively. Always false on a validated result.
   */
  schemaOverridden: boolean
}

/**
 * Dispatch a teammate and return validated structured output of type `T`.
 * Throws if no valid output is produced within `maxAttempts` attempts, unless
 * `acceptOnExhaustion` is set and at least one attempt produced parseable JSON.
 */
export async function dispatchStructured<T>(
  teamCtx: TeamRunContext,
  args: Omit<DispatchTeammateArgs, "validateOutput" | "recordToStore" | "prompt"> & {
    prompt: string
  },
  schema: z.ZodType<T>,
  opts: DispatchStructuredOptions = {}
): Promise<DispatchStructuredResult<T>> {
  const schemaHint = opts.schemaHint ? `\n\nSchema:\n${opts.schemaHint}` : ""
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  let lastError = "unknown error"
  // Last response that parsed as JSON (even if schema-invalid) — the candidate
  // for `acceptOnExhaustion`. Null until at least one attempt yields JSON.
  let lastParsed: { plan: unknown; teammateId: string; raw: string } | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const retryNote =
      attempt === 0
        ? ""
        : `\n\nYour previous response was invalid: ${lastError}\nReturn corrected JSON only — no other text.`
    const prompt = `${args.prompt}${JSON_INSTRUCTION}${schemaHint}${retryNote}`

    const result = await dispatchTeammate(teamCtx, {
      ...args,
      prompt,
      validateOutput: true,
      recordToStore: false,
    })

    const parsed = parseProposedPlan(result.text)
    if (!parsed.ok) {
      lastError = `response was not valid JSON (${parsed.reason})`
      continue
    }
    lastParsed = { plan: parsed.plan, teammateId: result.teammateId, raw: result.text }

    const validated = schema.safeParse(parsed.plan)
    if (!validated.success) {
      lastError = validated.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")
      continue
    }

    return {
      value: validated.data,
      teammateId: result.teammateId,
      raw: result.text,
      schemaOverridden: false,
    }
  }

  if (opts.acceptOnExhaustion && lastParsed) {
    return {
      value: lastParsed.plan as T,
      teammateId: lastParsed.teammateId,
      raw: lastParsed.raw,
      schemaOverridden: true,
    }
  }

  throw new Error(
    `dispatchStructured: no valid structured output after ${maxAttempts} attempts — ${lastError}`
  )
}
