/**
 * The ledger behind the gateway's passthrough lane (ADR-0188 D13/D27, B2).
 *
 * A passthrough request is a plain chat-completions proxy call: the caller
 * named a concrete model or one of the user's aliases, the gateway picked a
 * deployment, and the bytes travel unchanged in both directions. D13 keeps that
 * behaviour exactly — tools included — and adds one thing: the call is
 * reserved before it is sent and settled when it answers, so proxied traffic
 * draws on the same budget as everything else instead of being the one lane
 * that spends invisibly.
 *
 * Three things make this different from a utility call:
 *
 *  - **The run spans attempts.** A gateway request may walk several candidates
 *    on failover, and all of them are one bill for one request, so the run id is
 *    derived from the gateway's request id and each attempt is its own logical
 *    step.
 *  - **Reserve and settle are separate round trips.** The gateway holds the
 *    HTTP connection; the brain cannot keep a closure alive across it. Both
 *    halves therefore rebuild what they need from the store.
 *  - **It never becomes a run in the cockpit** (`origin: "gatewayPassthrough"`).
 *    Nobody is waiting to read about a proxy hop; it is one upstream call with
 *    a price, and a row per proxied request would bury every real run.
 *
 * Passthrough is ORDINARY traffic (D38): a fault here must never stop the
 * request. This module therefore throws on infrastructure faults and lets the
 * gate's ordinary guard turn that into `x-cognia-ledger: bypassed`, and it
 * returns refusals — budget, limits, a hard filter — as values, because those
 * are real answers the caller is entitled to.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { sha256Hex, type RawUsage, type RoleCallErrorClass } from "@cognia/router-fusion"

import { windowLeaseOwner } from "../chat/chat-run-deps"
import { currentFusionStore, drainAccountOutbox } from "../chat/store-provider"
import { tenantLimitFor } from "../chat/tenant-budget"
import { currentRouterFusionGateSettings } from "../gate/current-settings"
import { RouterFusionInfrastructureError } from "../gate/faults"
import { utilityRouteHost } from "./ledgered-llm-client"
import { routeUtilityCall } from "./utility-route"
import { AI_SDK_USAGE_SEMANTICS } from "./utility-run"

/** Separates the parts of a request digest so no two attempts can spell the same string. */
const DIGEST_SEPARATOR = "\u0000"

/** The surface whose switch turns this lane on. */
export const PASSTHROUGH_SURFACE = "gatewayPassthroughLedger" as const

/**
 * A passthrough run outlives one attempt but never a whole conversation: the
 * lease only has to cover the gateway's own request timeout plus its failover
 * walk. A request that outlives it was abandoned, and the boot sweep seals it.
 */
export const PASSTHROUGH_RUN_LEASE_MS = 600_000

/** Deterministic, so the second attempt of one request finds the first one's run. */
export function passthroughRunId(requestId: string): string {
  return `gwpt:${requestId}`
}

export interface PassthroughReserveInput {
  /** The gateway's own request id: one request, one run, however many attempts. */
  requestId: string
  /** 0-based candidate index. Each attempt is its own logical step and its own bill. */
  attempt: number
  providerId: string
  modelId: string
  /** What the caller asked for — an alias or a concrete name. Recorded, never routed on. */
  requestedModel: string
  keyId: string | null
  keyName: string
  estimatedInputTokens: number
  maxOutputTokens?: number | undefined
}

export type PassthroughReservation =
  | { kind: "reserved"; runId: string; attemptId: string }
  /** A real answer: the budget, a limit or a hard filter says no. Never bypassed. */
  | { kind: "refused"; code: string; reasons?: string[] }

export interface PassthroughSettleInput {
  runId: string
  attemptId: string
  outcome: "succeeded" | "failed" | "unknown"
  /** Why a `failed` attempt failed, as the gateway classified it. */
  errorClass?: RoleCallErrorClass
  usage?: RawUsage | null
  /** Why it failed, or what was sent with no answer. Stored redacted. */
  reason?: string
  /** True when the gateway will make no further attempt for this request. */
  final: boolean
}

async function appSettingsOrThrow(given?: AppSettings | null): Promise<AppSettings> {
  const settings = given ?? (await currentRouterFusionGateSettings())
  if (!settings) {
    throw new RouterFusionInfrastructureError(
      "internal",
      "Router + Fusion has no settings to ledger a gateway passthrough call against."
    )
  }
  return settings
}

/**
 * Reserve one upstream attempt. The gateway calls this before it sends, and
 * never sends when the answer is a refusal.
 *
 * The route is compiled once per attempt rather than once per run: a failover
 * attempt can land on a different deployment at a different price, and the hard
 * filters have to run against the one actually about to be called.
 */
