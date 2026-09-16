/**
 * A chat turn as a Router + Fusion direct run, on the renderer (ADR-0188 B1).
 *
 *   route (build options) → begin (before dispatch: tenant hold, session lock,
 *   lease, running; envelope stage) → per-call reserve / result (AI SDK lane)
 *   or observed messages (Agent SDK envelope) → finalize (turn end).
 *
 * The renderer is the ledger's only writer. The sidecar asks before each model
 * call and reports what happened; this module turns those frames into ledger
 * transactions and answers. Everything here runs only for a turn that was
 * routed through Router + Fusion, and it is loaded only behind the gate.
 *
 * Writes for one run go through a per-run queue in arrival order: the sidecar's
 * frames race each other on the IPC channel, and envelope reconciliation must
 * see every message booked before it compares against the SDK's totals.
 */

import {
  reserveForCall,
  sha256Hex,
  type CompiledFusionConfig,
  type DataClass,
  type RawUsage,
  type RoleCallErrorClass,
  type RouteDecision,
  type UsageSemantics,
} from "@cognia/router-fusion"
import { WIRED_ROUTER_FUSION_SURFACES } from "@cognia/router-fusion/settings/switches"
import type {
  CallAttemptResultEvent,
  CallReserveRequestEvent,
  RouterFusionLedgerStamp,
  RouterFusionTurnStamp,
} from "@cognia/agent-config-types"

import type { FusionLedgerStore } from "../db/ledger-store"
import { drainFusionOutbox, type OutboxAppliers } from "../db/outbox"
import type { FusionRunRow } from "../db/types"
import { RouterFusionInfrastructureError, toInfrastructureFault } from "../gate/faults"

export const ENVELOPE_STAGE_ID = "envelope"
export const CHAT_RUN_LEASE_MS = 60_000
export const ANTHROPIC_NATIVE_SEMANTICS: UsageSemantics = {
  inputIncludesCacheRead: false,
  inputIncludesCacheWrite: false,
  outputIncludesReasoning: true,
}

/** Everything routing decided for one turn, kept until the run is sealed. */
export interface PreparedChatRoute {
  stamp: RouterFusionTurnStamp
  ledger: RouterFusionLedgerStamp
  decision: RouteDecision
  config: CompiledFusionConfig
  sessionId: string
  dataClass: DataClass
  maxModelCalls: number
  deadlineMs: number
  unknownPriceCallReserveMicrousd: number
  /**
   * Live policy check at every reservation (AUTH-07): the provider was disabled,
   * its key removed or its data permission withdrawn since routing. A code
   * means "refuse now"; null means the deployment may still be called.
   */
  liveRefusal: (deploymentId: string) => string | null
}

interface EnvelopeState {
  openMessageId: string | null
  openModel: string | null
  openUsage: RawUsage | null
  sums: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  reconciled: number
  retries: number
}

interface ActiveChatRun {
  runId: string
  route: PreparedChatRoute
  fencingToken: number
  envelope: EnvelopeState | null
  /** The last refusal the ledger gave this run, for the run card. */
  refusal: { code: string; at: number } | null
  /**
   * The turn's most recent model call (`leg:*`) failed with no later success.
   * The AI SDK lane closes such a turn with a synthetic success result, so the
   * seal needs this to report it failed.
   */
  finalLegFailed: { errorClass: string | null } | null
  /** Serializes this run's ledger writes in arrival order. */
  queue: Promise<void>
  heartbeat: ReturnType<typeof setInterval> | null
}

export interface ChatRunDeps {
  store: () => Promise<FusionLedgerStore>
  appliers: OutboxAppliers
  /** This window's lease owner id (one per page load). */
  leaseOwner: string
  leaseMs?: number
  now?: () => number
  /** An infrastructure fault while booking an already-running turn (never thrown into the chat). */
  onFault?: (fault: RouterFusionInfrastructureError) => void
  /**
   * Recovery hands an orchestrated run (`driver: "orchestrator"`) whose lease
   * lapsed here instead of sealing it. True means a worker took it and will
   * carry on from the ledger; false (its surface is off, say) leaves the run to
   * be sealed like any other abandoned one.
   */
  resumeOrchestrated?: (run: FusionRunRow) => boolean
}

