/**
 * The seam between "which observability backend answers" and everything the
 * SRE plugin does with the answer.
 *
 * The plugin shipped with its query logic welded to the bundled fixtures, so
 * every consumer — the four agent tools, and now the incident panel — could
 * only ever see `qwen-timeout-fallback`. This interface is that weld cut open.
 * `runtime.ts` keeps what must not vary by backend (input validation, PII
 * redaction, the evidence pool, timeline validation); a provider supplies
 * records and aggregates.
 *
 * The analysis half (`histogram` / `patterns` / `facets`) sits on the provider
 * rather than being derived in the runtime on purpose: a real log backend
 * answers those with an aggregation it can push down, and re-deriving them
 * from a fetched page would silently cap every count at that page's size.
 */

import type {
  SreEvidence,
  SreLogEvidence,
  SreMetricEvidence,
  SreTimeRange,
  SreTraceSpanEvidence,
} from "../evidence"

export type SreLogLevel = NonNullable<SreLogEvidence["level"]>

/** What kind of backend is answering — surfaced to the user, never branched on. */
export type SreProviderKind = "fixture" | "remote"

export interface SreLogFilter extends SreTimeRange {
  environment: string
  services?: string[]
  traceId?: string
  requestId?: string
  keywords?: string[]
  /**
   * Level allow-list. Not reachable from `sre_query_logs` (its manifest schema
   * has no such property and is `additionalProperties: false`) — the panel is
   * the only caller, which is why it lives on the filter and not on the tool.
   */
  levels?: SreLogLevel[]
  /**
   * Fetch exactly these evidence ids (still inside the window and the rest of
   * the filter).
   *
   * This is what turns a pattern row into pinned evidence: aggregates carry ids
   * but not records, and the timeline validator only accepts ids that are
   * actually IN the evidence pool. Without an id filter the panel would have to
   * re-fetch the whole window to pin five lines, inflating `evidenceCount` with
   * records nobody cited.
   */
  ids?: string[]
}

export interface SreTraceFilter {
  environment: string
  traceId?: string
  requestId?: string
  startTime?: string
  endTime?: string
}

export interface SreMetricFilter extends SreTimeRange {
  environment: string
  jobs?: string[]
  metrics?: string[]
  labels?: Record<string, string>
}

export interface SreHistogramBucket {
  startTime: string
  endTime: string
  total: number
  byLevel: Record<SreLogLevel, number>
}

export interface SreLogPattern {
  /** Hash of the template text — stable across re-queries, so selection survives. */
  id: string
  template: string
  count: number
  /**
   * Occurrences in the baseline window the caller named, or `null` when no
   * baseline was requested. `0` and `null` mean different things and the UI has
   * to tell them apart: `0` is "this template is new", `null` is "nobody looked".
   */
  baselineCount: number | null
  /** `(count - baseline) / baseline`, or `null` when the baseline is 0 or absent. */
  changeRatio: number | null
  services: string[]
  levels: SreLogLevel[]
  firstSeen: string
  lastSeen: string
  evidenceIds: string[]
}

export interface SreFacetValue {
  value: string
  count: number
}

export interface SreFacet {
  field: string
  /** Records carrying any value for this field — the denominator for each bar. */
  total: number
  values: SreFacetValue[]
}

/**
 * Health of one ingestion leg.
 *
 * `static` is not a degraded `healthy`: it is the honest answer for a backend
 * with no pipeline at all (the bundled fixtures), where a lag number would be
 * fabricated. The panel renders it as its own state rather than a green dot.
 */
export type SreIngestStatus = "healthy" | "lagging" | "stalled" | "static"

export interface SreIngestSource {
  id: string
  label: string
  /** How records reach the backend — "bundled fixture", "filebeat to kafka", … */
  pipeline: string
  status: SreIngestStatus
  /** Ingestion lag in ms, or `null` when the source has no live pipeline. */
  lagMs: number | null
  /** Records currently retained, or `null` when the backend does not report it. */
  recordCount: number | null
  /** Bytes ingested over the last 24h, or `null` when unreported. */
  bytes24h: number | null
}

/** Fields the panel offers as facets by default. Sensitive names are rejected upstream. */
export const SRE_FACET_FIELDS: readonly string[] = [
  "service",
  "level",
  "event",
  "provider",
  "model",
  "error_class",
]

export interface SreLogProvider {
  readonly id: string
  readonly kind: SreProviderKind
  /**
   * The absolute window this backend can answer for, or `null` when unbounded.
   * The fixture provider is bounded, and the panel needs to say so rather than
   * render an empty result for 14:00 as if nothing had happened then.
   */
  coverage(): SreTimeRange | null
  fetchLogs(filter: SreLogFilter): Promise<SreLogEvidence[]>
  fetchTrace(filter: SreTraceFilter): Promise<SreTraceSpanEvidence[]>
  fetchMetrics(filter: SreMetricFilter): Promise<SreMetricEvidence[]>
  /** Evidence in scope regardless of window — runbooks today. */
  ambientEvidence(): SreEvidence[]
  histogram(filter: SreLogFilter, bucketCount: number): Promise<SreHistogramBucket[]>
  patterns(filter: SreLogFilter, baseline?: SreTimeRange): Promise<SreLogPattern[]>
  facets(filter: SreLogFilter, fields: readonly string[], limit: number): Promise<SreFacet[]>
  sources(): Promise<SreIngestSource[]>
}
