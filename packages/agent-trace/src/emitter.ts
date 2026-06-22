/**
 * Agent-trace span emitter.
 *
 * Single entry point for emitting spans across the chat loop, Agent Team
 * dispatcher, plugin-hook gates, and (later) connector/workflow surfaces.
 *
 * Lifecycle:
 *   const { spanId, traceId } = startSpan({...})
 *   recordEvent(spanId, { name: "tool_use", at: Date.now(), attributes: {...} })
 *   endSpan(spanId, { usage, costUsdEstimate, finishReasons })
 *
 * The emitter buffers in-progress spans in a module-level Map keyed by
 * `spanId`. `endSpan` finalizes the row (sets `endTime` / `durationMs`),
 * removes it from the map, and hands the finished `AgentTraceSpan` to the
 * registered writer.
 *
 * Default writer = `null` (drop). `setAgentTraceWriter(fn)` is wired up at
 * bootstrap time in Phase A2 to route spans through CoreLogger → the
 * `agent-trace` transport → Dexie. Tests inject a fake writer.
 */

import type {
  AgentTraceSpan,
  SpanEvent,
  SpanHandoff,
  SpanOperationName,
  SpanProviderName,
  SpanSurface,
  SpanUsage,
} from "./types"

/** Args accepted by `startSpan`. All optional inheritance fields are
 * forwarded as-is so nested spans don't lose context. */
export interface StartSpanInput {
  /** OTel `gen_ai.operation.name`. */
  operationName: SpanOperationName
  /** OTel `gen_ai.provider.name` (incl. our `cognia.*` vendors). */
  providerName: SpanProviderName
  sessionId: string
  surface: SpanSurface

  /** Reuse caller's traceId — required for child spans. New random id when omitted. */
  traceId?: string
  /** Identifies the parent span; set when this span nests under one. */
  parentSpanId?: string
  /** Reuse caller-provided spanId (rare — only when echoing back from the SDK). */
  spanId?: string

  requestModel?: string
  agentId?: string
  agentName?: string
  toolName?: string
  pluginId?: string
  handoff?: SpanHandoff

  inputPreview?: string
  metadata?: Record<string, unknown>
}

/** Args accepted by `endSpan`. */
export interface EndSpanInput {
  usage?: SpanUsage
  costUsdEstimate?: number
  responseModel?: string
  finishReasons?: string[]
  errorType?: string
  errorMessage?: string
  outputPreview?: string
  metadata?: Record<string, unknown>
  /** Override end time (defaults to `Date.now()`). Useful when replaying. */
  endTime?: number
}

/** Span writer — receives one finished `AgentTraceSpan` per `endSpan` call. */
export type AgentTraceWriter = (span: AgentTraceSpan) => void

/** Handle returned from `startSpan`. The caller stores `spanId` to pass
 * back into `endSpan` / `recordEvent`. */
export interface SpanHandle {
  spanId: string
  traceId: string
}

const activeSpans = new Map<string, AgentTraceSpan>()
let writer: AgentTraceWriter | null = null
let nowSource: () => number = () => Date.now()

const DEFAULT_STALE_SPAN_MAX_AGE_MS = 30 * 60_000

/** Register the span sink. Called from `lib/logging/bootstrap.ts`. */
export function setAgentTraceWriter(fn: AgentTraceWriter | null): void {
  writer = fn
}

/** Read-only access for tests. */
export function getAgentTraceWriter(): AgentTraceWriter | null {
  return writer
}

function nowMs(): number {
  return nowSource()
}

/**
 * Generate `length` random bytes hex-encoded (lower-case). 16 bytes →
 * 32-char traceId, 8 bytes → 16-char spanId. Falls back to Math.random
 * inside test environments that lack `crypto.getRandomValues` (vanishingly
 * rare — Node 18+ ships Web Crypto by default — but the fallback keeps
 * sync emitters that boot before crypto resolves safe).
 */
export function generateHexId(byteLength: number): string {
  const buf = new Uint8Array(byteLength)
  const cryptoApi = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(buf)
  } else {
    for (let i = 0; i < byteLength; i++) buf[i] = Math.floor(Math.random() * 256)
  }
  let out = ""
  for (let i = 0; i < buf.length; i++) {
    out += buf[i]!.toString(16).padStart(2, "0")
  }
  return out
}

export function generateTraceId(): string {
  return generateHexId(16)
}

export function generateSpanId(): string {
  return generateHexId(8)
}

/**
 * Drop in-progress spans that have exceeded the retention window. This does
 * not emit ended spans: it is a leak guard for work that never reached its
 * terminal callback.
 */
export function reapStaleSpans(maxAgeMs = DEFAULT_STALE_SPAN_MAX_AGE_MS): number {
  const maxAge =
    Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : DEFAULT_STALE_SPAN_MAX_AGE_MS
  const now = nowMs()
  let removed = 0
  for (const [spanId, span] of activeSpans) {
    if (now - span.startTime > maxAge) {
      activeSpans.delete(spanId)
      removed += 1
    }
  }
  return removed
}