const prepared = new Map<string, PreparedChatRoute>()
const active = new Map<string, ActiveChatRun>()
const runBySession = new Map<string, string>()

/**
 * Sealed routes waiting for their send to start a run. A send that returns
 * before dispatch (a lost durable lease, a failed attachment step) never
 * consumes its route, so the map is bounded instead of relying on every early
 * return to clean up. Sends start their run within moments of sealing; a route
 * pushed out by this many newer ones belongs to a send that is not coming, and
 * if it did, it would find no route and go out unledgered with the notice.
 */
export const MAX_PREPARED_CHAT_ROUTES = 64

export function rememberChatRoute(route: PreparedChatRoute): void {
  prepared.delete(route.stamp.runId)
  prepared.set(route.stamp.runId, route)
  while (prepared.size > MAX_PREPARED_CHAT_ROUTES) {
    const oldest = prepared.keys().next().value
    if (oldest === undefined) break
    prepared.delete(oldest)
  }
}

export function preparedChatRoute(runId: string): PreparedChatRoute | undefined {
  return prepared.get(runId)
}

/** The session's run in this window, if one is active. */
export function activeChatRunId(sessionId: string): string | undefined {
  return runBySession.get(sessionId)
}

function faultOf(error: unknown): RouterFusionInfrastructureError {
  if (error instanceof RouterFusionInfrastructureError) return error
  return (
    toInfrastructureFault(error) ??
    new RouterFusionInfrastructureError("internal", String(error), error)
  )
}

/** Run `work` after everything already queued for the run; a failure is reported, never propagated. */
function enqueue(run: ActiveChatRun, deps: ChatRunDeps, work: () => Promise<void>): Promise<void> {
  const next = run.queue.then(work).catch((error) => {
    deps.onFault?.(faultOf(error))
  })
  run.queue = next
  return next
}

// ── begin ─────────────────────────────────────────────────────────────────────

export type BeginChatRunOutcome =
  | { kind: "started"; run: FusionRunRow }
  | { kind: "refused"; code: string; availableMicrousd?: number; capMicrousd: number }

/**
 * Create and start the run right before the turn is dispatched: the whole run
 * cap is held against the tenant, the session is locked, the lease is taken.
 * A refusal (tenant budget, busy session) comes back as a value; any other
 * failure is an infrastructure fault the caller turns into a bypass, and it
 * leaves nothing held behind.
 */
