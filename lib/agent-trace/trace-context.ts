/**
 * TraceContext helpers — thin, pure wrappers over the agent-trace emitter that
 * mint a turn's root span and derive child-span inputs that nest under it.
 *
 * These exist so the mint/child-nesting convention lives in ONE place instead
 * of being open-coded at every surface (chat hook, build-options, connector
 * runtime, provider telemetry). All trace propagation flows through an explicit
 * `TraceContext` value — see `@/types/agent-trace/trace-context` for why.
 */
import { startSpan, type StartSpanInput } from "@cognia/agent-trace/emitter"
import type { TraceContext } from "@/types/agent-trace/trace-context"

/**
 * Mint a turn's ROOT span and return both its `TraceContext` (to thread down to
 * children) and its raw `spanId` (to pass back to `endSpan`). Pure wrapper over
 * `startSpan` — no ambient state touched.
 */
export function startRootTrace(input: StartSpanInput): { ctx: TraceContext; spanId: string } {
  const { traceId, spanId } = startSpan(input)
  return { ctx: { traceId, rootSpanId: spanId }, spanId }
}

/**
 * Derive a `StartSpanInput` for a child span that nests under `ctx`. Forces the
 * child onto the parent's trace and parent span; any caller-supplied
 * `traceId`/`parentSpanId` are stripped by the `Omit` so they cannot break the
 * hierarchy.
 */
export function childSpanInput(
  ctx: TraceContext,
  input: Omit<StartSpanInput, "traceId" | "parentSpanId">
): StartSpanInput {
  return { ...input, traceId: ctx.traceId, parentSpanId: ctx.rootSpanId }
}
