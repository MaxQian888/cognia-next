// Fixture builders for observability dashboard stories.
//
// `makeSpan` / `makeWindowSpans` produce realistic `AgentTraceSpan` rows that
// can be `bulkPut` into Dexie (`agentTraces`) for the live dashboard + drawer
// stories, or fed through the same pure series/rollup functions the
// `useObservabilitySeries` hook uses so the props-only panel stories get
// derived data identical to production. All times are relative to an injectable
// `now` so the dashboard's default "1h" relative window captures them.
import {
  costSeries,
  errorRateSeries,
  latencyPercentileSeries,
  requestRateSeries,
  tokenSeries,
  windowKpis,
  type WindowKpis,
} from "@/lib/observability/aggregate-series"
import { breakdownBy, type BreakdownRow, type Dimension } from "@/lib/observability/breakdown"
import {
  buildWaterfall,
  flattenWaterfall,
  rollupTraces,
  type TraceRollupRow,
  type WaterfallNode,
} from "@/lib/observability/trace-rollup"
import { pickBucketMs, resolveRange, type TimeRange } from "@/lib/observability/time-range"
import type { ObservabilitySeries } from "@/hooks/observability/use-observability-series"
import type { AgentTraceSpan, SpanSurface } from "@/types/agent-trace/span"

const MIN = 60_000

const MODELS = [
  "claude-3-5-sonnet-20241022",
  "claude-3-opus-20240229",
  "gpt-4o-2024-08-06",
] as const
const SURFACES: readonly SpanSurface[] = [
  "chat",
  "agent-team",
  "workflow",
  "connector",
  "plugin-hook",
]
const TOOLS = ["read_file", "web_search", "run_command", "edit_file"] as const

let spanSeq = 0

/** A single valid span with realistic defaults; spread `over` to vary fields. */
export function makeSpan(over: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  spanSeq += 1
  const startTime = over.startTime ?? Date.now() - 5 * MIN
  const durationMs = over.durationMs ?? 800
  const id = over.id ?? `span-${spanSeq}`
  return {
    id,
    traceId: over.traceId ?? `trace-${spanSeq}`,
    spanId: over.spanId ?? id,
    startTime,
    endTime: startTime + durationMs,
    durationMs,
    operationName: "chat",
    providerName: "anthropic",
    sessionId: "story-session",
    surface: "chat",
    ...over,
  }
}

/**
 * A connected set of traces (root `invoke_agent` + child `chat` + child
 * `execute_tool`) spread across the last ~48 minutes, with varied models,
 * surfaces, tools, token usage, cost and a couple of error spans. Drives every
 * panel meaningfully.
 */
export function makeWindowSpans(now: number = Date.now()): AgentTraceSpan[] {
  const spans: AgentTraceSpan[] = []
  const TRACES = 8
  for (let i = 0; i < TRACES; i++) {
    const traceId = `trace-${String(i + 1).padStart(2, "0")}`
    const surface = SURFACES[i % SURFACES.length]
    const model = MODELS[i % MODELS.length]
    const traceStart = now - (i + 1) * 6 * MIN
    const rootId = `${traceId}-root`
    const chatId = `${traceId}-chat`
    const toolId = `${traceId}-tool`
    const chatDur = 600 + (i % 4) * 900
    const toolDur = 300 + (i % 3) * 500
    const isErr = i % 5 === 4

    spans.push(
      makeSpan({
        id: rootId,
        spanId: rootId,
        traceId,
        operationName: "invoke_agent",
        providerName: "cognia.team",
        agentName: `agent-${i % 3}`,
        surface,
        startTime: traceStart,
        durationMs: chatDur + toolDur + 200,
      })
    )

    spans.push(
      makeSpan({
        id: chatId,
        spanId: chatId,
        parentSpanId: rootId,
        traceId,
        operationName: "chat",
        providerName: model.startsWith("gpt") ? "openai" : "anthropic",
        requestModel: model,
        responseModel: model,
        surface,
        startTime: traceStart + 100,
        durationMs: chatDur,
        usage: {
          inputTokens: 1200 + i * 250,
          outputTokens: 320 + i * 60,
          cacheReadTokens: i % 2 === 0 ? 800 : 0,
          cacheCreationTokens: i % 3 === 0 ? 200 : 0,
        },
        costUsdEstimate: 0.4 + i * 0.35,
        finishReasons: ["stop"],
      })
    )

    spans.push(
      makeSpan({
        id: toolId,
        spanId: toolId,
        parentSpanId: rootId,
        traceId,
        operationName: "execute_tool",
        providerName: "cognia.plugin",
        toolName: TOOLS[i % TOOLS.length],
        surface,
        startTime: traceStart + 100 + chatDur,
        durationMs: toolDur,
        ...(isErr ? { errorType: "ToolError", errorMessage: "Sandbox timed out after 30s" } : {}),
        events: [
          { name: "tool.start", at: traceStart + 100 + chatDur + 10 },
          { name: "tool.finish", at: traceStart + 100 + chatDur + toolDur - 10 },
        ],
      })
    )
  }
  return spans
}