export async function beginChatRun(
  runId: string,
  input: { tenantLimitRemainingMicrousd: number | null; grantMicrousd?: number },
  deps: ChatRunDeps
): Promise<BeginChatRunOutcome> {
  const route = prepared.get(runId)
  if (!route) {
    throw new RouterFusionInfrastructureError(
      "internal",
      `Router + Fusion route for ${runId} was lost`
    )
  }
  const store = await deps.store()
  const createInput = {
    runId,
    sessionId: route.sessionId,
    surface: "chat" as const,
    origin: "chat" as const,
    decision: route.decision,
    actionId: route.stamp.actionId,
    ruleId: route.stamp.ruleId,
    roleDeployments: { solver: route.stamp.deploymentId },
    config: route.config,
    capMicrousd: route.stamp.capMicrousd,
    maxModelCalls: route.maxModelCalls,
    deadlineMs: route.deadlineMs,
    budgetMode: route.stamp.budgetMode,
    tenantLimitRemainingMicrousd: input.tenantLimitRemainingMicrousd,
    ...(input.grantMicrousd ? { grantMicrousd: input.grantMicrousd } : {}),
  }
  let created = await store.createRun(createInput)
  if (!created.ok && created.code === "SESSION_BUSY" && created.activeRunId) {
    // A window that closed mid-turn leaves its run holding the session until
    // its lease runs out; a stale holder is sealed and the turn goes ahead.
    if (await recoverStaleRun(store, created.activeRunId, deps)) {
      created = await store.createRun(createInput)
    }
  }
  if (!created.ok) {
    prepared.delete(runId)
    return {
      kind: "refused",
      code: created.code,
      capMicrousd: route.stamp.capMicrousd,
      ...(created.availableMicrousd !== undefined
        ? { availableMicrousd: created.availableMicrousd }
        : {}),
    }
  }

  const leaseMs = deps.leaseMs ?? CHAT_RUN_LEASE_MS
  let fencingToken = created.run.fencingToken
  try {
    const lease = await store.acquireLease(runId, deps.leaseOwner, leaseMs)
    if (!lease.ok) {
      throw new RouterFusionInfrastructureError(
        "internal",
        `Router + Fusion lease refused: ${lease.code}`
      )
    }
    fencingToken = lease.fencingToken
    const started = await store.startRun(runId, fencingToken)
    if (!started.ok) {
      throw new RouterFusionInfrastructureError(
        "internal",
        `Router + Fusion start refused: ${started.code}`
      )
    }
    let envelope: EnvelopeState | null = null
    if (route.ledger.mode === "envelope") {
      // The Agent SDK loops on its own: hold everything the run may still spend
      // as the envelope stage, so every observed call converts from it.
      const stage = await store.reserveStage(
        runId,
        fencingToken,
        ENVELOPE_STAGE_ID,
        store.runAvailable(started.run)
      )
      if (stage.kind === "refused") {
        await store.finalizeRun(runId, fencingToken, {
          status: "failed",
          error: { code: stage.code, message: "The envelope could not be reserved." },
        })
        prepared.delete(runId)
        return { kind: "refused", code: stage.code, capMicrousd: route.stamp.capMicrousd }
      }
      envelope = {
        openMessageId: null,
        openModel: null,
        openUsage: null,
        sums: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        reconciled: 0,
        retries: 0,
      }
    }
    const run: ActiveChatRun = {
      runId,
      route,
      fencingToken,
      envelope,
      refusal: null,
      finalLegFailed: null,
      queue: Promise.resolve(),
      heartbeat: null,
    }
    // Keep the lease while the turn runs, including long tool calls with no
    // ledger traffic; a lease that lapses means this window is gone.
    run.heartbeat = setInterval(
      () => {
        void enqueue(run, deps, async () => {
          const renewed = await store.acquireLease(runId, deps.leaseOwner, leaseMs)
          if (renewed.ok) run.fencingToken = renewed.fencingToken
        })
      },
      Math.max(1_000, Math.floor(leaseMs / 3))
    )
    active.set(runId, run)
    runBySession.set(route.sessionId, runId)
    return { kind: "started", run: started.run }
  } catch (error) {
    prepared.delete(runId)
    await store
      .finalizeRun(runId, fencingToken, {
        status: "failed",
        error: { code: "RUN_SETUP_FAILED", message: "The run could not be started." },
      })
      .catch(() => undefined)
    throw faultOf(error)
  }
}

/**
 * Seal a session holder whose lease has lapsed (its window closed or crashed).
 * A holder that is still leased — another window's live turn — is left alone.
 */
const RESUMABLE_STATUSES = new Set<string>(["queued", "running", "cancelling"])

async function recoverStaleRun(
  store: FusionLedgerStore,
  holderRunId: string,
  deps: ChatRunDeps
): Promise<boolean> {
  if (active.has(holderRunId)) return false
  const holder = await store.getRun(holderRunId)
  if (!holder) return false
  const now = deps.now?.() ?? Date.now()
  const leaseMs = deps.leaseMs ?? CHAT_RUN_LEASE_MS
  const lapsed = holder.leaseOwner
    ? holder.leaseExpiresAt <= now
    : holder.createdAt + leaseMs <= now
  if (!lapsed) return false
  // A graph the orchestrator executes is resumable from its stored input and
  // the ledger: completed steps replay, in-flight ones are settled by the
  // worker that takes the lease. Only a run nobody here may resume is lost.
  if (
    holder.driver === "orchestrator" &&
    RESUMABLE_STATUSES.has(holder.status) &&
    deps.resumeOrchestrated?.(holder)
  ) {
    return true
  }
  const lease = await store.acquireLease(holderRunId, deps.leaseOwner, leaseMs)
  if (!lease.ok) return lease.code === "RUN_TERMINAL"
  const sealed = await store.finalizeRun(holderRunId, lease.fencingToken, {
    status: "failed",
    error: { code: "RUN_LOST", message: "The window running this turn went away." },
    unknownReason: "window_lost",
  })
  return sealed.ok
}

