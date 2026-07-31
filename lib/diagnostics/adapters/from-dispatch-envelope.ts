/**
 * `PluginDispatchErrorEnvelope` → {@link CogniaDiagnostic} inputs.
 *
 * `lib/claude/agents/dispatch-error.ts` already does the hard part: it decides
 * whether a subagent dispatch died from an abort, a sidecar exit, a guard
 * refusal, or a provider fault, and it re-uses the provider classifier for the
 * last of those. Its output was only ever rendered *to the model*
 * (`renderDispatchOutcomeForModel`) — the user saw nothing distinct.
 *
 * This is a field lift, not a re-classification: the nine provider codes reuse
 * the same table as `from-provider-error-class`, so the two can't drift.
 */

import { PROVIDER_CLASS_TO_CODE } from "@cognia/diagnostics/adapters/from-provider-error-class"
import type { DiagnosticCode, DiagnosticMeta } from "@cognia/diagnostics"
import type { PluginDispatchErrorEnvelope } from "@/types/plugin/plugin-agent-sdk"

type DispatchCode = PluginDispatchErrorEnvelope["code"]

/** The seven dispatch-local codes; the other nine are provider classes. */
const DISPATCH_LOCAL_TO_CODE: Readonly<
  Record<Exclude<DispatchCode, keyof typeof PROVIDER_CLASS_TO_CODE>, DiagnosticCode>
> = {
  "sidecar-exited": "sidecarExited",
  aborted: "aborted",
  interrupted: "interrupted",
  "rejection-cycle": "dispatchRejectedCycle",
  "rejection-max-depth": "dispatchRejectedDepth",
  "rejection-policy": "dispatchRejectedPolicy",
  "budget-exhausted": "budgetExhausted",
  "deadline-exceeded": "deadlineExceeded",
}

export interface DispatchDiagnosis {
  code: DiagnosticCode
  message: string
  /** From the envelope — the dispatch layer's own retry verdict wins. */
  retryable: boolean
  meta: DiagnosticMeta
}

export function diagnoseDispatchEnvelope(envelope: PluginDispatchErrorEnvelope): DispatchDiagnosis {
  const code =
    envelope.code in PROVIDER_CLASS_TO_CODE
      ? PROVIDER_CLASS_TO_CODE[envelope.code as keyof typeof PROVIDER_CLASS_TO_CODE]
      : DISPATCH_LOCAL_TO_CODE[envelope.code as keyof typeof DISPATCH_LOCAL_TO_CODE]

  const meta: DiagnosticMeta = {}
  if (envelope.retryAfterMs !== undefined) meta.retryAfterMs = envelope.retryAfterMs
  if (envelope.attempts !== undefined) meta.attempts = envelope.attempts

  return {
    code: code ?? "unknown",
    message: envelope.message,
    retryable: envelope.retryable,
    meta,
  }
}
