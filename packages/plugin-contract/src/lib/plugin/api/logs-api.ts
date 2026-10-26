/**
 * The plugin contract's share of `lib/plugin/api/logs-api.ts`, which re-exports these.
 */
import type { AgentTraceSpan } from "../../../types/agent-trace/span"
import type { AgentTraceStatsSummary } from "../../db/agent-traces"
import type { AgentTraceStatsWindow } from "../../observability/trace-window"
import type { BuildTimelineOptions, TraceTimeline } from "../../observability/trace-timeline"
import type { LogFilter, LogStats, StructuredLogEntry } from "@cognia/logging"
import type { TraceExportFormat, TraceExportOptions } from "../../observability/trace-export"
import type { TraceRollupRow, Waterfall } from "../../observability/trace-rollup"
import type { TransportHealthSnapshot } from "@cognia/logging/types/transport"

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
