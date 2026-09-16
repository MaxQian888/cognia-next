/**
 * Chat-middleware runner.
 *
 * Thin adapter now. The chain is resolved, ordered and executed by the one
 * interceptor dispatcher (`lib/plugin/interceptors`); this module only converts
 * between the chat-middleware vocabulary the plugin API exposes and the
 * interceptor vocabulary the host dispatches in, and keeps the three-strike
 * circuit breaker the settings UI already subscribes to.
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 *
 * The previous implementation composed the chain itself and, when a middleware
 * timed out or threw, called `next(req)` again:
 *
 *     const result = await raceWithTimeout(callMiddleware(), entry.timeoutMs)
 *     if (result.kind === "timeout") { …; return next(req) }   // ← second call
 *     if (result.kind === "error")   { …; return next(req) }   // ← second call
 *
 * That is correct only when the middleware never delegated. When it HAD
 * delegated — the common case for a middleware that awaits `next()` and then
 * post-processes — the downstream terminal ran once for the delegation and
 * again for the recovery, so one user turn produced two model requests. A
 * middleware that simply called `next()` twice hit the same path. And a
 * middleware that threw SYNCHRONOUSLY escaped the `Promise.race` entirely,
 * because `raceWithTimeout` could only catch a rejection, not a throw that
 * happened before a promise existed.
 *
 * `dispatchAround` fixes all three at once: `next` is entry-once per
 * invocation, a failure after delegation awaits THAT operation instead of
 * starting another, and sync throws and async rejections arrive on one path.
 *
 * ADR-0026 §4 §A, ADR-0189 §6.3.
 */

import type {
  ChatMiddlewareRequest,
  ChatMiddlewareResponse,
  ChatMiddleware,
} from "@/types/plugin/plugin-chat-middleware"
import {
  dispatchAround,
  dispatchTransform,
  type InterceptorOutcomeSink,
  type InterceptorRegistration,
  type InterceptorRunReport,
} from "@/lib/plugin/interceptors"
import {
  getChatMiddleware,
  listActiveChatMiddlewares,
  recordMiddlewareFailure,
  recordMiddlewareSuccess,
  type ChatMiddlewareRegistration,
} from "./registry"

export interface ChatMiddlewareRunReport {
  /** Middlewares that ran successfully (their `fullId`). */
  succeeded: string[]
  /** Middlewares that timed out (their `fullId`). */
  timedOut: string[]
  /** Middlewares that threw (their `fullId` + error message). */
  threw: Array<{ fullId: string; message: string }>
  /**
   * Middlewares whose breaker tripped during this run (i.e. failure
   * counter crossed 3). They are removed from subsequent turns.
   */
  trippedBreakers: string[]
}

export interface RunChatMiddlewareChainOptions {
  /** AbortSignal threaded into each middleware via the request object. */
  signal?: AbortSignal
  /**
   * Override the middleware list (for tests). Defaults to the global
   * `listActiveChatMiddlewares()` snapshot at call time.
   */
  middlewares?: ChatMiddlewareRegistration[]
  /**
   * Optional hook fired after the chain completes — receives the run
   * report. Useful for telemetry / settings-UI surfacing.
   */
  onReport?: (report: ChatMiddlewareRunReport) => void
  /**
   * Correlation id for the whole turn. Defaults to the session id, which is
   * the coarsest thing that is always present; a caller that runs two turns
   * concurrently on one session should pass something finer so the
   * dispatcher's re-entrancy detection can tell them apart.
   */
  operationId?: string
  /**
   * Skip the `around` stage (`model.request.invoke`) and call the terminal
   * directly.
   *
   * The around stage IS the chat middleware, and ADR-0026 §4 §A gates it behind
   * a default-off flag because it wraps the entire billed send. The transform
   * stage is a different animal — a bounded rewrite of the request object, the
   * same class of thing `onBuildOptions` already does on every turn — so it is
   * not gated with it. Passing this keeps the locked decision without making a
   * `model.request.prepare` interceptor silently dead.
   */
  skipInvoke?: boolean
}

/**
 * The breaker stays where it is.
 *
 * Chat middleware already has a three-strike breaker with its own events and a
 * settings panel subscribed to them. The dispatcher takes the sink rather than
 * owning a breaker so that stays the ONE circuit for chat middleware instead of
 * gaining a second one that disagrees with it.
 */
