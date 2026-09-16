/**
 * One utility call's run, from reservation to seal (ADR-0188 D27, B2).
 *
 * D27 puts every LLM generation through the ledger, background utilities
 * included — a conversation title, a timeline label, the `/goal` judge, a
 * workflow prompt node. Each of those is one model call with no conversation
 * around it, so each becomes its own session-less run: created, reserved,
 * dispatched, settled and sealed within the call. It takes no session lock, so
 * a title being written never makes the chat it belongs to look busy.
 *
 * The handle is imperative rather than a callback wrapper because the caller is
 * an `LlmClient`: it hands back text, and its token usage is only readable from
 * the client's own snapshot once the call (or the stream) has settled.
 */

import { type RawUsage, type RoleCallErrorClass, type UsageSemantics } from "@cognia/router-fusion"
import { sha256Hex } from "@cognia/router-fusion"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"

import type { FusionLedgerStore } from "../db/ledger-store"
import type { FusionRunOrigin } from "../db/types"
import { RouterFusionInfrastructureError } from "../gate/faults"
import type { PreparedUtilityCall } from "./utility-route"

/** A utility run is one call long; the lease only has to outlive that call. */
export const UTILITY_RUN_LEASE_MS = 300_000

/**
 * Usage semantics of the AI SDK's normalized `LanguageModelUsage` (v6/v7):
 * the totals are inclusive. The sidecar's AI SDK lane reads the same shape
 * through its own copy of this constant in `sidecar/dispatch/call-ledger-gate.mjs`
 * (the sidecar is a separate Node project and cannot import `@cognia/*`), so
 * the two lanes bill one provider bill the same way. If a live smoke shows a
 * provider reporting exclusive totals, both copies move together.
 */
export const AI_SDK_USAGE_SEMANTICS: UsageSemantics = Object.freeze({
  inputIncludesCacheRead: true,
  inputIncludesCacheWrite: true,
  outputIncludesReasoning: true,
})

export interface UtilityRunDeps {
  store: () => Promise<FusionLedgerStore>
  /** This window's lease owner id, shared with chat runs. */
  leaseOwner: string
  /** Remaining allowance of the tightest cost-budget scope; null = no tenant limit (D22). */
  tenantLimitRemainingMicrousd: number | null
  newId?: () => string
}

export interface UtilityCallBinding {
  surface: RouterFusionSurface
  origin: FusionRunOrigin
  /** Stable id of the feature making the call, e.g. `conversation-title`. */
  featureId: string
  /** Everything the request is made of, hashed for the attempt's request hash. */
  requestDigestInput: string
}

export interface UtilityCallHandle {
  readonly runId: string
  /** The output bound the reservation was priced for. */
  readonly maxOutputTokens: number
  /** The provider answered. `usage` is null when it reported none. */
  succeeded(usage: RawUsage | null): Promise<void>
  /** The provider refused or failed before producing anything billable. */
  failed(errorClass: RoleCallErrorClass, usage?: RawUsage | null): Promise<void>
  /** Sent, no answer (aborted mid-stream, timed out): the money stays held. */
  unknown(reason: string): Promise<void>
}

export type UtilityCallStart =
  { kind: "granted"; handle: UtilityCallHandle } | { kind: "refused"; code: string }

