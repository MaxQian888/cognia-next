/**
 * The one interceptor dispatcher (ADR-0189 §6.3).
 *
 * Every rule below exists because the code it replaces got it wrong somewhere:
 *
 *  1. `next` enters at most once. The chat-middleware runner called `next(req)`
 *     again after a middleware timed out or threw — including when that
 *     middleware had ALREADY delegated — so a slow middleware wrapped around a
 *     completed model call produced a second model call. A second `next` now
 *     rejects and the downstream operation is never re-run.
 *  2. Synchronous throws are caught on the same path as rejections. A handler
 *     that threw before returning a promise escaped the old `Promise.race`
 *     entirely and propagated into the send pipeline.
 *  3. A handler may be skipped only when it has not delegated and has committed
 *     nothing.
 *  4. Once delegation starts, failure means waiting on THAT operation (or
 *     surfacing its error) — never starting another one.
 *  5. A post-processing failure never re-issues the model or tool call.
 *  6. Downstream time and downstream errors are attributed downstream. Charging
 *     a slow model call to every enclosing interceptor is how three healthy
 *     plugins all trip their breakers at once.
 *  7. A timeout is not a successful cancellation. The capability is revoked so
 *     a late submission is refused, and the host does not pretend it rolled
 *     back work that already committed elsewhere.
 *  8. Transforms run serially unless a point declares its values disjoint.
 *  9. Re-entry is detected on the call graph, per operation.
 * 10. The point's failure policy decides; a registration may narrow it, never
 *     loosen it.
 *
 * Reuse: timeouts are `@cognia/primitives:withTimeout`, telemetry is the
 * existing plugin-hook span recorder, and failure bookkeeping is delegated to
 * an injected sink so the chat-middleware circuit breaker (and the settings UI
 * reading it) stays the one breaker for chat middleware rather than gaining a
 * rival.
 */

import { nanoid } from "nanoid"
import { withTimeout } from "@cognia/primitives"
import { recordPluginHookError, recordPluginHookEvent } from "@/lib/plugin/messaging/hook-telemetry"
import { requireInterceptorPoint } from "./points"
import { resolveInterceptorChain } from "./registry"
import {
  InterceptorFailClosedError,
  InterceptorGuardDeniedError,
  InterceptorNextReentryError,
  InterceptorReentrancyError,
  InterceptorRevokedError,
  resolveFailurePolicy,
  type InterceptorAroundHandler,
  type InterceptorFailurePolicy,
  type InterceptorGuardHandler,
  type InterceptorGuardVerdict,
  type InterceptorInvocationMetadata,
  type InterceptorNext,
  type InterceptorObserveHandler,
  type InterceptorPointSemantics,
  type InterceptorReentrancy,
  type InterceptorRegistration,
  type InterceptorTransformHandler,
} from "./types"

function now(): number {
  return globalThis.performance?.now() ?? Date.now()
}

/** Raised when an around handler returns a result it was not allowed to invent. */
export class InterceptorShortCircuitError extends Error {
  constructor(
    readonly pointId: string,
    readonly registrationId: string
  ) {
    super(
      `Interceptor "${registrationId}" returned a result without delegating on "${pointId}", ` +
        `which requires a real execution.`
    )
    this.name = "InterceptorShortCircuitError"
  }
}

/** Raised when a transform rewrites a field the caller declared invariant. */
export class InterceptorInvariantError extends Error {
  constructor(
    readonly pointId: string,
    readonly registrationId: string,
    readonly field: string
  ) {
    super(
      `Interceptor "${registrationId}" changed "${field}" on "${pointId}". ` +
        `A transform may reshape a payload but never its identity or authorization.`
    )
    this.name = "InterceptorInvariantError"
  }
}

/**
 * Where failure bookkeeping goes.
 *
 * Injected rather than owned so each caller keeps the breaker it already has:
 * chat middleware keeps the three-strike breaker its settings UI subscribes to,
 * plugin tools keep the resilience registry's breaker. One dispatcher, the
 * caller's own circuit.
 */
