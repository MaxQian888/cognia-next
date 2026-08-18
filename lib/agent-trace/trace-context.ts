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

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i
const ZERO_TRACE_ID = "0".repeat(32)
const ZERO_SPAN_ID = "0".repeat(16)

export interface ParsedTraceparent extends TraceContext {
  sampled: boolean
}

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
 * Derive a `StartSpanInput` for a child span that nests under `ctx`.
 *
 * The trace is always the context's — that is the invariant worth forcing, and
 * the `Omit` keeps a caller from breaking it. The PARENT is not: pass
 * `parentSpanId` to nest under an intermediate span (a tool call, a subagent
 * dispatch) instead of the turn root. Defaulting to the root is what made every
 * trace exactly one level deep — a subagent's work appeared as a sibling of the
 * tool call that spawned it, so the waterfall could not show that one caused the
 * other.
 */
export function childSpanInput(
  ctx: TraceContext,
  input: Omit<StartSpanInput, "traceId" | "parentSpanId">,
  parentSpanId: string = ctx.rootSpanId
): StartSpanInput {
  return { ...input, traceId: ctx.traceId, parentSpanId }
}

/** Format the explicit renderer context for a sampled W3C propagation hop. */
export function toTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId.toLowerCase()}-${ctx.rootSpanId.toLowerCase()}-01`
}

/** Parse the version-00 W3C wire shape without accepting invalid zero ids. */
export function parseTraceparent(value: string): ParsedTraceparent | null {
  const match = TRACEPARENT_RE.exec(value.trim())
  if (!match || match[1].toLowerCase() !== "00") return null
  const traceId = match[2].toLowerCase()
  const rootSpanId = match[3].toLowerCase()
  if (traceId === ZERO_TRACE_ID || rootSpanId === ZERO_SPAN_ID) return null
  const flags = Number.parseInt(match[4], 16)
  return { traceId, rootSpanId, sampled: (flags & 0x01) === 0x01 }
}