/** Default 1-hour relative range ending at `now`. */
export function makeRange(now: number = Date.now()): TimeRange {
  return resolveRange("1h", now)
}

/**
 * Build the full derived `ObservabilitySeries` from spans — mirrors the body of
 * `useObservabilitySeries` so the props-only panel stories get production-shaped
 * data without mounting the hook.
 */
export function buildSeries(
  spans: AgentTraceSpan[],
  range: TimeRange = makeRange()
): ObservabilitySeries {
  const bucketMs = pickBucketMs(range)
  return {
    bucketMs,
    cost: costSeries(spans, range, bucketMs),
    tokens: tokenSeries(spans, range, bucketMs),
    requestRate: requestRateSeries(spans, range, bucketMs),
    errorRate: errorRateSeries(spans, range, bucketMs),
    latency: latencyPercentileSeries(spans, range, bucketMs),
    breakdownModel: breakdownBy(spans, "model"),
    breakdownSurface: breakdownBy(spans, "surface"),
    breakdownOperation: breakdownBy(spans, "operation"),
    breakdownTool: breakdownBy(spans, "tool"),
    breakdownProvider: breakdownBy(spans, "provider"),
    breakdownProject: breakdownBy(spans, "project"),
    kpis: windowKpis(spans, range),
  }
}

/** Populated series derived from `makeWindowSpans`. */
export function makeSeries(now: number = Date.now()): ObservabilitySeries {
  const range = makeRange(now)
  return buildSeries(makeWindowSpans(now), range)
}

/** Empty series (every panel renders its no-data branch). */
export function emptySeries(now: number = Date.now()): ObservabilitySeries {
  return buildSeries([], makeRange(now))
}

/** Window KPIs over the populated span set. */
export function makeKpis(now: number = Date.now()): WindowKpis {
  return windowKpis(makeWindowSpans(now), makeRange(now))
}

/** Breakdown rows for a dimension over the populated span set. */
export function makeBreakdownRows(dim: Dimension, now: number = Date.now()): BreakdownRow[] {
  return breakdownBy(makeWindowSpans(now), dim)
}

/** Recent-traces rollup rows over the populated span set. */
export function makeTraceRows(now: number = Date.now()): TraceRollupRow[] {
  return rollupTraces(makeWindowSpans(now))
}

/** Flattened waterfall nodes for one trace (`traceId`), pre-order. */
export function makeWaterfallNodes(
  traceId = "trace-05",
  now: number = Date.now()
): WaterfallNode[] {
  const traceSpans = makeWindowSpans(now).filter((s) => s.traceId === traceId)
  return flattenWaterfall(buildWaterfall(traceSpans))
}
