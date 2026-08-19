/**
 * Plugin Logs & Agent-Trace API (`ctx.logs`) — the **read** side of
 * observability for monitoring, debugging, and cost-tracking plugins.
 *
 * Plugins have always been able to *write* logs (`ctx.logger`, a scoped
 * `@cognia/logging` logger). They had no way to read anything back: a plugin
 * that wanted to surface "your last run cost $2.10 and failed on the third
 * tool call" had to re-instrument the world, because the spans the app already
 * persists were host-private. This closes that gap.
 *
 * Two permissions, because the two halves carry different data:
 *
 *  - `logs:read` — the structured log stream, its stats, registered modules,
 *    and transport health. Operational metadata.
 *  - `trace:read` — agent-trace spans. Same rows the `/logs` Traces channel
 *    reads, and they may carry `inputPreview` / `outputPreview` — model input
 *    and output, captured only when the user enabled content capture and only
 *    after the redaction gate passed. Gating this separately means a cost
 *    dashboard can ask for spans without also getting the log firehose, and a
 *    log viewer never silently gains access to prompt text.
 *
 * Deliberately read-only. `clear()` / `deleteEntries()` exist on the transport
 * and are NOT exposed: a plugin must not be able to destroy the user's audit
 * trail. Emission stays on `ctx.logger`, which is already scoped to the plugin
 * so its output is attributable.
 */

import { liveQuery, type Subscription } from "dexie"

import {
  IndexedDBTransport,
  getRegisteredModules,
  getTransportHealthSnapshot,
} from "@cognia/logging"
import type { LogFilter, LogStats, StructuredLogEntry } from "@cognia/logging"
import type { TransportHealthSnapshot } from "@cognia/logging/types/transport"

import {
  aggregateStatsAll,
  queryByTrace,
  queryByWindow,
  queryBySession,
  queryRecent,
  type AgentTraceStatsSummary,
} from "@/lib/db/agent-traces"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import {
  rollupTraces,
  buildWaterfall,
  type TraceRollupRow,
  type Waterfall,
} from "@/lib/observability/trace-rollup"
import {
  serializeTrace,
  type TraceExportFormat,
  type TraceExportOptions,
} from "@/lib/observability/trace-export"
import {
  buildTraceTimeline,
  type BuildTimelineOptions,
  type TraceTimeline,
} from "@/lib/observability/trace-timeline"
import {
  agentTraceWindowSinceOrZero,
  type AgentTraceStatsWindow,
} from "@/lib/observability/trace-window"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

/** How many spans a live trace subscription looks back over per tick. */
const TRACE_SUBSCRIPTION_WINDOW = 200
/** Hard ceiling on any single read, so a plugin cannot pull the whole store. */
const MAX_QUERY_LIMIT = 5_000

export interface PluginTraceListOptions {
  /** Retention window. Defaults to `today`. */
  window?: AgentTraceStatsWindow
  /** Maximum traces returned, newest-first. Defaults to 50, capped at 500. */
  limit?: number
  /** Keep only traces with at least one failed span. */
  errorsOnly?: boolean
}

export interface PluginTraceStatsOptions {
  window?: AgentTraceStatsWindow
}

/**
 * Agent-trace reads (`ctx.logs.traces`). Every method is gated `trace:read`.
 */
export interface PluginTraceAPI {
  /** One row per trace in the window, newest-first. */
  list(options?: PluginTraceListOptions): Promise<TraceRollupRow[]>
  /** Every span of one trace, chronological. */
  spans(traceId: string): Promise<AgentTraceSpan[]>
  /** Spans for one session, newest-first. */
  bySession(sessionId: string, limit?: number): Promise<AgentTraceSpan[]>
  /** The parent/child waterfall tree with offset/width geometry. */
  waterfall(traceId: string): Promise<Waterfall>
  /** The lane projection behind the `/logs` timeline strip. */
  timeline(traceId: string, options?: BuildTimelineOptions): Promise<TraceTimeline>
  /** Cost / token / cache / error aggregates over a window. */
  stats(options?: PluginTraceStatsOptions): Promise<AgentTraceStatsSummary>
  /**
   * Serialize one trace as raw span JSON or OTLP/HTTP JSON — the same bytes
   * the `otlp-http` transport streams, so a plugin can forward a trace to an
   * external backend without reimplementing the conversion. Pass
   * `{ redactPreviews: true }` to drop model input/output previews.
   */
  serialize(
    traceId: string,
    format?: TraceExportFormat,
    options?: TraceExportOptions
  ): Promise<string>
  /**
   * Fire for each batch of spans that lands after subscribing. Only spans the
   * handler has not already seen are delivered; the first tick is skipped so a
   * subscriber does not immediately receive history it did not ask for.
   * Returns a disposer.
   */
  subscribe(handler: (spans: AgentTraceSpan[]) => void): () => void
}

export interface PluginLogsAPI {
  /** Query the persisted structured log stream. Newest-first. */
  query(filter?: LogFilter): Promise<StructuredLogEntry[]>
  /** Totals by level and module across the whole store. */
  stats(): Promise<LogStats>
  /** Module names that have registered a logger this session. */
  modules(): string[]
  /** Serialize the (optionally filtered) stream as JSON. */
  export(filter?: LogFilter): Promise<string>
  /**
   * Fire when a batch of log entries is flushed to storage, with the entries
   * written. Returns a disposer.
   */
  subscribe(handler: (entries: StructuredLogEntry[]) => void): () => void
  /** Per-transport health snapshots (queue depth, retries, drops, last error). */
  transports(): Record<string, TransportHealthSnapshot>
  /** Agent-trace reads. Gated separately — see the module docstring. */
  traces: PluginTraceAPI
}

