/**
 * Semantic interceptor vocabulary (ADR-0189).
 *
 * The plugin surface used to answer every "let me participate in this" request
 * with the same shape — a function on a bag of hooks — so the host could not
 * tell an observer apart from something that rewrites the request, vetoes it,
 * or wraps the whole execution. That distinction is not cosmetic: it decides
 * whether a failure may be swallowed, whether a handler may run in parallel
 * with its peers, and whether a late return value is still allowed to land.
 *
 * Five mechanisms, four of which are interceptors:
 *
 *   - `observe`    something happened. Cannot change the result. Async,
 *                  bounded, droppable.
 *   - `transform`  rewrite an input or a projection. Gets its own snapshot,
 *                  returns a new value, must be repeatable, must not change
 *                  identity or authorization.
 *   - `guard`      may this continue? pass / deny / requireApproval. A guard
 *                  can never turn a higher layer's deny into an allow.
 *   - `around`     wrap one execution. Typed in and out, `next` at most once,
 *                  explicit error and cancellation semantics.
 *
 * (The fifth, `contribution`, is the existing declarative registration path and
 * is not an interceptor.)
 *
 * This module is the AUTHOR-facing half: the vocabulary a plugin writes against
 * and nothing that only the host needs. Host-side records (`InterceptorRegistration`,
 * the point semantics, the dispatch errors) live in
 * `lib/plugin/interceptors/types.ts`, so an SDK consumer never pulls the runtime
 * in just to type a handler.
 */

export type InterceptorSemantic = "observe" | "transform" | "guard" | "around"

/**
 * How far the host trusts a registration, decided by INSTALL PROVENANCE.
 *
 * Deliberately not read from the manifest: a plugin that could name its own
 * tier would simply name the highest one, and tier decides dispatch order —
 * i.e. who gets to see and rewrite a payload first. `builtin` is in-tree,
 * `verified` came from a signed marketplace entry, `community` is everything
 * else including sideloaded and developer-mode plugins.
 */
export type InterceptorTrustTier = "builtin" | "verified" | "community"

/** Ascending = runs later. Builtin wraps verified wraps community. */
export const INTERCEPTOR_TRUST_ORDER: Readonly<Record<InterceptorTrustTier, number>> =
  Object.freeze({
    builtin: 0,
    verified: 1,
    community: 2,
  })

/**
 * What the host does when an interceptor fails (throws, times out, or is
 * revoked) rather than returning a verdict.
 *
 *   - `fail-open`      drop the interceptor and continue. Only ever correct for
 *                      telemetry and presentation.
 *   - `fail-closed`    the operation fails. The default for anything on a
 *                      safety path, because "the redactor crashed" must not
 *                      read as "nothing needed redacting".
 *   - `require-approval` escalate to a human instead of guessing.
 *
 * Declared per POINT by the host and per registration only as a NARROWING:
 * a plugin may make its own interceptor stricter, never looser. See
 * `resolveFailurePolicy`.
 */
export type InterceptorFailurePolicy = "fail-open" | "fail-closed" | "require-approval"

/**
 * Whether an interceptor may be re-entered while one of its own invocations is
 * still in flight for the same operation.
 *
 *   - `forbid-same-operation` the same registration may not re-enter the same
 *     point within one operation. Catches the classic "my transform calls the
 *     API that dispatches my transform" loop on the first bounce.
 *   - `allow-child-call` re-entry is allowed but must be a declared child call,
 *     so it carries `parentCallId` and spends from the same budget.
 *   - `bounded` re-entry allowed up to `maxDepth`.
 */
export type InterceptorReentrancy =
  | { kind: "forbid-same-operation" }
  | { kind: "allow-child-call" }
  | { kind: "bounded"; maxDepth: number }

/** Which world a registration is bound to for its whole life. */
export type InterceptorScopeBinding = "plugin" | "project" | "session" | "run"

/** Where the handler actually runs. Host-decided, never plugin-selected. */
export type InterceptorExecutionPlacement = "ui" | "workspace" | "host-service"

/**
 * Relative ordering request.
 *
 * `before`/`after` name other registration ids or plugin ids and are resolved
 * as a DAG; `priority` only breaks ties the DAG leaves open. A missing soft
 * dependency is ignored with a diagnostic; a cycle is reported and the edges
 * that close it are dropped, because refusing to dispatch at all would turn one
 * plugin's typo into an outage for every other plugin on the point.
 */
export interface InterceptorOrder {
  before?: readonly string[]
  after?: readonly string[]
  priority?: number
}

/**
 * Audit and correlation fields for one interceptor invocation.
 *
 * Every field here is stamped by the host from the authenticated transport, the
 * runtime instance and the grant ledger. None of it is read from anything the
 * plugin sends: a plugin that could assert its own `pluginId`, `generation` or
 * `executionHostId` could attribute its calls to somebody else. These are audit
 * fields, NOT an authorization credential — nothing downstream may treat the
 * presence of a metadata bag as proof that a call was allowed.
 */