export interface InterceptorOutcomeSink {
  /** True when the breaker is open and this registration must be skipped. */
  shouldSkip?(registration: InterceptorRegistration): boolean
  recordSuccess(registration: InterceptorRegistration): void
  recordFailure(registration: InterceptorRegistration, reason: string): void
}

export interface InterceptorDispatchContext {
  /** Stable across the whole logical operation. */
  operationId: string
  traceId?: string
  parentCallId?: string
  sessionId?: string
  workspaceId?: string
  executionHostId?: string
  /**
   * Policy overlay revision in force. `"none"` is the honest value when no
   * overlay applies — not a placeholder for "we did not look".
   */
  policyRevision?: string
  bindingRevision?: string
  signal?: AbortSignal
  /** Remaining budget in ms, or null when the operation is unbounded. */
  deadlineBudgetMs?: number | null
  sink?: InterceptorOutcomeSink
  /** Pre-resolved chain. Adapters that already filtered pass theirs. */
  chain?: readonly InterceptorRegistration[]
}

export interface InterceptorSkip {
  registrationId: string
  reason: "breaker-open" | "timeout" | "threw" | "reentrancy" | "revoked" | "invariant"
}

export interface InterceptorFailure {
  registrationId: string
  message: string
  kind: InterceptorSkip["reason"]
}

export interface InterceptorRunReport {
  pointId: string
  operationId: string
  succeeded: string[]
  skipped: InterceptorSkip[]
  failed: InterceptorFailure[]
  /** Per-registration wall time spent INSIDE the handler, downstream excluded. */
  ownDurationMs: Record<string, number>
  /** Time spent below the chain (the terminal operation). */
  downstreamDurationMs: number
  /** Observe handlers dropped because the point's queue was full. */
  dropped: number
}

function createReport(pointId: string, operationId: string): InterceptorRunReport {
  return {
    pointId,
    operationId,
    succeeded: [],
    skipped: [],
    failed: [],
    ownDurationMs: {},
    downstreamDurationMs: 0,
    dropped: 0,
  }
}

/* -------------------------------------------------------------------------- */
/* Invocation identity                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Mint the audit bag for one invocation.
 *
 * Every identity field is copied off the REGISTRATION, which the host wrote at
 * activation from the plugin's lease. Nothing here is read back from the
 * handler's arguments or return value: a plugin that could state its own
 * `pluginId` or `generation` could attribute its calls to a plugin the user
 * trusts more.
 */