function clampLimit(value: number | undefined, fallback: number, ceiling: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), ceiling)
}

/** Shared read-only transport instance. Constructing one opens the same
 * IndexedDB database the app's own logging already uses; it is not a second
 * writer (the plugin API never calls `log()` or `flush()`). */
let sharedTransport: IndexedDBTransport | null = null
function transport(): IndexedDBTransport {
  sharedTransport ??= new IndexedDBTransport()
  return sharedTransport
}

/** Reset the shared reader. Exported for tests; production never needs it. */
export function resetPluginLogsTransport(): void {
  sharedTransport = null
}

function createTraceAPI(pluginId: string): PluginTraceAPI {
  const api: PluginTraceAPI = {
    async list(options = {}) {
      const since = agentTraceWindowSinceOrZero(options.window ?? "today")
      const limit = clampLimit(options.limit, 50, 500)
      const spans = await queryByWindow({ since })
      const rows = rollupTraces(spans)
      const filtered = options.errorsOnly ? rows.filter((row) => row.errorCount > 0) : rows
      return filtered.slice(0, limit)
    },

    spans: (traceId) => queryByTrace(traceId),

    bySession: (sessionId, limit) =>
      queryBySession(sessionId, clampLimit(limit, 500, MAX_QUERY_LIMIT)),

    async waterfall(traceId) {
      return buildWaterfall(await queryByTrace(traceId))
    },

    async timeline(traceId, options) {
      return buildTraceTimeline(await queryByTrace(traceId), options)
    },

    stats(options = {}) {
      const since = agentTraceWindowSinceOrZero(options.window ?? "today")
      return aggregateStatsAll(since > 0 ? { since } : undefined)
    },

    async serialize(traceId, format = "json", options) {
      return serializeTrace(await queryByTrace(traceId), format, options)
    },

    subscribe(handler) {
      const seen = new Set<string>()
      let primed = false
      let subscription: Subscription | null = null
      try {
        subscription = liveQuery(() => queryRecent(TRACE_SUBSCRIPTION_WINDOW)).subscribe({
          next: (spans: AgentTraceSpan[]) => {
            // The first emission is the existing tail, not news. Record it and
            // stay quiet, so `subscribe` means "from now on".
            if (!primed) {
              primed = true
              for (const span of spans) seen.add(span.id)
              return
            }
            const fresh = spans.filter((span) => !seen.has(span.id))
            if (fresh.length === 0) return
            for (const span of fresh) seen.add(span.id)
            // Bound the dedupe set so a long-lived subscription cannot grow
            // without limit.
            if (seen.size > TRACE_SUBSCRIPTION_WINDOW * 10) {
              const keep = spans.map((span) => span.id)
              seen.clear()
              for (const id of keep) seen.add(id)
            }
            handler(fresh)
          },
          error: () => {
            // A failed live query must not take the plugin down with it.
          },
        })
      } catch {
        return () => {}
      }
      return () => subscription?.unsubscribe()
    },
  }

  return createGuardedAPI(pluginId, api, {
    list: "trace:read",
    spans: "trace:read",
    bySession: "trace:read",
    waterfall: "trace:read",
    timeline: "trace:read",
    stats: "trace:read",
    serialize: "trace:read",
    subscribe: "trace:read",
  })
}

/** Create the read-only Logs API for a plugin (`logs:read` + `trace:read`). */
export function createLogsAPI(pluginId: string): PluginLogsAPI {
  const traces = createTraceAPI(pluginId)

  const api = {
    query: (filter?: LogFilter) =>
      transport().getLogs({
        ...filter,
        limit: clampLimit(filter?.limit, 500, MAX_QUERY_LIMIT),
      }),
    stats: () => transport().getStats(),
    modules: () => getRegisteredModules(),
    export: (filter?: LogFilter) => transport().export(filter),
    subscribe(handler: (entries: StructuredLogEntry[]) => void) {
      // The transport broadcasts a flush count, not the entries; re-read the
      // tail and hand over only what the subscriber has not seen.
      const seen = new Set<string>()
      let primed = false
      return IndexedDBTransport.onLogsUpdated((count) => {
        void transport()
          .getLogs({ limit: clampLimit(count, 50, 500) })
          .then((entries) => {
            if (!primed) {
              primed = true
              for (const entry of entries) seen.add(entry.id)
              return
            }
            const fresh = entries.filter((entry) => !seen.has(entry.id))
            if (fresh.length === 0) return
            for (const entry of fresh) seen.add(entry.id)
            if (seen.size > 5_000) {
              seen.clear()
              for (const entry of entries) seen.add(entry.id)
            }
            handler(fresh)
          })
          .catch(() => {
            // A read failure between flushes is not the plugin's problem.
          })
      })
    },
    transports: () => getTransportHealthSnapshot(),
  }

  const guarded = createGuardedAPI(pluginId, api, {
    query: "logs:read",
    stats: "logs:read",
    modules: "logs:read",
    export: "logs:read",
    subscribe: "logs:read",
    transports: "logs:read",
  })

  // `traces` is a nested object, not a method, so it rides alongside the
  // guarded surface with its own per-method gate already applied.
  return { ...guarded, traces }
}

export default createLogsAPI
