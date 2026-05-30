/**
 * `dispatchStructured` — typed structured output over `dispatchTeammate`
 * (ADR-0022 addendum). The ultracode quality patterns need verifiers / judges /
 * critics / synthesizers to return typed verdicts, scores, findings, and
 * reports. There is no forced-JSON tool on the sidecar path, so this helper
 * mirrors Claude Code's StructuredOutput semantics in a channel-uniform way:
 * instruct the teammate to emit one fenced JSON block, parse it with the
 * existing `parseProposedPlan`, validate against a Zod schema, and retry ONCE
 * with the validation error fed back.
 *
 * Empty-output / LLM failures propagate from `dispatchTeammate` (already
 * breaker-recorded); only parse/validation failures trigger the in-loop retry.
 */

import type { z } from "zod"
import { dispatchTeammate, type DispatchTeammateArgs } from "./dispatch-teammate"
import { parseProposedPlan } from "../agent-team-runtime"
import type { TeamRunContext } from "./team-run-context"

const JSON_INSTRUCTION =
  "\n\nWhen you are done, respond with ONLY a single fenced JSON code block " +
  "(```json … ```) that matches the required schema. Put no prose before or after the block."

export interface DispatchStructuredOptions {
  /** Human-readable schema description appended to the prompt for the model. */
  schemaHint?: string
}

export interface DispatchStructuredResult<T> {
  value: T
  teammateId: string
  raw: string
}

/**
 * Dispatch a teammate and return validated structured output of type `T`.
 * Throws if no valid output is produced within two attempts.
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
  let lastError = "unknown error"

  for (let attempt = 0; attempt < 2; attempt += 1) {
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

    const validated = schema.safeParse(parsed.plan)
    if (!validated.success) {
      lastError = validated.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")
      continue
    }

    return { value: validated.data, teammateId: result.teammateId, raw: result.text }
  }

  throw new Error(`dispatchStructured: no valid structured output after 2 attempts — ${lastError}`)
}