/** Begin a new span. The caller is expected to call `endSpan(spanId, ...)`
 * exactly once when the work finishes (success or failure). */
export function startSpan(input: StartSpanInput): SpanHandle {
  reapStaleSpans()
  const traceId = input.traceId ?? generateTraceId()
  const spanId = input.spanId ?? generateSpanId()
  const span: AgentTraceSpan = {
    id: spanId,
    traceId,
    spanId,
    parentSpanId: input.parentSpanId,
    startTime: nowMs(),
    operationName: input.operationName,
    providerName: input.providerName,
    sessionId: input.sessionId,
    surface: input.surface,
    requestModel: input.requestModel,
    agentId: input.agentId,
    agentName: input.agentName,
    toolName: input.toolName,
    pluginId: input.pluginId,
    handoff: input.handoff,
    inputPreview: input.inputPreview,
    metadata: input.metadata,
  }
  activeSpans.set(spanId, span)
  return { spanId, traceId }
}

/** Record a discrete mid-span event. Silently dropped when the span is no
 * longer active (already ended) — keeps async tool-result paths safe. */
export function recordEvent(spanId: string, event: SpanEvent): void {
  const span = activeSpans.get(spanId)
  if (!span) return
  if (!span.events) span.events = []
  span.events.push(event)
}

/** Finish a span. Idempotent on `spanId` — repeated calls are dropped. */
export function endSpan(spanId: string, input: EndSpanInput = {}): AgentTraceSpan | null {
  const span = activeSpans.get(spanId)
  if (!span) return null
  activeSpans.delete(spanId)

  const endTime = input.endTime ?? nowMs()
  span.endTime = endTime
  span.durationMs = Math.max(0, endTime - span.startTime)

  if (input.usage) span.usage = input.usage
  if (typeof input.costUsdEstimate === "number") span.costUsdEstimate = input.costUsdEstimate
  if (input.responseModel) span.responseModel = input.responseModel
  if (input.finishReasons && input.finishReasons.length > 0)
    span.finishReasons = [...input.finishReasons]
  if (input.errorType) span.errorType = input.errorType
  if (input.errorMessage) span.errorMessage = input.errorMessage
  if (input.outputPreview) span.outputPreview = input.outputPreview
  if (input.metadata) span.metadata = { ...(span.metadata ?? {}), ...input.metadata }

  if (writer) {
    try {
      writer(span)
    } catch {
      // Writer must never throw into the emitter — swallow so an unwired
      // transport can't break instrumented call sites.
    }
  }

  return span
}

/**
 * Emit an already-finished span in one shot. Use this when the caller
 * measured the work themselves (e.g. wrapping an existing fire-and-forget
 * handler in `try/finally`) — the emitter's start/end pair would otherwise
 * overwrite the timing with the local clock.
 *
 * Fills in defaults: a random `id`/`spanId` if missing, `endTime` from
 * `startTime + durationMs` if missing, and a generated `traceId` if absent.
 * Silently drops when the span lacks required identity (`sessionId`).
 */
export function emitFinishedSpan(span: Partial<AgentTraceSpan>): AgentTraceSpan | null {
  if (!span.sessionId || !span.operationName || !span.providerName || !span.surface) return null
  const startTime = typeof span.startTime === "number" ? span.startTime : nowMs()
  const spanId = span.spanId ?? span.id ?? generateSpanId()
  const traceId = span.traceId ?? generateTraceId()
  const durationMs = typeof span.durationMs === "number" ? Math.max(0, span.durationMs) : undefined
  const endTime =
    typeof span.endTime === "number"
      ? span.endTime
      : durationMs !== undefined
        ? startTime + durationMs
        : nowMs()
  const finished: AgentTraceSpan = {
    ...span,
    id: spanId,
    spanId,
    traceId,
    startTime,
    endTime,
    durationMs: durationMs ?? Math.max(0, endTime - startTime),
    operationName: span.operationName,
    providerName: span.providerName,
    sessionId: span.sessionId,
    surface: span.surface,
  }
  if (writer) {
    try {
      writer(finished)
    } catch {
      // writer contract
    }
  }
  return finished
}

/** Test-only: drain in-progress spans and reset the writer. */
export function __resetAgentTraceEmitterForTesting(): void {
  activeSpans.clear()
  writer = null
  nowSource = () => Date.now()
}

/** Test-only: peek at an in-progress span without finishing it. */
export function __getActiveSpanForTesting(spanId: string): AgentTraceSpan | undefined {
  return activeSpans.get(spanId)
}

/** Test-only: inject a deterministic clock without global Date monkey-patching. */
export function __setAgentTraceNowForTesting(fn: (() => number) | null): void {
  nowSource = fn ?? (() => Date.now())
}