/**
 * Boot-time sweep for this account: every run whose lease has lapsed is sealed,
 * so no hold or session lock outlives a crashed window.
 *
 * Every WIRED surface, not just chat. A window that closed mid-turn can leave a
 * utility call, a Run API run or a passthrough reservation holding money just
 * as easily, and a hold nothing will ever release is the one failure that gets
 * worse the longer it is ignored. A run another window is still driving keeps a
 * live lease and is left alone.
 */
export async function recoverStaleFusionRuns(deps: ChatRunDeps): Promise<number> {
  const wired = new Set<string>(WIRED_ROUTER_FUSION_SURFACES)
  const store = await deps.store()
  const open = await store.db.fusionRuns
    .where("status")
    .anyOf("queued", "running", "cancelling", "reconciling")
    .filter((run) => wired.has(run.surface))
    .toArray()
  let recovered = 0
  for (const run of open) {
    if (await recoverStaleRun(store, run.runId, deps)) recovered += 1
  }
  if (recovered > 0) {
    await drainFusionOutbox(store.db, deps.appliers, store.outboxContext()).catch(() => undefined)
  }
  return recovered
}

// ── per-call reservations (AI SDK lane) and envelope checks ─────────────────────

export type ReserveAnswer =
  // An envelope check grants continuation, not a call: no attempt.
  | { decision: "granted"; attemptId?: string; attemptNo?: number }
  | { decision: "refused"; code: string; message?: string }
  | { decision: "bypass"; code: string }

/**
 * Answer one `call_reserve_request`. Never throws: an infrastructure fault is a
 * `bypass` answer (the turn continues unledgered, the caller shows the notice
 * and counts the fault); a refusal is a `refused` answer.
 */
export async function answerCallReserve(
  event: CallReserveRequestEvent,
  deps: ChatRunDeps
): Promise<{ answer: ReserveAnswer; fault: RouterFusionInfrastructureError | null }> {
  const run = active.get(event.runId)
  if (!run) {
    const fault = new RouterFusionInfrastructureError(
      "internal",
      `No active Router + Fusion run ${event.runId} in this window`
    )
    return { answer: { decision: "bypass", code: "run_state_lost" }, fault }
  }
  let result: { answer: ReserveAnswer; fault: RouterFusionInfrastructureError | null } = {
    answer: { decision: "bypass", code: "internal" },
    fault: null,
  }
  const next = run.queue.then(async () => {
    try {
      result = await reserve(run, event, deps)
    } catch (error) {
      const fault = faultOf(error)
      result = { answer: { decision: "bypass", code: fault.code }, fault }
    }
  })
  run.queue = next
  await next
  return result
}

