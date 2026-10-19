/**
 * Prompt templates for the `/loop` subsystem (self-paced mode).
 *
 * Each self-paced iteration re-sends the user's (PII-redacted) prompt as a
 * silent user message, framed with the iteration counter and ended with the
 * trailer directive: the model must close its reply with a single-line JSON
 * object `{"continue": bool, "delaySeconds": int, "reason": "..."}` so the
 * turn driver can extract the next delay — or end the loop when the model
 * declares the task provably complete (with an explicit no-false-completion
 * clause, mirroring the goal subsystem's promise gate posture).
 *
 * PII redaction happens before this layer (`lib/goal/redact-objective.ts`
 * is reused verbatim — redaction is one cross-cutting concern, not two).
 */

import type { Loop } from "@/types/loop"
import { resolvePrompt } from "@/lib/prompts/resolve"
import { definePrompt } from "@/lib/prompts/types"

/**
 * The trailer contract appended to every iteration message. Delay bounds
 * mirror `LoopConfig.minDelayMs` / `maxDelayMs` defaults (1 min – 1 hr).
 */
export const LOOP_TRAILER_DIRECTIVE = `When you finish this iteration, end your reply with EXACTLY one line of JSON (no markdown fence):
{"continue": true, "delaySeconds": <60-3600>, "reason": "<why this delay>"}

Pick the delay from what you observe — short while something is actively moving, long when quiet. If the task is provably complete and no further iterations can add value, reply with {"continue": false, "reason": "<what was delivered>"} instead. Do NOT declare completion unless it is literally true — never end the loop just to escape it.`

/**
 * The per-iteration user message (ADR-0236), rendered from this definition.
 *
 * Inspect-only: the trailer it ends with is machine-read protocol
 * (`parseLoopTrailer` decides from it whether the loop continues and when),
 * and the counter header is the only other wording, so there is no editable
 * part worth splitting off. `{{prompt}}` is the user's own (redacted) loop
 * prompt.
 */
export const LOOP_ITERATION_PROMPT = definePrompt({
  id: "agent.loop.iteration",
  contractVersion: 1,
  kind: "protocol",
  group: "agents",
  operation: "inspect-only",
  scopes: [],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app", "cli"],
  variables: [
    { name: "iteration", required: true, maxChars: 16 },
    { name: "maxIterations", required: true, maxChars: 16 },
    { name: "prompt", required: true, maxChars: 200_000 },
  ],
  requiredFragments: ['"continue"', '"delaySeconds"', '"reason"'],
  outputContract:
    'Sent as a silent user message each self-paced iteration; the reply\'s last JSON line is parsed for {"continue", "delaySeconds", "reason"} to schedule the next iteration or end the loop.',
  consumers: ["lib/loop/prompts.ts"],
  defaultBody: `[Loop iteration {{iteration}} of {{maxIterations}}]

{{prompt}}

${LOOP_TRAILER_DIRECTIVE}`,
})

/**
 * The per-iteration user message. The 1-indexed `iteration` reflects the
 * turn ABOUT to run.
 */
export function renderLoopIterationMessage(loop: Loop): string {
  return resolvePrompt(LOOP_ITERATION_PROMPT, {
    values: {
      iteration: String(loop.iterations + 1),
      maxIterations: String(loop.config.maxIterations),
      prompt: loop.safePrompt,
    },
  }).text
}