function mintMetadata(
  registration: InterceptorRegistration,
  context: InterceptorDispatchContext
): InterceptorInvocationMetadata {
  return {
    operationId: context.operationId,
    callId: `call_${nanoid(10)}`,
    ...(context.parentCallId ? { parentCallId: context.parentCallId } : {}),
    traceId: context.traceId ?? context.operationId,
    pluginInstanceId: registration.pluginInstanceId,
    pluginId: registration.pluginId,
    generation: registration.generation,
    realmId: registration.realmId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.executionHostId ? { executionHostId: context.executionHostId } : {}),
    policyRevision: context.policyRevision ?? "none",
    bindingRevision: context.bindingRevision ?? "none",
    cancellationId: `cancel_${nanoid(10)}`,
    deadlineBudgetMs: context.deadlineBudgetMs ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/* Re-entrancy                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Active invocations per (operation, point, registration).
 *
 * Module-level rather than context-propagated because a re-entry arrives
 * through an unrelated call stack — the plugin calls a host API, which
 * dispatches the point again — so the only thing linking the two is the
 * operation id. `AsyncLocalStorage` would be the nicer mechanism and does not
 * exist in the renderer.
 */
const activeInvocations = new Map<string, number>()

function reentrancyKey(operationId: string, registration: InterceptorRegistration): string {
  return `${operationId}::${registration.pointId}::${registration.registrationId}`
}

function enterInvocation(key: string): number {
  const depth = (activeInvocations.get(key) ?? 0) + 1
  activeInvocations.set(key, depth)
  return depth
}

function exitInvocation(key: string): void {
  const depth = (activeInvocations.get(key) ?? 1) - 1
  if (depth <= 0) activeInvocations.delete(key)
  else activeInvocations.set(key, depth)
}

function isReentryAllowed(policy: InterceptorReentrancy, depth: number): boolean {
  if (depth <= 1) return true
  switch (policy.kind) {
    case "forbid-same-operation":
      return false
    case "allow-child-call":
      return true
    case "bounded":
      return depth <= policy.maxDepth
  }
}

/* -------------------------------------------------------------------------- */
/* Shared failure handling                                                    */
/* -------------------------------------------------------------------------- */

function classifyFailure(error: unknown): InterceptorSkip["reason"] {
  if (error instanceof InterceptorReentrancyError) return "reentrancy"
  if (error instanceof InterceptorRevokedError) return "revoked"
  if (error instanceof InterceptorInvariantError) return "invariant"
  const name = error instanceof Error ? error.name : ""
  if (name === "TimeoutError" || name === "AbortError") return "timeout"
  return "threw"
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function noteFailure(
  report: InterceptorRunReport,
  registration: InterceptorRegistration,
  error: unknown,
  context: InterceptorDispatchContext
): InterceptorSkip["reason"] {
  const kind = classifyFailure(error)
  const message = messageOf(error)
  report.failed.push({ registrationId: registration.registrationId, message, kind })
  context.sink?.recordFailure(registration, kind === "timeout" ? "timeout" : message)
  recordPluginHookError(
    registration.pluginId,
    `${registration.pointId}:${registration.semantic}`,
    error instanceof Error ? error : new Error(message)
  )
  return kind
}

function noteSuccess(
  report: InterceptorRunReport,
  registration: InterceptorRegistration,
  ownMs: number,
  context: InterceptorDispatchContext
): void {
  report.succeeded.push(registration.registrationId)
  report.ownDurationMs[registration.registrationId] = ownMs
  context.sink?.recordSuccess(registration)
}

function emitSpan(
  registration: InterceptorRegistration,
  context: InterceptorDispatchContext,
  startedAtWallClock: number,
  ownMs: number,
  error?: unknown
): void {
  recordPluginHookEvent({
    pluginId: registration.pluginId,
    hookName: `${registration.pointId}:${registration.semantic}`,
    startTime: startedAtWallClock,
    // Rule 6: the span carries the handler's OWN time. Downstream latency is
    // reported once, on the operation, not smeared across every wrapper.
    durationMs: ownMs,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(error ? { error: error instanceof Error ? error : new Error(messageOf(error)) } : {}),
  })
}

function effectivePolicy(
  point: InterceptorPointSemantics,
  registration: InterceptorRegistration
): InterceptorFailurePolicy {
  return resolveFailurePolicy(point.failurePolicy, registration.failurePolicy)
}

function effectiveTimeout(
  point: InterceptorPointSemantics,
  registration: InterceptorRegistration,
  context: InterceptorDispatchContext
): number {
  const ceiling = Math.min(registration.timeoutMs, point.timeoutCeilingMs)
  const budget = context.deadlineBudgetMs
  return budget == null ? ceiling : Math.max(1, Math.min(ceiling, budget))
}

/**
 * Run a handler so that a synchronous throw and an async rejection arrive on
 * the same path (rule 2), under the effective deadline (rule 7).
 */
function runHandler<T>(invoke: () => T | Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return withTimeout(Promise.resolve().then(invoke), timeoutMs, label) as Promise<T>
}

function resolveChain(
  pointId: string,
  context: InterceptorDispatchContext
): readonly InterceptorRegistration[] {
  return context.chain ?? resolveInterceptorChain(pointId).ordered
}

/* -------------------------------------------------------------------------- */
/* observe                                                                    */
/* -------------------------------------------------------------------------- */

/** In-flight observe handlers per point, for the shed-load limit. */
const observeInFlight = new Map<string, number>()

/**
 * Fire an observation. Never blocks, never changes a result.
 *
 * Returns the report synchronously with whatever is already known; handlers
 * settle afterwards. Past the point's queue limit the payload is DROPPED and
 * counted rather than queued, because unbounded telemetry backpressure on the
 * chat path is a worse outcome than a missing metric.
 */
export function dispatchObserve<TPayload>(
  pointId: string,
  payload: TPayload,
  context: InterceptorDispatchContext
): InterceptorRunReport {
  const point = requireInterceptorPoint(pointId)
  const report = createReport(pointId, context.operationId)
  const chain = resolveChain(pointId, context)

  for (const registration of chain) {
    if (context.sink?.shouldSkip?.(registration)) {
      report.skipped.push({ registrationId: registration.registrationId, reason: "breaker-open" })
      continue
    }
    const inFlight = observeInFlight.get(pointId) ?? 0
    if (inFlight >= point.observeQueueLimit) {
      report.dropped += 1
      continue
    }
    observeInFlight.set(pointId, inFlight + 1)

    const meta = mintMetadata(registration, context)
    const wallClock = Date.now()
    const started = now()
    const handler = registration.handler as InterceptorObserveHandler<TPayload> | undefined
    if (!handler) {
      observeInFlight.set(pointId, (observeInFlight.get(pointId) ?? 1) - 1)
      continue
    }
    void runHandler(
      () => handler(payload, meta),
      effectiveTimeout(point, registration, context),
      `interceptor:${pointId}:${registration.registrationId}`
    )
      .then(() => {
        noteSuccess(report, registration, now() - started, context)
        emitSpan(registration, context, wallClock, now() - started)
      })
      .catch((error: unknown) => {
        // observe is fail-open by construction: an observer cannot change the
        // result, so its failure has nothing to block.
        noteFailure(report, registration, error, context)
        emitSpan(registration, context, wallClock, now() - started, error)
      })
      .finally(() => {
        observeInFlight.set(pointId, Math.max(0, (observeInFlight.get(pointId) ?? 1) - 1))
      })
  }
  return report
}

/* -------------------------------------------------------------------------- */
/* transform                                                                  */
/* -------------------------------------------------------------------------- */

export interface TransformDispatchOptions<TValue> extends InterceptorDispatchContext {
  /**
   * Fields a transform may reshape around but never rewrite.
   *
   * A transform is allowed to change what an operation says, never who it is
   * or what it is allowed to do — so `sessionId`, `pluginId` and the like are
   * listed here and a handler that rewrites one has its output rejected under
   * the point's failure policy instead of being trusted.
   */
  invariantFields?: readonly (keyof TValue & string)[]
}

function assertInvariants<TValue>(
  pointId: string,
  registration: InterceptorRegistration,
  before: TValue,
  after: TValue,
  fields: readonly string[] | undefined
): void {
  if (!fields?.length) return
  if (before == null || after == null || typeof before !== "object" || typeof after !== "object") {
    return
  }
  for (const field of fields) {
    const from = (before as Record<string, unknown>)[field]
    const to = (after as Record<string, unknown>)[field]
    if (from !== to) {
      throw new InterceptorInvariantError(pointId, registration.registrationId, field)
    }
  }
}

/**
 * Run a transform chain and return the rewritten value.
 *
 * Serial by default (rule 8): each handler sees the previous handler's output,
 * which is the only ordering under which "run me after the redactor" means
 * anything. A point that declares `parallelTransforms` must also supply
 * `mergeParallel`, because concurrent writers over one object is a race, not a
 * pipeline — and the host refuses to guess the merge.
 */
export async function dispatchTransform<TValue>(
  pointId: string,
  value: TValue,
  context: TransformDispatchOptions<TValue>
): Promise<{ value: TValue; report: InterceptorRunReport }> {
  const point = requireInterceptorPoint(pointId)
  const report = createReport(pointId, context.operationId)
  const chain = resolveChain(pointId, context)
  let current = value

  for (const registration of chain) {
    if (context.sink?.shouldSkip?.(registration)) {
      report.skipped.push({ registrationId: registration.registrationId, reason: "breaker-open" })
      continue
    }
    const handler = registration.handler as InterceptorTransformHandler<TValue> | undefined
    if (!handler) continue

    const key = reentrancyKey(context.operationId, registration)
    const depth = enterInvocation(key)
    const meta = mintMetadata(registration, context)
    const wallClock = Date.now()
    const started = now()
    try {
      if (!isReentryAllowed(point.reentrancy, depth)) {
        throw new InterceptorReentrancyError(pointId, registration.registrationId, depth)
      }
      const produced = await runHandler(
        () => handler(current, meta),
        effectiveTimeout(point, registration, context),
        `interceptor:${pointId}:${registration.registrationId}`
      )
      // A transform that returns nothing is treated as "no change" rather than
      // as "the value is now undefined" — the latter would let a forgotten
      // `return` blank the request.
      const next = (produced ?? current) as TValue
      assertInvariants(pointId, registration, current, next, context.invariantFields)
      current = next
      const ownMs = now() - started
      noteSuccess(report, registration, ownMs, context)
      emitSpan(registration, context, wallClock, ownMs)
    } catch (error) {
      const kind = noteFailure(report, registration, error, context)
      emitSpan(registration, context, wallClock, now() - started, error)
      const policy = effectivePolicy(point, registration)
      if (policy === "fail-open") {
        // Rule 3: nothing was committed — the previous value stands.
        report.skipped.push({ registrationId: registration.registrationId, reason: kind })
        continue
      }
      throw new InterceptorFailClosedError(pointId, registration.registrationId, messageOf(error))
    } finally {
      exitInvocation(key)
    }
  }

  return { value: current, report }
}

/* -------------------------------------------------------------------------- */
/* guard                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Ask the chain whether an operation may proceed.
 *
 * Stops at the first non-`pass`. That is not an optimization: it is what makes
 * "a guard can never turn a higher layer's deny into an allow" structurally
 * true rather than a rule someone has to remember, because no handler after a
 * deny ever runs.
 *
 * On a fail-closed point, a guard that throws or times out DENIES. "The policy
 * engine crashed" must never read as "the policy permitted it".
 */
export async function dispatchGuard<TPayload>(
  pointId: string,
  payload: TPayload,
  context: InterceptorDispatchContext
): Promise<{ verdict: InterceptorGuardVerdict; report: InterceptorRunReport }> {
  const point = requireInterceptorPoint(pointId)
  const report = createReport(pointId, context.operationId)
  const chain = resolveChain(pointId, context)

  for (const registration of chain) {
    if (context.sink?.shouldSkip?.(registration)) {
      report.skipped.push({ registrationId: registration.registrationId, reason: "breaker-open" })
      continue
    }
    const handler = registration.handler as InterceptorGuardHandler<TPayload> | undefined
    if (!handler) continue

    const key = reentrancyKey(context.operationId, registration)
    const depth = enterInvocation(key)
    const meta = mintMetadata(registration, context)
    const wallClock = Date.now()
    const started = now()
    try {
      if (!isReentryAllowed(point.reentrancy, depth)) {
        throw new InterceptorReentrancyError(pointId, registration.registrationId, depth)
      }
      const verdict = await runHandler(
        () => handler(payload, meta),
        effectiveTimeout(point, registration, context),
        `interceptor:${pointId}:${registration.registrationId}`
      )
      const ownMs = now() - started
      noteSuccess(report, registration, ownMs, context)
      emitSpan(registration, context, wallClock, ownMs)
      if (verdict && verdict.decision !== "pass") {
        return { verdict, report }
      }
    } catch (error) {
      const kind = noteFailure(report, registration, error, context)
      emitSpan(registration, context, wallClock, now() - started, error)
      const policy = effectivePolicy(point, registration)
      if (policy === "fail-open") {
        report.skipped.push({ registrationId: registration.registrationId, reason: kind })
        continue
      }
      if (policy === "require-approval") {
        return {
          verdict: {
            decision: "requireApproval",
            reason: `guard "${registration.registrationId}" failed: ${messageOf(error)}`,
          },
          report,
        }
      }
      return {
        verdict: {
          decision: "deny",
          reason: `guard "${registration.registrationId}" failed: ${messageOf(error)}`,
        },
        report,
      }
    } finally {
      exitInvocation(key)
    }
  }

  return { verdict: { decision: "pass" }, report }
}

/** Throwing variant for call sites whose contract is "proceed or raise". */
export async function requireGuardPass<TPayload>(
  pointId: string,
  payload: TPayload,
  context: InterceptorDispatchContext
): Promise<InterceptorRunReport> {
  const { verdict, report } = await dispatchGuard(pointId, payload, context)
  if (verdict.decision !== "pass") {
    const denier = report.failed.at(-1)?.registrationId ?? report.succeeded.at(-1) ?? "unknown"
    throw new InterceptorGuardDeniedError(pointId, denier, verdict)
  }
  return report
}

/* -------------------------------------------------------------------------- */
/* around                                                                     */
/* -------------------------------------------------------------------------- */

interface AroundState<TOut> {
  nextCalls: number
  delegation?: Promise<TOut>
  revoked: boolean
}

/**
 * Wrap one execution in the point's chain.
 *
 * `terminal` is the real operation. The chain is composed back-to-front so the
 * first registration in dispatch order is the outermost wrapper — the same
 * shape the chat middleware had, with the re-entry, revocation and attribution
 * rules the old runner was missing.
 */
export async function dispatchAround<TIn, TOut>(
  pointId: string,
  input: TIn,
  terminal: (value: TIn) => Promise<TOut>,
  context: InterceptorDispatchContext
): Promise<{ result: TOut; report: InterceptorRunReport }> {
  const point = requireInterceptorPoint(pointId)
  const report = createReport(pointId, context.operationId)
  const chain = resolveChain(pointId, context)

  const terminalRunner = async (value: TIn): Promise<TOut> => {
    const started = now()
    try {
      return await terminal(value)
    } finally {
      // Rule 6: measured once, here, and never charged to a wrapper.
      report.downstreamDurationMs += now() - started
    }
  }

  let runner: (value: TIn) => Promise<TOut> = terminalRunner
  for (let index = chain.length - 1; index >= 0; index--) {
    const registration = chain[index]!
    const next = runner
    runner = (value: TIn) =>
      runAroundEntry(point, pointId, registration, value, next, context, report)
  }

  let failure: unknown
  try {
    const result = await runner(input)
    emitOperationCompleted(pointId, report, context, true)
    return { result, report }
  } catch (error) {
    failure = error
    emitOperationCompleted(pointId, report, context, false, error)
    throw failure
  }
}

/** What an `operation.completed` observer receives. */
export interface OperationCompletedPayload {
  pointId: string
  operationId: string
  succeeded: boolean
  /** Error name only. The message can carry payload content; the name cannot. */
  errorName?: string
  downstreamDurationMs: number
  interceptorsRun: number
  interceptorsFailed: number
}

/**
 * Announce that a wrapped operation finished.
 *
 * Metadata only, by construction: an observer is the least trusted thing on the
 * chain and the payload is the easiest place to leak a prompt or a tool result
 * into somebody's telemetry. Counts, durations and an error NAME are enough to
 * build a dashboard and not enough to reconstruct the conversation.
 *
 * Emitted from `dispatchAround` only: an `around` point is the one that has a
 * whole operation to be terminal about, while a transform or a guard is a step
 * inside somebody else's. Skipped when the point IS `operation.completed`,
 * which would otherwise announce its own announcement forever.
 */
function emitOperationCompleted(
  pointId: string,
  report: InterceptorRunReport,
  context: InterceptorDispatchContext,
  succeeded: boolean,
  error?: unknown
): void {
  if (pointId === "operation.completed") return
  if (!resolveInterceptorChain("operation.completed").ordered.length) return
  const payload: OperationCompletedPayload = {
    pointId,
    operationId: report.operationId,
    succeeded,
    ...(error instanceof Error ? { errorName: error.name } : {}),
    downstreamDurationMs: report.downstreamDurationMs,
    interceptorsRun: report.succeeded.length,
    interceptorsFailed: report.failed.length,
  }
  dispatchObserve<OperationCompletedPayload>("operation.completed", payload, {
    operationId: report.operationId,
    ...(context.traceId ? { traceId: context.traceId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  })
}

async function runAroundEntry<TIn, TOut>(
  point: InterceptorPointSemantics,
  pointId: string,
  registration: InterceptorRegistration,
  value: TIn,
  next: (value: TIn) => Promise<TOut>,
  context: InterceptorDispatchContext,
  report: InterceptorRunReport
): Promise<TOut> {
  if (context.sink?.shouldSkip?.(registration)) {
    report.skipped.push({ registrationId: registration.registrationId, reason: "breaker-open" })
    return next(value)
  }
  const handler = registration.handler as InterceptorAroundHandler<TIn, TOut> | undefined
  if (!handler) return next(value)

  const key = reentrancyKey(context.operationId, registration)
  const depth = enterInvocation(key)
  const state: AroundState<TOut> = { nextCalls: 0, revoked: false }
  const wallClock = Date.now()
  const started = now()

  const nextFn: InterceptorNext<TIn, TOut> = (forwarded) => {
    // Rule 7: a deadline that expired revokes the capability. The downstream
    // work may already have committed; refusing the late call is the honest
    // answer, not a claim that anything was undone.
    if (state.revoked) {
      return Promise.reject(new InterceptorRevokedError(pointId, registration.registrationId))
    }
    state.nextCalls += 1
    // Rule 1: the second entry rejects and the terminal is NOT re-run.
    if (state.nextCalls > 1) {
      return Promise.reject(new InterceptorNextReentryError(pointId, registration.registrationId))
    }
    const delegation = next((forwarded ?? value) as TIn)
    state.delegation = delegation
    // A handler that abandons its own delegation must not surface as an
    // unhandled rejection; the value is still awaited on the failure path.
    void delegation.catch(() => {})
    return delegation
  }

  try {
    if (!isReentryAllowed(point.reentrancy, depth)) {
      throw new InterceptorReentrancyError(pointId, registration.registrationId, depth)
    }
    const meta = mintMetadata(registration, context)
    const produced = await runHandler(
      () => handler(value, nextFn, meta),
      effectiveTimeout(point, registration, context),
      `interceptor:${pointId}:${registration.registrationId}`
    )
    if (state.nextCalls === 0 && !point.allowShortCircuit) {
      throw new InterceptorShortCircuitError(pointId, registration.registrationId)
    }
    const ownMs = Math.max(0, now() - started - report.downstreamDurationMs)
    noteSuccess(report, registration, ownMs, context)
    emitSpan(registration, context, wallClock, ownMs)
    return produced
  } catch (error) {
    state.revoked = true
    const kind = noteFailure(report, registration, error, context)
    const ownMs = Math.max(0, now() - started - report.downstreamDurationMs)
    emitSpan(registration, context, wallClock, ownMs, error)
    const policy = effectivePolicy(point, registration)

    if (state.delegation) {
      // Rules 4 + 5: delegation already started. Wait on THAT operation —
      // never start another — and let a fail-closed point block the output
      // without pretending the downstream work did not happen.
      if (policy === "fail-open") return state.delegation
      const downstream = await state.delegation.then(
        () => undefined,
        (downstreamError: unknown) => downstreamError
      )
      if (downstream !== undefined) throw downstream
      throw new InterceptorFailClosedError(pointId, registration.registrationId, messageOf(error))
    }

    // Rule 3: nothing delegated, nothing committed — the interceptor may be
    // dropped, but only where the point says a missing interceptor is safe.
    if (policy === "fail-open") {
      report.skipped.push({ registrationId: registration.registrationId, reason: kind })
      return next(value)
    }
    throw new InterceptorFailClosedError(pointId, registration.registrationId, messageOf(error))
  } finally {
    exitInvocation(key)
  }
}

/** Test-only: drop re-entrancy and observe-queue bookkeeping. */
export function __resetInterceptorDispatchForTesting(): void {
  activeInvocations.clear()
  observeInFlight.clear()
}