export interface InterceptorInvocationMetadata {
  /** Stable across the whole logical operation (one send, one tool call). */
  operationId: string
  /** This interceptor invocation. */
  callId: string
  /** Set when this invocation was spawned from another one. */
  parentCallId?: string
  traceId: string
  pluginInstanceId: string
  pluginId: string
  /** Activation generation. A stale generation's handler is refused. */
  generation: number
  realmId: string
  sessionId?: string
  workspaceId?: string
  executionHostId?: string
  policyRevision: string
  bindingRevision: string
  /**
   * Correlates cancellation across a JSON boundary.
   *
   * An `AbortSignal` cannot be serialized, so out-of-process runtimes get this
   * id and a deadline budget in milliseconds, and convert the budget against
   * their own monotonic clock on arrival rather than trusting a wall-clock
   * timestamp minted on another machine.
   */
  cancellationId: string
  /** Remaining budget in ms at dispatch time, or null when unbounded. */
  deadlineBudgetMs: number | null
}

/** A guard's answer. `deny` and `requireApproval` both stop the operation. */
export type InterceptorGuardVerdict =
  | { decision: "pass" }
  | { decision: "deny"; reason: string }
  | { decision: "requireApproval"; reason: string; approvalRef?: string }

/** `next` as an around handler sees it. Callable at most once per invocation. */
export type InterceptorNext<TIn, TOut> = (input?: TIn) => Promise<TOut>

export type InterceptorObserveHandler<TPayload> = (
  payload: TPayload,
  meta: InterceptorInvocationMetadata
) => void | Promise<void>

export type InterceptorTransformHandler<TValue> = (
  value: TValue,
  meta: InterceptorInvocationMetadata
) => TValue | Promise<TValue>

export type InterceptorGuardHandler<TPayload> = (
  payload: TPayload,
  meta: InterceptorInvocationMetadata
) => InterceptorGuardVerdict | Promise<InterceptorGuardVerdict>

export type InterceptorAroundHandler<TIn, TOut> = (
  input: TIn,
  next: InterceptorNext<TIn, TOut>,
  meta: InterceptorInvocationMetadata
) => TOut | Promise<TOut>

/**
 * Everything the host needs to dispatch a point, declared by the HOST.
 *
 * These live on the point rather than on the registration because they are
 * properties of the operation being intercepted, not of whoever intercepts it.
 * A plugin that could pick its own `failurePolicy` could turn a mandatory
 * redaction guard into a best-effort one simply by declaring it optional, so
 * the registration side may only ever NARROW (see `resolveFailurePolicy`).
 */
export interface InterceptorPointSemantics {
  semantic: InterceptorSemantic
  /** Permission a plugin must hold to register on this point. */
  permission?: string
  failurePolicy: InterceptorFailurePolicy
  reentrancy: InterceptorReentrancy
  scopeBinding: InterceptorScopeBinding
  executionPlacement: InterceptorExecutionPlacement
  /** Per-interceptor deadline ceiling. A registration may ask for less. */
  timeoutCeilingMs: number
  /**
   * Whether an `around` interceptor may return a result without delegating.
   *
   * False for anything whose receipt has to be real — a tool execution, a
   * model call that bills. A cache that legitimately short-circuits is the
   * reason this is not simply always false, but the result carries provenance
   * either way so a synthetic answer is never indistinguishable from a
   * performed one.
   */
  allowShortCircuit: boolean
  /**
   * Whether `transform` handlers may run concurrently.
   *
   * Default false: two transforms writing the same field concurrently is a
   * last-write-wins race dressed up as a pipeline. Concurrency is opt-in per
   * point and only where the values are provably disjoint.
   */
  parallelTransforms: boolean
  /** Max in-flight `observe` handlers before the point sheds telemetry. */
  observeQueueLimit: number
}

/**
 * Every interceptor point id, as the authoring surface sees it.
 *
 * The list lives here rather than beside the host's point contracts so a plugin
 * can name a point from the SDK without importing the runtime — and so there is
 * still exactly one list. `lib/plugin/contracts/plugin-points.ts` imports this
 * tuple and hangs the host's semantics, binding and status off it, which is
 * what keeps "declared" and "dispatched" from drifting.
 */
export const PLUGIN_INTERCEPTOR_POINTS = [
  "agent.context.prepare",
  "model.request.prepare",
  "model.request.invoke",
  "model.stream.transform",
  "tool.call.prepare",
  "tool.execute",
  "tool.result.project",
  "agent.turn.decide",
  "ui.action.invoke",
  "ui.surface.project",
  "operation.completed",
] as const

export type PluginInterceptorPoint = (typeof PLUGIN_INTERCEPTOR_POINTS)[number]

/**
 * One interceptor a plugin contributes from `activate()`.
 *
 * Declarative on purpose: `defineInterceptors` builds these and returns them,
 * and the host registers them. A helper that registered as a side effect of
 * being CALLED would make registration depend on when a module was imported,
 * which is how a plugin ends up half-registered after a hot reload.
 */
export interface PluginInterceptorContribution {
  point: PluginInterceptorPoint
  /**
   * Which of the four mechanisms this handler is. Optional because the point
   * already declares it — pass it to have the host reject a mismatch at
   * registration instead of at the first dispatch.
   */
  semantic?: InterceptorSemantic
  handler: (...args: never[]) => unknown
  /** Registration ids or plugin ids this must run before. */
  before?: readonly string[]
  /** Registration ids or plugin ids this must run after. */
  after?: readonly string[]
  /** Tiebreak only, where before/after leaves the order open. */
  priority?: number
  /** Requested deadline. Clamped down by the point's ceiling, never up. */
  timeoutMs?: number
  /** Strictness narrowing. The host refuses anything looser than the point. */
  failurePolicy?: InterceptorFailurePolicy
  /** Stable id for diagnostics and for other plugins to order against. */
  id?: string
}
