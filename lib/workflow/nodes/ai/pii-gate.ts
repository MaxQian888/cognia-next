/**
 * PII gate for workflow LLM nodes (`ai.prompt` v2; inherited by ai.classify /
 * ai.extract through delegation). Runs BEFORE any text leaves the machine:
 *
 *   - "off"    → passthrough (legacy behavior).
 *   - "block"  → fail the step (non-retryable) when the prompt leaks PII.
 *   - "redact" → replace PII with stable placeholders via the shared
 *                `redactText` engine and note the redaction in the output.
 *
 * Reuses the same detector the Twin ingest / connector auto-mode gates use —
 * one PII policy across every LLM egress point.
 */

import { hasNoLeakingPii, redactText } from "@/lib/twin/ingest/redact"

export type PiiGateMode = "off" | "block" | "redact"

export interface PiiGateInput {
  system?: string
  user: string
}

export interface PiiGateResult {
  system?: string
  user: string
  /** True when redact mode actually replaced something. */
  redacted: boolean
}

/** Thrown by "block" mode; tagged non-retryable so the step fails fast. */
export class PiiBlockedError extends Error {
  readonly retryable = false

  constructor() {
    super(
      "PII gate blocked the prompt: it contains personally identifiable " +
        'information (email / phone / id / key …). Remove it or switch the gate to "redact".'
    )
    this.name = "PiiBlockedError"
  }
}

export function applyPiiGate(mode: PiiGateMode | undefined, input: PiiGateInput): PiiGateResult {
  if (!mode || mode === "off") {
    return { system: input.system, user: input.user, redacted: false }
  }

  if (mode === "block") {
    const clean = hasNoLeakingPii(input.user) && (!input.system || hasNoLeakingPii(input.system))
    if (!clean) throw new PiiBlockedError()
    return { system: input.system, user: input.user, redacted: false }
  }

  // redact
  const user = redactText(input.user)
  const system = input.system !== undefined ? redactText(input.system) : undefined
  const redacted =
    Object.keys(user.map).length > 0 || (system !== undefined && Object.keys(system.map).length > 0)
  return {
    system: system?.redacted ?? input.system,
    user: user.redacted,
    redacted,
  }
}
