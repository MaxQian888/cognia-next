/**
 * A window onto every provider call a smoke run makes (ADR-0188 D20).
 *
 * The ledger records what it reserved and settled; this records what the
 * executor saw on the way: how long each call took, the provider's own
 * `retry-after`, the finish reason and whether it threw. Joined with the
 * ledger's attempt rows by attempt id, it is the retry observability the live
 * report carries: a call the executor made that the ledger never reserved
 * would show up here and nowhere else.
 *
 * It changes nothing about the call: same request, same signal, same answer.
 */

import type { RawUsage } from "../usage/normalize"
import type { RoleCallExecutor, RoleCallRequest } from "../workflows/ports"

export interface ObservedCall {
  runId: string
  logicalStepId: string
  attemptId: string
  role: string
  deploymentId: string
  startedAt: number
  latencyMs: number
  outcome: "ok" | "error" | "threw"
  errorClass: string | null
  retryAfterMs: number | null
  providerRequestId: string | null
  finishReason: "stop" | "length" | "tool_calls" | null
  usage: RawUsage | null
}

export interface ObservedExecutor {
  executor: RoleCallExecutor
  /** Every call so far, in the order they started. */
  readonly calls: readonly ObservedCall[]
}

export function observeExecutor(inner: RoleCallExecutor, now: () => number): ObservedExecutor {
  const calls: ObservedCall[] = []
  const base = (request: RoleCallRequest, startedAt: number) => ({
    runId: request.runId,
    logicalStepId: request.logicalStepId,
    attemptId: request.attemptId,
    role: request.role,
    deploymentId: request.deploymentId,
    startedAt,
  })
  return {
    calls,
    executor: {
      async call(request, signal) {
        const startedAt = now()
        let response
        try {
          response = await inner.call(request, signal)
        } catch (error) {
          calls.push({
            ...base(request, startedAt),
            latencyMs: now() - startedAt,
            outcome: "threw",
            errorClass: error instanceof Error ? error.name : "unknown",
            retryAfterMs: null,
            providerRequestId: null,
            finishReason: null,
            usage: null,
          })
          throw error
        }
        calls.push(
          response.outcome === "ok"
            ? {
                ...base(request, startedAt),
                latencyMs: now() - startedAt,
                outcome: "ok",
                errorClass: null,
                retryAfterMs: null,
                providerRequestId: response.providerRequestId,
                finishReason: response.finishReason,
                usage: response.usage,
              }
            : {
                ...base(request, startedAt),
                latencyMs: now() - startedAt,
                outcome: "error",
                errorClass: response.errorClass,
                retryAfterMs: response.retryAfterMs ?? null,
                providerRequestId: response.providerRequestId ?? null,
                finishReason: null,
                usage: response.usage ?? null,
              }
        )
        return response
      },
    },
  }
}