async function reserve(
  run: ActiveChatRun,
  event: CallReserveRequestEvent,
  deps: ChatRunDeps
): Promise<{ answer: ReserveAnswer; fault: RouterFusionInfrastructureError | null }> {
  const now = deps.now?.() ?? Date.now()
  // Refusals that need only the sealed route are decided before the store is
  // touched: a store fault turns the answer into a bypass, and a bypass must
  // never be how restricted data reaches a provider it was refused for.
  const liveRefusal = run.route.liveRefusal(event.deploymentId)
  if (liveRefusal) return refuse(run, liveRefusal, now)
  const amount = event.kind === "envelope_check" ? null : callReserveFor(run.route, event)
  if (amount?.kind === "refused") return refuse(run, amount.code, now)

  const store = await deps.store()
  if (event.kind === "envelope_check" || !amount) {
    const row = await store.getRun(run.runId)
    if (!row) {
      const fault = new RouterFusionInfrastructureError("internal", `Run ${run.runId} vanished`)
      return { answer: { decision: "bypass", code: "run_state_lost" }, fault }
    }
    // Envelope mode is an estimated cap (D34): the SDK's next call cannot be
    // sized in advance, so the run continues while money is left and stops the
    // moment it is spent, frozen, out of calls or out of time.
    const code =
      row.status !== "running"
        ? "RUN_NOT_RUNNING"
        : row.budget.frozen
          ? "BUDGET_FROZEN"
          : now >= row.deadlineAt
            ? "DEADLINE_EXCEEDED"
            : row.budget.modelCalls >= row.budget.maxModelCalls
              ? "MAX_MODEL_CALLS"
              : row.budget.capMicrousd - row.budget.spentMicrousd <= 0
                ? "RUN_BUDGET_EXHAUSTED"
                : null
    if (code) return refuse(run, code, now)
    return { answer: { decision: "granted" }, fault: null }
  }

  const outcome = await store.prepareCall(run.runId, run.fencingToken, {
    logicalStepId: event.logicalStepId,
    // Compaction and transcription side calls are not the answer's solver.
    role: event.logicalStepId.startsWith("leg:") ? "solver" : "compaction",
    deploymentId: event.deploymentId,
    reserveMicrousd: amount.microusd,
    requestHash: sha256Hex(`${run.runId}\n${event.logicalStepId}\n${event.deploymentId}`),
  })
  if (outcome.kind === "refused") return refuse(run, outcome.code, now)
  // A chat turn keeps no committed call output to replay: the sidecar holds
  // the conversation. A committed step asked again is a protocol error.
  if (outcome.kind === "replay") return refuse(run, "STEP_ALREADY_COMMITTED", now)
  const dispatched = await store.markDispatched(outcome.attemptId, run.fencingToken)
  if (!dispatched.ok) return refuse(run, dispatched.code, now)
  return {
    answer: { decision: "granted", attemptId: outcome.attemptId, attemptNo: outcome.attemptNo },
    fault: null,
  }
}

/**
 * What one call must hold before it is sent: the worst case — cold cache, the
 * highest cache-write tier on every input token, the full output bound. The
 * output bound is the call's own `maxOutputTokens` (routing pins it for a
 * ledgered turn), else the action's per-role bound.
 *
 * A call to a deployment outside the run's snapshot (a compaction summary on
 * its own model) is held at the conservative unknown-price amount in tracked
 * budgets. Strict budgets refuse it, and so does restricted data — a deployment
 * nobody vetted cannot prove where the data ends up.
 */
export function callReserveFor(
  route: PreparedChatRoute,
  event: Pick<CallReserveRequestEvent, "deploymentId" | "estimatedInputTokens" | "maxOutputTokens">
): { kind: "granted"; microusd: number; priceKnown: boolean } | { kind: "refused"; code: string } {
  const deployment = route.config.deploymentsById[event.deploymentId]
  const strict = route.stamp.budgetMode === "strict"
  if (!deployment) {
    if (strict) return { kind: "refused", code: "DEPLOYMENT_NOT_IN_SNAPSHOT" }
    if (route.dataClass === "restricted") return { kind: "refused", code: "DATA_CLASS_NOT_ALLOWED" }
    return { kind: "granted", microusd: route.unknownPriceCallReserveMicrousd, priceKnown: false }
  }
  if (!deployment.dataClasses.includes(route.dataClass)) {
    return { kind: "refused", code: "DATA_CLASS_NOT_ALLOWED" }
  }
  const action = route.config.actions[route.stamp.actionId]
  const outputBound =
    event.maxOutputTokens ?? action?.extension.role_output_tokens ?? deployment.maxOutputTokens
  const reserved = reserveForCall(
    {
      deployment,
      inputTokens: Math.max(event.estimatedInputTokens ?? 0, 1),
      outputTokens: outputBound,
    },
    {
      rateCardsById: route.config.rateCardsById,
      unknownPriceCallReserveMicrousd: route.unknownPriceCallReserveMicrousd,
      expectedOutputTokens: outputBound,
    }
  )
  if (!reserved.priceKnown && strict) return { kind: "refused", code: "PRICE_UNKNOWN" }
  return { kind: "granted", microusd: reserved.microusd, priceKnown: reserved.priceKnown }
}

function refuse(run: ActiveChatRun, code: string, at: number) {
  run.refusal = { code, at }
  return { answer: { decision: "refused" as const, code }, fault: null }
}