function uuid(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * Create the run and reserve the call. Returns a refusal — a real answer, never
 * bypassed (D38) — when the budget, the model-call limit or a policy change
 * says this call may not be made. Anything else that goes wrong is an
 * infrastructure fault and reaches the caller as one.
 */
export async function beginUtilityCall(
  deps: UtilityRunDeps,
  route: PreparedUtilityCall,
  binding: UtilityCallBinding
): Promise<UtilityCallStart> {
  const newId = deps.newId ?? uuid
  const store = await deps.store()
  const runId = newId()
  const created = await store.createRun({
    runId,
    // Session-less by construction: a utility call must never make the session
    // it belongs to look busy, and it has no transcript of its own.
    sessionId: null,
    surface: binding.surface,
    origin: binding.origin,
    decision: route.decision,
    actionId: route.actionId,
    ruleId: null,
    roleDeployments: route.roleDeployments,
    config: route.config,
    capMicrousd: route.capMicrousd,
    maxModelCalls: route.maxModelCalls,
    deadlineMs: route.deadlineMs,
    budgetMode: route.budgetMode,
    tenantLimitRemainingMicrousd: deps.tenantLimitRemainingMicrousd,
  })
  if (!created.ok) return { kind: "refused", code: created.code }

  const lease = await store.acquireLease(runId, deps.leaseOwner, UTILITY_RUN_LEASE_MS)
  if (!lease.ok) {
    // Nobody else can hold the lease of a run created moments ago in this window.
    throw new RouterFusionInfrastructureError(
      "internal",
      `Router + Fusion could not lease the utility run it just created (${lease.code}).`
    )
  }
  const { fencingToken } = lease
  const seal = async (status: "failed" | "cancelled", code: string) => {
    await store.finalizeRun(runId, fencingToken, {
      status,
      error: { code, message: binding.featureId },
    })
  }

  const started = await store.startRun(runId, fencingToken)
  if (!started.ok) {
    await seal("failed", started.code)
    return { kind: "refused", code: started.code }
  }

  const refusal = route.liveRefusal(route.deploymentId)
  if (refusal) {
    await seal("failed", refusal)
    return { kind: "refused", code: refusal }
  }

  const prepared = await store.prepareCall(runId, fencingToken, {
    logicalStepId: `utility:${binding.featureId}`,
    role: "solver",
    deploymentId: route.deploymentId,
    reserveMicrousd: route.reserveMicrousd,
    requestHash: sha256Hex(binding.requestDigestInput),
  })
  if (prepared.kind !== "granted") {
    // A fresh run has no committed step, so `replay` is unreachable here; if it
    // ever were, replaying a utility answer silently is not what the caller asked
    // for, and the code says which outcome it was.
    const code = prepared.kind === "refused" ? prepared.code : "UNEXPECTED_REPLAY"
    await seal("failed", code)
    return { kind: "refused", code }
  }
  const { attemptId } = prepared
  const dispatched = await store.markDispatched(attemptId, fencingToken)
  if (!dispatched.ok) {
    // Nothing was sent, so the reservation and the call slot both go back.
    await store.abandon(attemptId)
    await seal("failed", dispatched.code)
    return { kind: "refused", code: dispatched.code }
  }

  let settled = false
  const once = async (run: () => Promise<void>) => {
    if (settled) return
    settled = true
    await run()
  }
  return {
    kind: "granted",
    handle: {
      runId,
      maxOutputTokens: route.maxOutputTokens,
      succeeded: (usage) =>
        once(async () => {
          await store.settleCall(attemptId, {
            status: "succeeded",
            usage,
            semantics: usage ? AI_SDK_USAGE_SEMANTICS : null,
            providerRequestId: null,
          })
          await store.finalizeRun(runId, fencingToken, { status: "succeeded" })
        }),
      failed: (errorClass, usage = null) =>
        once(async () => {
          await store.settleCall(attemptId, {
            status: "failed",
            usage,
            semantics: usage ? AI_SDK_USAGE_SEMANTICS : null,
            providerRequestId: null,
            errorClass,
          })
          await store.finalizeRun(runId, fencingToken, {
            status: errorClass === "cancelled" ? "cancelled" : "failed",
            error: { code: errorClass, message: binding.featureId },
          })
        }),
      unknown: (reason) =>
        once(async () => {
          await store.markUnknown(attemptId, reason)
          await store.finalizeRun(runId, fencingToken, {
            status: "failed",
            error: { code: "CALL_OUTCOME_UNKNOWN", message: binding.featureId },
            unknownReason: reason,
          })
        }),
    },
  }
}
