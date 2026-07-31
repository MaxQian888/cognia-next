/**
 * Structured error envelopes for `dispatch_agent` runs.
 *
 * One place maps every failure a dispatched subagent can hit — provider errors,
 * sidecar death, aborts, nesting-guard refusals — onto the shared
 * `PluginDispatchErrorEnvelope`, reusing the provider taxonomy from
 * `@cognia/provider-routing/error-classifier` (NOT a third classification).
 *
 * Pure and Dexie-free so both hosts (renderer + CLI) can import it.
 */

import {
  classifyProviderErrorInfo,
  isTransientErrorClass,
} from "@cognia/provider-routing/error-classifier"
import type {
  PluginDispatchErrorEnvelope,
  PluginSubagentDispatchRejection,
  PluginSubagentDispatchResult,
} from "@/types/plugin/plugin-agent-sdk"

/**
 * Duck-typed `RunAndCaptureError.code` — read structurally so this module never
 * imports `run-and-capture` (which drags the IPC graph into the CLI bundle).
 */
function runAndCaptureCode(err: unknown): string | undefined {
  if (err instanceof Error && "code" in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string") return code
  }
  return undefined
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Map a thrown dispatch error onto the structured envelope. */
export function toDispatchErrorEnvelope(
  err: unknown,
  opts: { aborted?: boolean; partialText?: string } = {}
): PluginDispatchErrorEnvelope {
  const message = messageOf(err)
  const partial = opts.partialText ? { partialText: opts.partialText } : {}
  const code = runAndCaptureCode(err)
  if (opts.aborted || code === "aborted") {
    return { code: "aborted", retryable: false, message, ...partial }
  }
  if (code === "sidecar_exited") {
    // The Rust supervisor respawns the sidecar; one retry is worthwhile.
    return { code: "sidecar-exited", retryable: true, message, ...partial }
  }
  const info = classifyProviderErrorInfo(message)
  return {
    code: info.errorClass,
    retryable: isTransientErrorClass(info.errorClass),
    message,
    ...partial,
    ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}),
  }
}

/** Envelope for a nesting-guard refusal (cycle / max-depth / policy). */
export function envelopeForRejection(
  rejection: PluginSubagentDispatchRejection
): PluginDispatchErrorEnvelope {
  const code =
    rejection.reason === "cycle"
      ? "rejection-cycle"
      : rejection.reason === "policy"
        ? "rejection-policy"
        : "rejection-max-depth"
  return { code, retryable: false, message: rejection.message }
}

/** Envelope for the subtree token-budget refusal. */
export function envelopeForBudgetExhausted(message: string): PluginDispatchErrorEnvelope {
  return { code: "budget-exhausted", retryable: false, message }
}

/**
 * Model-facing rendering of a dispatch outcome (Claude Code v2.1.199
 * semantics): a run that streamed text before dying returns that partial
 * output plus an explicit cut-off note; a text-less failure is a hard
 * "terminated early" error. Success / rejection / cancellation keep the
 * pre-envelope formatting. Model-facing strings live in .ts — the i18n rule
 * applies to user-facing .tsx surfaces, not tool results.
 */
export function renderDispatchOutcomeForModel(
  label: string,
  r: PluginSubagentDispatchResult
): string {
  if (r.rejection) return `[${label}] ${r.text}`
  if (r.finishReason === "cancelled") return `[${label}] cancelled.`
  const envelope = r.errorEnvelope
  if (r.finishReason === "error" && envelope) {
    if (envelope.partialText) {
      return `[${label}]\n${envelope.partialText}\n\n[Subagent was cut off by an error and did not finish: ${envelope.message}]`
    }
    return `[${label}] Subagent terminated early due to ${envelope.message}`
  }
  return `[${label}]\n${r.text}`
}