/** Book what the sidecar reported for a reserved call. Faults go to `deps.onFault`. */
export function recordCallAttemptResult(
  event: CallAttemptResultEvent,
  deps: ChatRunDeps
): Promise<void> {
  const run = active.get(event.runId)
  const book = async () => {
    if (run && event.logicalStepId.startsWith("leg:")) {
      run.finalLegFailed =
        event.status === "failed" ? { errorClass: event.errorClass ?? null } : null
    }
    const store = await deps.store()
    if (event.status === "unknown") {
      // The class before the reason: a reason is often a raw error message,
      // which the store withholds, while a class says what happened.
      await store.markUnknown(event.attemptId, event.errorClass ?? event.reason ?? "no_answer")
      return
    }
    const errorClass = roleCallErrorClassOf(event.errorClass)
    await store.settleCall(event.attemptId, {
      status: event.status,
      usage: event.usage ?? null,
      semantics: event.usage ? (event.semantics ?? null) : null,
      providerRequestId: event.providerRequestId,
      ...(errorClass ? { errorClass } : {}),
    })
  }
  // A result for a run this window already sealed is still booked: the bill
  // exists (late usage, BUD-07).
  if (!run) return book().catch((error) => deps.onFault?.(faultOf(error)))
  return enqueue(run, deps, book)
}

const ROLE_CALL_ERROR_CLASSES: ReadonlySet<string> = new Set<RoleCallErrorClass>([
  "rate_limited",
  "server_error",
  "not_sent",
  "timeout_after_send",
  "refusal",
  "invalid_request",
  "auth",
  "cancelled",
])

/** The sidecar's error class as the ledger's, or nothing for a class the ledger does not know. */
export function roleCallErrorClassOf(value: string | undefined): RoleCallErrorClass | undefined {
  return value && ROLE_CALL_ERROR_CLASSES.has(value) ? (value as RoleCallErrorClass) : undefined
}

// ── envelope observation (Claude Agent SDK lane) ────────────────────────────────

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

