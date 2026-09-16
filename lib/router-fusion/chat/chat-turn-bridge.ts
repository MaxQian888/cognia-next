/**
 * The chat controller's and event handler's side of a Router + Fusion turn
 * (ADR-0188 B1). Everything here runs only for a send that was stamped with a
 * ledger, and is reached only through the dynamically loaded host.
 *
 *   start   — right before dispatch: tenant hold (with the one-run grant of
 *             D35 when the cost budget is short), session lock, lease; the turn
 *             is registered so the event handler can see it synchronously.
 *   events  — answer the sidecar's reservation requests, book its call results,
 *             observe Agent SDK messages of an envelope run, and turn a ledger
 *             the sidecar gave up on into a visible notice.
 *   finish  — seal the run and hand back what the transcript and usage row need.
 *
 * Infrastructure faults while the turn runs never reach the chat: the sidecar
 * is told to bypass, the breaker counts the fault, and the turn's message says
 * it was not ledgered. Refusals are answers and are passed through.
 */

import type {
  AppSettings,
  CallAttemptResultEvent,
  CallReserveRequestEvent,
  LedgerBypassedEvent,
  RouterFusionTurnStamp,
  SendOptions,
} from "@cognia/agent-config-types"
import { ProviderRoutingEngine, createMappingRegistry } from "@cognia/provider-routing"
import { buildRoutingEngineDeps } from "@cognia/provider-routing/build-preview-engine"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"
import { callReserveDecision } from "@/lib/claude/ipc"
import { getRuntimeTranslator } from "@/lib/i18n/runtime-translator"
import { waitForDecision, type ApprovalKey } from "@/lib/runtime/approval-bus"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { recordFusionFault } from "../gate/breaker"
import { RouterFusionInfrastructureError, toInfrastructureFault } from "../gate/faults"
import { breakerThresholdOf, routerFusionGate } from "../gate/feature-gate"
import {
  clearFusionTurn,
  fusionTurnBypassOf,
  markFusionTurn,
  noteFusionTurnBypass,
  type FusionTurnBypass,
} from "../gate/turn-registry"
import { createChatRouteHost } from "./chat-route-host"
import { chatRunDeps } from "./chat-run-deps"
import {
  abortChatRunBeforeDispatch,
  answerCallReserve,
  beginChatRun,
  cancelChatRun,
  finalizeChatRun,
  observeEnvelopeMessage,
  preparedChatRoute,
  recordCallAttemptResult,
  rememberChatRoute,
  type ChatRunDeps,
} from "./chat-runs"
import { sealChatRoute, selectChatDeployment } from "./route-chat-turn"
import { tenantLimitFor, type TenantLimit } from "./tenant-budget"

export const ROUTER_FUSION_GRANT_SCOPE = "router-fusion-grant"

function currentSettings(): AppSettings | undefined {
  return useSettingsStore.getState().settings ?? undefined
}

/** Count a mid-turn fault against the chat breaker and remember it for the turn's message. */
function faultDuringTurn(
  sessionId: string,
  fault: RouterFusionInfrastructureError
): FusionTurnBypass {
  const record = recordFusionFault(
    "chat",
    fault.code,
    breakerThresholdOf(currentSettings()),
    Date.now()
  )
  const bypass = { code: fault.code, justTripped: record.justTripped }
  noteFusionTurnBypass(sessionId, bypass)
  console.warn("[router-fusion] chat turn continues unledgered", fault)
  return bypass
}

function depsFor(sessionId: string): ChatRunDeps {
  return chatRunDeps((fault) => {
    faultDuringTurn(sessionId, fault)
  })
}

// ── start ─────────────────────────────────────────────────────────────────────

export interface GrantRequest {
  runId: string
  capMicrousd: number
  availableMicrousd: number
  shortfallMicrousd: number
  binding: TenantLimit["binding"]
}