function createBreakerSink(report: ChatMiddlewareRunReport): InterceptorOutcomeSink {
  return {
    // A tripped breaker leaves the registration in place and skips it per
    // turn, rather than unregistering it: the settings panel still needs to
    // show the middleware so the user has something to press "retry" on.
    shouldSkip: (registration) => getChatMiddleware(registration.registrationId)?.disabled === true,
    recordSuccess: (registration) => {
      recordMiddlewareSuccess(registration.registrationId)
    },
    recordFailure: (registration, reason) => {
      const tripped = recordMiddlewareFailure(registration.registrationId, reason)
      if (tripped && !report.trippedBreakers.includes(registration.registrationId)) {
        report.trippedBreakers.push(registration.registrationId)
      }
    },
  }
}

function toChatReport(
  chatReport: ChatMiddlewareRunReport,
  interceptorReport: InterceptorRunReport
): void {
  chatReport.succeeded.push(...interceptorReport.succeeded)
  for (const failure of interceptorReport.failed) {
    if (failure.kind === "timeout") chatReport.timedOut.push(failure.registrationId)
    else chatReport.threw.push({ fullId: failure.registrationId, message: failure.message })
  }
}

/**
 * Execute the middleware chain. `terminal` is the real send call —
 * receives the (possibly transformed) request and returns the host's
 * raw response. The runner returns the final transformed response after
 * all middlewares have wrapped it.
 */
export async function runChatMiddlewareChain(
  request: ChatMiddlewareRequest,
  terminal: (req: ChatMiddlewareRequest) => Promise<ChatMiddlewareResponse>,
  options: RunChatMiddlewareChainOptions = {}
): Promise<{ response: ChatMiddlewareResponse; report: ChatMiddlewareRunReport }> {
  const report: ChatMiddlewareRunReport = {
    succeeded: [],
    timedOut: [],
    threw: [],
    trippedBreakers: [],
  }

  const finalRequest: ChatMiddlewareRequest = options.signal
    ? { ...request, signal: options.signal }
    : request

  const operationId = options.operationId ?? `chat:${request.sessionId}`
  const sink = createBreakerSink(report)
  const context = {
    operationId,
    sessionId: request.sessionId,
    ...(options.signal ? { signal: options.signal } : {}),
    sink,
  }

  // Stage 1 — request preparation. Serial transform chain; `sessionId` is
  // declared invariant because a rewrite that redirects a turn to a different
  // session is an authorization change wearing a transform's clothes.
  const prepared = await dispatchTransform<ChatMiddlewareRequest>(
    "model.request.prepare",
    finalRequest,
    { ...context, invariantFields: ["sessionId"] }
  )
  toChatReport(report, prepared.report)

  // Stage 2 — the send itself, wrapped.
  if (options.skipInvoke) {
    const response = await terminal(prepared.value)
    options.onReport?.(report)
    return { response, report }
  }
  const chain = options.middlewares?.map(toInterceptorOverride)
  const { result, report: aroundReport } = await dispatchAround<
    ChatMiddlewareRequest,
    ChatMiddlewareResponse
  >("model.request.invoke", prepared.value, terminal, {
    ...context,
    ...(chain ? { chain } : {}),
  })
  toChatReport(report, aroundReport)

  options.onReport?.(report)
  return { response: result, report }
}

/**
 * Test/override path: express an explicit middleware list as interceptors.
 *
 * Production never takes this branch — `registerChatMiddleware` already mints
 * the registration, so the live chain comes from the registry with the trust
 * tier and generation the host resolved at activation. This exists so a test
 * can hand the runner a chain without standing the plugin store up, and it is
 * deliberately NOT a way for a caller to inject a handler at a trust tier it
 * did not earn: the override is community-tier and generation 0.
 */
function toInterceptorOverride(entry: ChatMiddlewareRegistration): InterceptorRegistration {
  return {
    registrationId: entry.fullId,
    pluginId: entry.pluginId,
    pluginInstanceId: entry.pluginId,
    generation: 0,
    realmId: "global",
    pointId: "model.request.invoke",
    semantic: "around",
    trustTier: "community",
    order: { priority: entry.priority },
    timeoutMs: entry.timeoutMs,
    handler: ((
      input: ChatMiddlewareRequest,
      next: (value?: ChatMiddlewareRequest) => Promise<ChatMiddlewareResponse>
    ) => entry.fn(input, () => next(input))) as unknown as InterceptorRegistration["handler"],
    source: "chat-middleware",
    runtime: "frontend",
  }
}

/** Re-export so tests can build a chain without touching the registry. */
export { listActiveChatMiddlewares }

/**
 * Re-export for tests that want to compose the chain without the registry.
 */
export type { ChatMiddleware }
