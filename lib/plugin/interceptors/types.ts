/**
 * Host-side interceptor types (ADR-0189).
 *
 * The author-facing vocabulary — the four semantics, the failure and reentrancy
 * policies, the handler signatures — lives in `types/plugin/plugin-interceptors.ts`
 * and is re-exported here so host modules have one import. Everything below the
 * re-export is host-only: the normalized registration record, the point
 * semantics the host declares, and the structured errors the dispatcher raises.
 */

import type { PluginApiRuntime } from "@/lib/plugin/contracts/interface-catalog"
import type {
  InterceptorAroundHandler,
  InterceptorFailurePolicy,
  InterceptorGuardHandler,
  InterceptorGuardVerdict,
  InterceptorObserveHandler,
  InterceptorOrder,
  InterceptorSemantic,
  InterceptorTransformHandler,
  InterceptorTrustTier,
} from "@/types/plugin/plugin-interceptors"

export * from "@/types/plugin/plugin-interceptors"

export type InterceptorHandler =
  | InterceptorObserveHandler<never>
  | InterceptorTransformHandler<never>
  | InterceptorGuardHandler<never>
  | InterceptorAroundHandler<never, never>

/**
 * One normalized interceptor registration.
 *
 * This is the record the registry stores no matter which authoring surface the
 * plugin used — `defineInterceptors`, the legacy `PluginHooks` bag, or
 * `ctx.chat.use`. Normalizing at registration rather than at dispatch is what
 * makes "one ordering rule, one liveness rule, one failure rule" true instead
 * of aspirational.
 */
export interface InterceptorRegistration {
  registrationId: string
  pluginId: string
  pluginInstanceId: string
  generation: number
  realmId: string
  pointId: string
  semantic: InterceptorSemantic
  trustTier: InterceptorTrustTier
  order: InterceptorOrder
  /** Per-invocation deadline. Clamped by the point's ceiling. */
  timeoutMs: number
  /**
   * In-process handler. Absent for a registration whose handler lives in
   * another process — that one carries `handlerRef` and is invoked through the
   * runtime bridge, because a JS closure cannot cross a process boundary.
   */
  handler?: InterceptorHandler
  /** Opaque host-side reference for out-of-process handlers. */
  handlerRef?: string
  /** Narrowing only — may never loosen the point's policy. */
  failurePolicy?: InterceptorFailurePolicy
  /** Which authoring surface produced this record. Diagnostics only. */
  source: "interceptors" | "legacy-hooks" | "chat-middleware"
  /** Legacy hook name this record was normalized from, when applicable. */
  legacyHookName?: string
  /** Runtime the handler executes in. */
  runtime: PluginApiRuntime
}

/** Ordering / resolution diagnostics, surfaced to the plugin devtools panel. */
export interface InterceptorOrderDiagnostic {
  code:
    | "interceptor.order.cycle"
    | "interceptor.order.missing-dependency"
    | "interceptor.order.tier-conflict"
  pointId: string
  registrationIds: readonly string[]
  message: string
}

/** Raised when an around handler calls `next` more than once. */
export class InterceptorNextReentryError extends Error {
  constructor(
    readonly pointId: string,
    readonly registrationId: string
  ) {
    super(
      `Interceptor "${registrationId}" called next() more than once on "${pointId}". ` +
        `The downstream operation is not re-run.`
    )
    this.name = "InterceptorNextReentryError"
  }
}

/**
 * Raised when a handler touches `next` after its own deadline expired.
 *
 * A timeout is not a successful cancellation — the downstream work may already
 * have committed. Revoking the capability is how the host refuses the late
 * submission without pretending it rolled anything back.
 */
export class InterceptorRevokedError extends Error {
  constructor(
    readonly pointId: string,
    readonly registrationId: string
  ) {
    super(`Interceptor "${registrationId}" on "${pointId}" used a revoked next() capability.`)
    this.name = "InterceptorRevokedError"
  }
}

/** Raised when a fail-closed point loses its interceptor. */
export class InterceptorFailClosedError extends Error {
  constructor(
    readonly pointId: string,
    readonly registrationId: string,
    readonly cause: string
  ) {
    super(`Interceptor "${registrationId}" failed on fail-closed point "${pointId}": ${cause}`)
    this.name = "InterceptorFailClosedError"
  }
}

/** Raised when a guard denies, or escalates to a human. */
export class InterceptorGuardDeniedError extends Error {
  constructor(
    readonly pointId: string,
    readonly registrationId: string,
    readonly verdict: Exclude<InterceptorGuardVerdict, { decision: "pass" }>
  ) {
    super(`Interceptor "${registrationId}" ${verdict.decision} on "${pointId}": ${verdict.reason}`)
    this.name = "InterceptorGuardDeniedError"
  }
}

/** Raised when a registration re-enters its own point against policy. */
export class InterceptorReentrancyError extends Error {
  constructor(
    readonly pointId: string,
    readonly registrationId: string,
    readonly depth: number
  ) {
    super(
      `Interceptor "${registrationId}" re-entered "${pointId}" at depth ${depth}, ` +
        `which its reentrancy policy forbids.`
    )
    this.name = "InterceptorReentrancyError"
  }
}

/**
 * Effective failure policy for one invocation.
 *
 * The point's policy is the floor. A registration may only move toward
 * stricter — `fail-open` → `fail-closed` / `require-approval` — never away
 * from it, so a plugin cannot opt out of a safety gate by declaring itself
 * best-effort.
 */
const FAILURE_STRICTNESS: Readonly<Record<InterceptorFailurePolicy, number>> = Object.freeze({
  "fail-open": 0,
  "require-approval": 1,
  "fail-closed": 2,
})

export function resolveFailurePolicy(
  pointPolicy: InterceptorFailurePolicy,
  requested: InterceptorFailurePolicy | undefined
): InterceptorFailurePolicy {
  if (!requested) return pointPolicy
  return FAILURE_STRICTNESS[requested] > FAILURE_STRICTNESS[pointPolicy] ? requested : pointPolicy
}