export async function reservePassthroughCall(
  input: PassthroughReserveInput,
  given?: AppSettings | null
): Promise<PassthroughReservation> {
  const appSettings = await appSettingsOrThrow(given)
  const route = routeUtilityCall(utilityRouteHost(appSettings), {
    surface: PASSTHROUGH_SURFACE,
    providerId: input.providerId,
    modelId: input.modelId,
    // A gateway caller is not inside a workspace, so the account's own default
    // data class applies — the same one an unscoped chat gets.
    workspaceId: null,
    estimatedInputTokens: input.estimatedInputTokens,
    maxOutputTokens: input.maxOutputTokens,
  })
  if (route.kind === "refused") {
    return {
      kind: "refused",
      code: route.code,
      ...(route.reasons ? { reasons: route.reasons } : {}),
    }
  }
  const prepared = route.prepared
  const refusal = prepared.liveRefusal(prepared.deploymentId)
  if (refusal) return { kind: "refused", code: refusal }

  const store = await currentFusionStore()
  const runId = passthroughRunId(input.requestId)
  if (!(await store.getRun(runId))) {
    const tenant = await tenantLimitFor(appSettings.costBudget, input.providerId)
    const created = await store.createRun({
      runId,
      // Session-less: a proxied request is not a conversation this app owns,
      // and taking a session lock would make an unrelated chat look busy.
      sessionId: null,
      surface: PASSTHROUGH_SURFACE,
      origin: "gatewayPassthrough",
      decision: prepared.decision,
      actionId: prepared.actionId,
      ruleId: null,
      roleDeployments: prepared.roleDeployments,
      config: prepared.config,
      capMicrousd: prepared.capMicrousd,
      maxModelCalls: prepared.maxModelCalls,
      deadlineMs: prepared.deadlineMs,
      budgetMode: prepared.budgetMode,
      tenantLimitRemainingMicrousd: tenant.remainingMicrousd,
      actorKeyId: input.keyId,
      actorKeyName: input.keyName,
      title: input.requestedModel,
    })
    // `RUN_EXISTS` means two attempts of one request raced; the loser uses the
    // run the winner created rather than refusing a call that may proceed.
    if (!created.ok && created.code !== "RUN_EXISTS") {
      return { kind: "refused", code: created.code }
    }
  }

  const lease = await store.acquireLease(runId, windowLeaseOwner(), PASSTHROUGH_RUN_LEASE_MS)
  if (!lease.ok) return { kind: "refused", code: lease.code }
  const { fencingToken } = lease
  if ((await store.getRun(runId))?.status === "queued") {
    const started = await store.startRun(runId, fencingToken)
    if (!started.ok) return { kind: "refused", code: started.code }
  }

  const reserved = await store.prepareCall(runId, fencingToken, {
    logicalStepId: `passthrough:${input.attempt}`,
    role: "solver",
    deploymentId: prepared.deploymentId,
    reserveMicrousd: prepared.reserveMicrousd,
    requestHash: sha256Hex(
      [input.requestId, String(input.attempt), prepared.deploymentId].join(DIGEST_SEPARATOR)
    ),
  })
  if (reserved.kind !== "granted") {
    const code = reserved.kind === "refused" ? reserved.code : "UNEXPECTED_REPLAY"
    return { kind: "refused", code }
  }
  const dispatched = await store.markDispatched(reserved.attemptId, fencingToken)
  if (!dispatched.ok) {
    // Nothing left this machine, so the reservation and the call slot go back.
    await store.abandon(reserved.attemptId)
    return { kind: "refused", code: dispatched.code }
  }
  return { kind: "reserved", runId, attemptId: reserved.attemptId }
}

/**
 * Settle one attempt, and seal the run when the gateway says it is done with
 * this request. `unknown` keeps the money held on purpose: bytes left the
 * machine and their bill is not knowable yet.
 */
export async function settlePassthroughCall(
  input: PassthroughSettleInput
): Promise<{ sealed: boolean }> {
  const store = await currentFusionStore()
  const usage = input.usage ?? null
  const semantics = usage ? AI_SDK_USAGE_SEMANTICS : null
  if (input.outcome === "unknown") {
    await store.markUnknown(input.attemptId, input.reason ?? "stream ended without usage")
  } else if (input.outcome === "failed") {
    await store.settleCall(input.attemptId, {
      status: "failed",
      usage,
      semantics,
      providerRequestId: null,
      // A gateway that could not classify the failure still saw an answer from
      // the provider, which is what a server error means to the ledger.
      errorClass: input.errorClass ?? "server_error",
    })
  } else {
    await store.settleCall(input.attemptId, {
      status: "succeeded",
      usage,
      semantics,
      providerRequestId: null,
    })
  }
  // The settled call's usage row reaches the account database now, not
  // whenever some other lane next drains: nothing else drains for a proxy hop.
  if (!input.final) {
    await drainAccountOutbox(store).catch(() => undefined)
    return { sealed: false }
  }

  const lease = await store.acquireLease(input.runId, windowLeaseOwner(), PASSTHROUGH_RUN_LEASE_MS)
  if (!lease.ok) return { sealed: false }
  const sealed = await store.finalizeRun(input.runId, lease.fencingToken, {
    status: input.outcome === "succeeded" ? "succeeded" : "failed",
    ...(input.outcome === "succeeded"
      ? {}
      : {
          error: {
            code: input.outcome === "unknown" ? "CALL_OUTCOME_UNKNOWN" : "UPSTREAM_FAILED",
            message: input.reason ?? "the gateway's upstream did not answer",
          },
        }),
    ...(input.outcome === "unknown" ? { unknownReason: input.reason ?? "no usage reported" } : {}),
  })
  await drainAccountOutbox(store).catch(() => undefined)
  return { sealed: sealed.ok }
}
