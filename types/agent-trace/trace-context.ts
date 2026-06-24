/**
 * TraceContext — the explicit, immutable value object that carries a turn's
 * trace identity BY VALUE across async / concurrent boundaries.
 *
 * Why this exists: `lib/logging/context.ts:logContext` is a tab-global mutable
 * singleton, and the browser has no AsyncLocalStorage, so two concurrent turns
 * (agent-team members sharing a session, multiple session panes, background
 * connector ai-runs) would cross-contaminate an ambient trace id. Passing a
 * `TraceContext` value down the call chain keeps each turn's trace isolated
 * with no shared mutable state.
 *
 * On the wire, `SendOptions.{traceId,spanId}` ARE this context (`spanId` ==
 * `rootSpanId`); this interface is the in-renderer orchestration form.
 *
 * Rule: instrumentation code reads trace ids from a passed `TraceContext` /
 * `SendOptions`, NEVER from `logContext.traceId`.
 */
export interface TraceContext {
  /** W3C 32-hex trace id — stable for the whole turn and all its child spans. */
  traceId: string
  /** W3C 16-hex span id of the turn's ROOT span — the parent for child spans. */
  rootSpanId: string
}