function usd(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(microusd < 10_000 ? 4 : 2)}`
}

/**
 * D35: the cost budget cannot cover this run's cap. Ask the user for a grant
 * that covers exactly the shortfall of this one run. Declining, or abandoning
 * the wait, is never a grant.
 */
export async function requestRouterFusionGrant(
  request: GrantRequest,
  signal?: AbortSignal
): Promise<boolean> {
  const t = await getRuntimeTranslator("routerFusion.grant")
  const key: ApprovalKey = { scope: ROUTER_FUSION_GRANT_SCOPE, id: request.runId }
  usePendingGatesStore.getState().open({
    key,
    gateType: "budget",
    title: t("title"),
    body: t("body", {
      cap: usd(request.capMicrousd),
      available: usd(request.availableMicrousd),
      shortfall: usd(request.shortfallMicrousd),
    }),
    runId: request.runId,
    teamId: "",
  })
  try {
    const decision = await waitForDecision(key, signal)
    return decision.outcome === "approve"
  } catch {
    return false
  } finally {
    usePendingGatesStore.getState().close(key)
  }
}

export type StartTurnOutcome =
  | { kind: "started"; runId: string }
  /** The user declined the one-run grant: nothing runs. */
  | { kind: "declined"; code: "TENANT_BUDGET_EXHAUSTED" }
  | { kind: "refused"; code: string }

/**
 * Create the run for a stamped send. Throws only infrastructure faults — the
 * controller then sends the turn unledgered with a notice.
 */
export async function startRouterFusionChatTurn(input: {
  sessionId: string
  options: SendOptions
  signal?: AbortSignal
  /** Test seam; defaults to the pending-gate dialog. */
  requestGrant?: (request: GrantRequest, signal?: AbortSignal) => Promise<boolean>
}): Promise<StartTurnOutcome> {
  const stamp = input.options.routerFusion as RouterFusionTurnStamp
  const deps = depsFor(input.sessionId)
  const tenant = await tenantLimitFor(currentSettings()?.costBudget, stamp.providerId)
  const prepared = preparedChatRoute(stamp.runId)
  let outcome = await beginChatRun(
    stamp.runId,
    { tenantLimitRemainingMicrousd: tenant.remainingMicrousd },
    deps
  )
  if (outcome.kind === "refused" && outcome.code === "TENANT_BUDGET_EXHAUSTED" && prepared) {
    const available = outcome.availableMicrousd ?? 0
    const shortfall = Math.max(1, outcome.capMicrousd - available)
    const approved = await (input.requestGrant ?? requestRouterFusionGrant)(
      {
        runId: stamp.runId,
        capMicrousd: outcome.capMicrousd,
        availableMicrousd: available,
        shortfallMicrousd: shortfall,
        binding: tenant.binding,
      },
      input.signal
    )
    if (!approved) return { kind: "declined", code: "TENANT_BUDGET_EXHAUSTED" }
    rememberChatRoute(prepared)
    outcome = await beginChatRun(
      stamp.runId,
      { tenantLimitRemainingMicrousd: tenant.remainingMicrousd, grantMicrousd: shortfall },
      deps
    )
  }
  if (outcome.kind === "refused") return { kind: "refused", code: outcome.code }
  markFusionTurn(input.sessionId, stamp.runId)
  return { kind: "started", runId: stamp.runId }
}

// ── resend: retries, loop continuations and reroutes ──────────────────────────

export type ResealOutcome =
  | { kind: "sealed"; options: SendOptions }
  | { kind: "refused"; code: string; reasons: string[] }
  /** Router + Fusion is off now, or faulted: the resend goes out unledgered. */
  | { kind: "bypassed"; options: SendOptions }

function withoutFusion(options: SendOptions, bypass: FusionTurnBypass | null): SendOptions {
  const { ledger: _ledger, routerFusion: _stamp, routerFusionBypass: _previous, ...rest } = options
  return bypass ? { ...rest, routerFusionBypass: bypass } : rest
}

/**
 * A send that reuses cached options (a retry, a loop continuation, a reroute
 * to another model) is a NEW run: its old stamp names a run that was already
 * sealed. Route it again for the provider and model it now carries.
 */
export async function resealRouterFusionOptions(input: {
  sessionId: string
  options: SendOptions
  workspaceId: string | null
}): Promise<ResealOutcome> {
  const settings = currentSettings()
  const { options } = input
  if (!settings || routerFusionGate(settings, "chat") !== "on") {
    return { kind: "bypassed", options: withoutFusion(options, null) }
  }
  const lane = (options.execution?.runtimeAdapter ??
    (options.provider === "anthropic" || !options.provider
      ? "claude-agent-sdk"
      : "ai-sdk")) as string
  if ((lane !== "ai-sdk" && lane !== "claude-agent-sdk") || !options.provider || !options.model) {
    return { kind: "bypassed", options: withoutFusion(options, null) }
  }
  try {
    const routingConfig = settings.routingConfig ?? DEFAULT_ROUTING_CONFIG
    const engineDeps = buildRoutingEngineDeps(settings)
    const host = createChatRouteHost({
      appSettings: settings,
      engine: new ProviderRoutingEngine(
        createMappingRegistry(settings.modelMappings ?? []),
        routingConfig,
        engineDeps
      ),
      engineDeps,
    })
    const pick = { kind: "manual" as const, providerId: options.provider, modelId: options.model }
    const selection = await selectChatDeployment(host, {
      selection: pick,
      routingRequest: { surface: "chat", selection: pick, sessionId: input.sessionId },
      promptText: "",
      estimatedInputTokens: 1,
      hints: { workspaceBound: Boolean(input.workspaceId) },
      workspaceId: input.workspaceId,
      hasImages: false,
      needsTools: false,
    })
    if (selection.kind === "refused") {
      return { kind: "refused", code: selection.code, reasons: selection.reasons }
    }
    const seal = sealChatRoute(host, {
      selection,
      providerId: options.provider,
      modelId: options.model,
      lane,
      env: options.env,
      sessionId: input.sessionId,
      maxOutputTokens: options.modelParams?.maxOutputTokens,
      existingMaxBudgetUsd: options.maxBudgetUsd,
    })
    if (seal.kind === "refused") return { kind: "refused", code: seal.code, reasons: seal.reasons }
    rememberChatRoute(seal.prepared)
    const next: SendOptions = {
      ...withoutFusion(options, null),
      ledger: seal.ledger,
      routerFusion: seal.stamp,
    }
    if (lane === "ai-sdk" && next.modelParams?.maxOutputTokens === undefined) {
      next.modelParams = { ...next.modelParams, maxOutputTokens: seal.maxOutputTokens }
    }
    delete next.fallbackModel
    return { kind: "sealed", options: next }
  } catch (error) {
    const fault = toInfrastructureFault(error)
    if (!fault) throw error
    const record = recordFusionFault("chat", fault.code, breakerThresholdOf(settings), Date.now())
    return {
      kind: "bypassed",
      options: withoutFusion(options, { code: fault.code, justTripped: record.justTripped }),
    }
  }
}

export { MAX_LEDGERED_REROUTES } from "../gate/chat-send"

export type RerouteOutcome =
  | { kind: "started"; options: SendOptions }
  | { kind: "refused"; code: string }
  | { kind: "bypassed"; options: SendOptions }

/**
 * A visible, ledgered reroute of a turn that failed before it committed
 * anything: route the new model, create its run, and hand back the options to
 * send. The failed attempt's run was sealed when its turn ended.
 */
export async function rerouteRouterFusionTurn(input: {
  sessionId: string
  options: SendOptions
  workspaceId: string | null
  signal?: AbortSignal
}): Promise<RerouteOutcome> {
  const resealed = await resealRouterFusionOptions(input)
  if (resealed.kind === "refused") return { kind: "refused", code: resealed.code }
  if (resealed.kind === "bypassed") return resealed
  try {
    const started = await startRouterFusionChatTurn({
      sessionId: input.sessionId,
      options: resealed.options,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (started.kind !== "started") return { kind: "refused", code: started.code }
    return { kind: "started", options: resealed.options }
  } catch (error) {
    const fault = toInfrastructureFault(error)
    if (!fault) throw error
    const bypass = faultDuringTurn(input.sessionId, fault)
    return { kind: "bypassed", options: withoutFusion(resealed.options, bypass) }
  }
}

/** The IPC send failed: nothing was dispatched, so release the run at once. */
export async function abortRouterFusionChatTurn(sessionId: string, reason: string): Promise<void> {
  try {
    await abortChatRunBeforeDispatch(sessionId, reason, depsFor(sessionId))
  } finally {
    clearFusionTurn(sessionId)
  }
}

export function cancelRouterFusionChatTurn(sessionId: string): Promise<void> {
  return cancelChatRun(sessionId, depsFor(sessionId))
}

// ── events ────────────────────────────────────────────────────────────────────

export type RouterFusionSidecarEvent =
  CallReserveRequestEvent | CallAttemptResultEvent | LedgerBypassedEvent

export async function handleRouterFusionSidecarEvent(
  event: RouterFusionSidecarEvent,
  io: { decide?: typeof callReserveDecision } = {}
): Promise<void> {
  const deps = depsFor(event.sessionId)
  switch (event.type) {
    case "call_reserve_request": {
      const { answer, fault } = await answerCallReserve(event, deps)
      if (fault) faultDuringTurn(event.sessionId, fault)
      await (io.decide ?? callReserveDecision)(event.sessionId, event.requestId, answer)
      return
    }
    case "call_attempt_result":
      await recordCallAttemptResult(event, deps)
      return
    case "ledger_bypassed":
      faultDuringTurn(
        event.sessionId,
        new RouterFusionInfrastructureError("sidecar_unanswered", event.reason)
      )
      return
  }
}

/** Observe an SDK message of the session's ledgered turn (a no-op for the AI SDK lane). */
export function observeRouterFusionSdkMessage(sessionId: string, message: unknown): Promise<void> {
  if (!message || typeof message !== "object") return Promise.resolve()
  return observeEnvelopeMessage(sessionId, message as Record<string, unknown>, depsFor(sessionId))
}

// ── finish ────────────────────────────────────────────────────────────────────

export interface RouterFusionTurnSummary {
  runId: string
  status: string
  spentMicrousd: number
  overspendMicrousd: number
  modelCalls: number
  costStatus: string
  frozen: boolean
  refusalCode: string | null
  bypass: FusionTurnBypass | null
}

/**
 * Seal the session's ledgered turn. Returns null when the turn had no run in
 * this window (already sealed, or never started).
 */
export async function finishRouterFusionChatTurn(
  sessionId: string,
  outcome: {
    status: "succeeded" | "failed" | "cancelled"
    error?: { code: string; message: string }
  }
): Promise<RouterFusionTurnSummary | null> {
  const bypass = fusionTurnBypassOf(sessionId)
  try {
    const seal = await finalizeChatRun(sessionId, outcome, depsFor(sessionId))
    if (!seal) return null
    return {
      runId: seal.run.runId,
      status: seal.run.status,
      spentMicrousd: seal.run.budget.spentMicrousd,
      overspendMicrousd: seal.run.budget.overspendMicrousd,
      modelCalls: seal.run.budget.modelCalls,
      costStatus: seal.run.costStatus,
      frozen: seal.run.budget.frozen,
      refusalCode: seal.refusal?.code ?? null,
      bypass: fusionTurnBypassOf(sessionId) ?? bypass,
    }
  } finally {
    clearFusionTurn(sessionId)
  }
}