function n(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** Anthropic's native usage block as the ledger's raw usage (input excludes both cache tiers). */
export function rawUsageFromAnthropic(usage: AnthropicUsage | undefined | null): RawUsage | null {
  if (!usage || typeof usage !== "object") return null
  const split5m = n(usage.cache_creation?.ephemeral_5m_input_tokens)
  const split1h = n(usage.cache_creation?.ephemeral_1h_input_tokens)
  const flatWrite = n(usage.cache_creation_input_tokens)
  return {
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cacheReadTokens: n(usage.cache_read_input_tokens),
    ...(split5m > 0 || split1h > 0
      ? { cacheWrite5mTokens: split5m, cacheWrite1hTokens: split1h }
      : { cacheWriteTokens: flatWrite }),
  }
}

function cacheWriteOf(usage: RawUsage): number {
  return n(usage.cacheWriteTokens) + n(usage.cacheWrite5mTokens) + n(usage.cacheWrite1hTokens)
}

/** The class of the request an `api_retry` frame says failed. */
export function apiRetryErrorClass(status: number | null): RoleCallErrorClass {
  if (status === 429 || status === 529) return "rate_limited"
  if (status === 401 || status === 403) return "auth"
  if (status !== null && status >= 500) return "server_error"
  if (status !== null && status >= 400) return "invalid_request"
  // No HTTP response: the request may have been processed before the transport broke.
  return "timeout_after_send"
}

function deploymentOfModel(route: PreparedChatRoute, model: string | null): string {
  if (!model || model === route.stamp.modelId) return route.stamp.deploymentId
  return `${route.stamp.providerId}::${model}`
}

async function bookEnvelopeMessage(
  run: ActiveChatRun,
  messageId: string,
  model: string | null,
  usage: RawUsage | null,
  deps: ChatRunDeps
): Promise<void> {
  const store = await deps.store()
  const booked = await store.recordObservedCall(run.runId, {
    logicalStepId: `msg:${messageId}`,
    role: "solver",
    deploymentId: deploymentOfModel(run.route, model),
    stageId: ENVELOPE_STAGE_ID,
    status: "succeeded",
    usage,
    semantics: usage ? ANTHROPIC_NATIVE_SEMANTICS : null,
    providerRequestId: messageId.startsWith("reconcile-") ? null : messageId,
    conservativeMicrousd: run.route.stamp.reserveEstimateMicrousd,
  })
  if (!booked.duplicate && usage && run.envelope) {
    run.envelope.sums.inputTokens += n(usage.inputTokens)
    run.envelope.sums.outputTokens += n(usage.outputTokens)
    run.envelope.sums.cacheReadTokens += n(usage.cacheReadTokens)
    run.envelope.sums.cacheWriteTokens += cacheWriteOf(usage)
  }
}

async function bookOpenEnvelopeMessage(run: ActiveChatRun, deps: ChatRunDeps): Promise<void> {
  const envelope = run.envelope
  if (!envelope?.openMessageId) return
  const { openMessageId, openModel, openUsage } = envelope
  envelope.openMessageId = null
  envelope.openModel = null
  envelope.openUsage = null
  await bookEnvelopeMessage(run, openMessageId, openModel, openUsage, deps)
}

/**
 * Observe one SDK message of an envelope run (the inner `SDKMessage` of an
 * `event` frame). An assistant message is booked once, with the last usage
 * snapshot seen for its id, when the next message starts or the turn ends. An
 * `api_retry` frame is a failed request the SDK made: booked as a failed attempt
 * so the retry is visible — and, when the transport broke without an HTTP
 * answer, billed at the conservative estimate. The `result` message closes the
 * envelope against the SDK's own turn totals.
 */
export function observeEnvelopeMessage(
  sessionId: string,
  message: Record<string, unknown>,
  deps: ChatRunDeps
): Promise<void> {
  const runId = runBySession.get(sessionId)
  const run = runId ? active.get(runId) : undefined
  if (!run?.envelope) return Promise.resolve()
  const envelope = run.envelope

  if (message.type === "assistant") {
    const inner = message.message as
      { id?: unknown; model?: unknown; usage?: AnthropicUsage } | undefined
    const id = typeof inner?.id === "string" ? inner.id : null
    if (!id) return Promise.resolve()
    const model = typeof inner?.model === "string" ? inner.model : null
    const usage = rawUsageFromAnthropic(inner?.usage)
    return enqueue(run, deps, async () => {
      if (envelope.openMessageId && envelope.openMessageId !== id) {
        await bookOpenEnvelopeMessage(run, deps)
      }
      envelope.openMessageId = id
      envelope.openModel = model ?? envelope.openModel
      envelope.openUsage = usage ?? envelope.openUsage
    })
  }

  if (message.type === "system" && message.subtype === "api_retry") {
    const status = typeof message.error_status === "number" ? message.error_status : null
    const errorClass = apiRetryErrorClass(status)
    return enqueue(run, deps, async () => {
      envelope.retries += 1
      const store = await deps.store()
      await store.recordObservedCall(run.runId, {
        logicalStepId: `retry:${typeof message.uuid === "string" ? message.uuid : envelope.retries}`,
        role: "solver",
        deploymentId: run.route.stamp.deploymentId,
        stageId: ENVELOPE_STAGE_ID,
        status: "failed",
        usage: null,
        semantics: null,
        providerRequestId: null,
        errorClass,
        outcomeUnknown: errorClass === "timeout_after_send",
        conservativeMicrousd: run.route.stamp.reserveEstimateMicrousd,
      })
    })
  }

  if (message.type === "result") {
    const totals = rawUsageFromAnthropic(message.usage as AnthropicUsage | undefined)
    return enqueue(run, deps, () => closeEnvelope(run, totals, deps))
  }
  return Promise.resolve()
}

async function closeEnvelope(
  run: ActiveChatRun,
  turnTotals: RawUsage | null,
  deps: ChatRunDeps
): Promise<void> {
  const envelope = run.envelope
  if (!envelope) return
  await bookOpenEnvelopeMessage(run, deps)
  if (!turnTotals) return
  // The SDK's turn totals include calls this stream never showed (e.g. a
  // subagent's), so whatever the totals exceed the booked messages by is booked
  // too. Money is never dropped to make the envelope look tidy.
  const diff: RawUsage = {
    inputTokens: Math.max(0, n(turnTotals.inputTokens) - envelope.sums.inputTokens),
    outputTokens: Math.max(0, n(turnTotals.outputTokens) - envelope.sums.outputTokens),
    cacheReadTokens: Math.max(0, n(turnTotals.cacheReadTokens) - envelope.sums.cacheReadTokens),
    cacheWriteTokens: Math.max(0, cacheWriteOf(turnTotals) - envelope.sums.cacheWriteTokens),
  }
  if (
    diff.inputTokens + diff.outputTokens + n(diff.cacheReadTokens) + n(diff.cacheWriteTokens) ===
    0
  ) {
    return
  }
  envelope.reconciled += 1
  await bookEnvelopeMessage(run, `reconcile-${run.runId}-${envelope.reconciled}`, null, diff, deps)
}

// ── end of turn ─────────────────────────────────────────────────────────────────

export interface ChatRunSeal {
  run: FusionRunRow
  refusal: { code: string; at: number } | null
}

/**
 * Seal the session's active run at the end of its turn, after every frame
 * already received has been booked. Whatever is still in flight is resolved by
 * the store (UNKNOWN for sent calls without a bill), the cross-database effects
 * are applied, and the session is released.
 */
export async function finalizeChatRun(
  sessionId: string,
  outcome: {
    status: "succeeded" | "failed" | "cancelled"
    error?: { code: string; message: string }
  },
  deps: ChatRunDeps
): Promise<ChatRunSeal | null> {
  const runId = runBySession.get(sessionId)
  const run = runId ? active.get(runId) : undefined
  if (!runId || !run) return null
  runBySession.delete(sessionId)
  active.delete(runId)
  prepared.delete(runId)
  if (run.heartbeat) clearInterval(run.heartbeat)
  run.heartbeat = null
  let seal: ChatRunSeal | null = null
  await enqueue(run, deps, async () => {
    const store = await deps.store()
    if (run.envelope) await closeEnvelope(run, null, deps)
    // A turn that ended because a call was refused, or whose last model call
    // failed, did not succeed — even when the host closed it with a clean
    // result around what it had produced so far.
    const status =
      outcome.status === "succeeded" && (run.refusal || run.finalLegFailed)
        ? "failed"
        : outcome.status
    const error =
      outcome.error ??
      (status === "failed" && run.refusal
        ? { code: run.refusal.code, message: "Router + Fusion refused a call." }
        : status === "failed" && run.finalLegFailed
          ? {
              code: "CALL_FAILED",
              message: `The turn's last model call failed (${run.finalLegFailed.errorClass ?? "unclassified"}).`,
            }
          : undefined)
    const sealed = await store.finalizeRun(runId, run.fencingToken, {
      status,
      ...(error ? { error } : {}),
      unknownReason: "turn_ended_without_usage",
    })
    await drainFusionOutbox(store.db, deps.appliers, store.outboxContext()).catch((drainError) => {
      deps.onFault?.(faultOf(drainError))
    })
    if (sealed.ok) seal = { run: sealed.run, refusal: run.refusal }
  })
  return seal
}

/** User interrupt: the run moves to `cancelling`; the turn end seals it `cancelled`. */
export function cancelChatRun(sessionId: string, deps: ChatRunDeps): Promise<void> {
  const runId = runBySession.get(sessionId)
  const run = runId ? active.get(runId) : undefined
  if (!run) return Promise.resolve()
  return enqueue(run, deps, async () => {
    const store = await deps.store()
    await store.cancelRun(run.runId)
  })
}

/**
 * A turn whose dispatch never happened (the IPC send threw): the run is sealed
 * failed at once so the session lock and the tenant hold are released.
 */
export async function abortChatRunBeforeDispatch(
  sessionId: string,
  reason: string,
  deps: ChatRunDeps
): Promise<void> {
  await finalizeChatRun(
    sessionId,
    { status: "failed", error: { code: "DISPATCH_FAILED", message: reason } },
    deps
  )
}

export function __resetChatRunsForTesting(): void {
  for (const run of active.values()) {
    if (run.heartbeat) clearInterval(run.heartbeat)
  }
  prepared.clear()
  active.clear()
  runBySession.clear()
}
