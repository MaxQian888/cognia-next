import {
  evidenceText,
  isSensitiveFieldName,
  redactSensitiveText,
  redactSensitiveValue,
  type SreEvidence,
  type SreLogEvidence,
  type SreMetricEvidence,
  type SreTimeRange,
  type SreTimelineDraft,
  type SreTraceSpanEvidence,
  type SreValidationResult,
} from "./evidence"
import { validateTimelineDraft } from "./validator"
import { createFixtureProvider } from "./providers/fixture-provider"
import type {
  SreFacet,
  SreHistogramBucket,
  SreIngestSource,
  SreLogFilter,
  SreLogPattern,
  SreLogProvider,
  SreMetricFilter,
  SreProviderKind,
  SreTraceFilter,
} from "./providers/types"

/**
 * Public aliases for the tool-facing input names.
 *
 * The shapes moved to `providers/types.ts` when the backend seam was cut; these
 * names are what `tools.ts` and the plugin's tests have always imported, and
 * renaming them would have been churn with no reader benefit.
 */
export type SreQueryLogsInput = SreLogFilter
export type SreQueryTraceInput = SreTraceFilter
export type SreQueryMetricsInput = SreMetricFilter

/**
 * Where a result's records came from. `"demo-corpus"` is the bundled recording
 * (`SreProviderKind` `"fixture"`) — never the user's systems — and is stamped
 * on every result so neither the agent nor a reader of the tool output can
 * mistake it for live evidence.
 */
export type SreDataSource = "demo-corpus" | "live"

/** What the agent reads next to demo records. English: it is model-facing. */
export const DEMO_CORPUS_NOTICE =
  "DEMO CORPUS: these records come from a bundled recording of one 2026-08 Qwen timeout incident, not from the user's systems. Say so in your answer."

export interface SreQueryResult<T extends SreEvidence> {
  ok: true
  records: T[]
  evidenceIds: string[]
  /** Id of the backend that answered, whatever kind it is. */
  provider: string
  dataSource: SreDataSource
  /** Present exactly when `dataSource` is `"demo-corpus"`. */
  notice?: string
  /**
   * The fixture corpus behind the answer — present only when a fixture actually
   * answered. A remote provider leaves it off rather than naming a corpus that
   * is not there, which the old unconditional `fixture` field could not express.
   */
  fixture?: string
}

export interface SreProviderInfo {
  id: string
  kind: SreProviderKind
  /** True for the bundled demo corpus — the panel labels itself from this. */
  demo: boolean
  coverage: SreTimeRange | null
}

export interface SreRuntime {
  provider(): SreProviderInfo
  queryLogs(input: SreQueryLogsInput): Promise<SreQueryResult<SreLogEvidence>>
  queryTrace(input: SreQueryTraceInput): Promise<SreQueryResult<SreTraceSpanEvidence>>
  queryMetrics(input: SreQueryMetricsInput): Promise<SreQueryResult<SreMetricEvidence>>
  histogram(input: SreQueryLogsInput, bucketCount: number): Promise<SreHistogramBucket[]>
  patterns(input: SreQueryLogsInput, baseline?: SreTimeRange): Promise<SreLogPattern[]>
  facets(input: SreQueryLogsInput, fields: readonly string[], limit?: number): Promise<SreFacet[]>
  sources(): Promise<SreIngestSource[]>
  validateTimeline(input: SreTimelineDraft): Promise<SreValidationResult>
  resolveEvidenceIds(ids: readonly string[]): string[]
  evidenceSnapshot(): SreEvidence[]
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function assertRange(startTime: string, endTime: string): void {
  const start = Date.parse(startTime)
  const end = Date.parse(endTime)
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("startTime and endTime must be valid ISO timestamps")
  }
  if (start > end) throw new Error("startTime must be before endTime")
}

/** Validate a window that either is fully absent or fully present. */
function optionalRange(
  startTime: string | undefined,
  endTime: string | undefined
): SreTimeRange | undefined {
  if (startTime === undefined && endTime === undefined) return undefined
  const range = {
    startTime: requireNonEmpty(startTime, "startTime"),
    endTime: requireNonEmpty(endTime, "endTime"),
  }
  assertRange(range.startTime, range.endTime)
  return range
}

/** Validate the window every log/metric query must carry. Returns the trimmed pair. */
function assertWindow(input: { environment: string; startTime: string; endTime: string }): void {
  requireNonEmpty(input.environment, "environment")
  requireNonEmpty(input.startTime, "startTime")
  requireNonEmpty(input.endTime, "endTime")
  assertRange(input.startTime, input.endTime)
}

/**
 * The default window to investigate.
 *
 * A bounded backend (the fixture) names its own coverage — opening the panel on
 * "now minus an hour" against a corpus recorded in 2026-08 would render an
 * empty investigation and look broken. An unbounded backend gets the last hour.
 */
export function defaultIncidentWindow(
  provider: Pick<SreLogProvider, "coverage"> = createFixtureProvider()
): SreTimeRange {
  const coverage = provider.coverage()
  if (coverage) return coverage
  const end = new Date()
  return {
    startTime: new Date(end.getTime() - 60 * 60 * 1000).toISOString(),
    endTime: end.toISOString(),
  }
}

/**
 * Create an isolated, read-only evidence runtime for one plugin activation.
 *
 * The runtime owns everything that must not vary by backend: input validation
 * (its error strings are the tool contract), PII redaction on the way out, the
 * evidence pool the timeline validator resolves ids against, and the
 * sensitive-field gate on aggregates. The provider owns only "where records
 * come from".
 */
export function createSreRuntime(provider: SreLogProvider = createFixtureProvider()): SreRuntime {
  const evidencePool = new Map<string, SreEvidence>()
  const demo = provider.kind === "fixture"
  const remember = <T extends SreEvidence>(records: T[]): SreQueryResult<T> => {
    const redacted = records.map((record) => redactSensitiveValue(record) as T)
    for (const record of redacted) evidencePool.set(record.id, record)
    return {
      ok: true,
      records: redacted,
      evidenceIds: redacted.map((record) => record.id),
      provider: provider.id,
      dataSource: demo ? "demo-corpus" : "live",
      ...(demo ? { fixture: provider.id, notice: DEMO_CORPUS_NOTICE } : {}),
    }
  }

  /** Aggregate reads validate the same way queries do, minus the pool write. */
  const readFilter = (input: SreQueryLogsInput): SreLogFilter => {
    assertWindow(input)
    return input
  }

  return {
    provider: () => ({
      id: provider.id,
      kind: provider.kind,
      demo,
      coverage: provider.coverage(),
    }),

    queryLogs: async (input) => {
      assertWindow(input)
      return remember(await provider.fetchLogs(input))
    },

    queryTrace: async (input) => {
      requireNonEmpty(input.environment, "environment")
      const traceId = input.traceId?.trim()
      const requestId = input.requestId?.trim()
      if (!traceId && !requestId) throw new Error("traceId or requestId is required")
      const range = optionalRange(input.startTime, input.endTime)
      return remember(
        await provider.fetchTrace({
          environment: input.environment,
          traceId,
          requestId,
          startTime: range?.startTime,
          endTime: range?.endTime,
        })
      )
    },

    queryMetrics: async (input) => {
      assertWindow(input)
      return remember(await provider.fetchMetrics(input))
    },

    histogram: async (input, bucketCount) => provider.histogram(readFilter(input), bucketCount),

    patterns: async (input, baseline) => {
      const filter = readFilter(input)
      if (baseline) assertRange(baseline.startTime, baseline.endTime)
      const patterns = await provider.patterns(filter, baseline)
      // A template is built from raw record text, so it can carry an unmasked
      // value the record-level redaction would have caught. Same exit rule.
      return patterns.map((pattern) => ({
        ...pattern,
        template: redactSensitiveText(pattern.template),
      }))
    },

    facets: async (input, fields, limit = 8) => {
      const filter = readFilter(input)
      const safeFields = fields.filter((field) => !isSensitiveFieldName(field))
      if (safeFields.length === 0) return []
      const facets = await provider.facets(filter, safeFields, limit)
      return facets.map((facet) => ({
        ...facet,
        values: facet.values.map((entry) => ({
          ...entry,
          value: redactSensitiveText(entry.value),
        })),
      }))
    },

    sources: async () => {
      const sources = await provider.sources()
      return sources.map((source) => ({
        ...source,
        label: redactSensitiveText(source.label),
        pipeline: redactSensitiveText(source.pipeline),
      }))
    },

    validateTimeline: async (input) => validateTimelineDraft(input, evidencePool.values()),

    resolveEvidenceIds: (ids) => ids.filter((id) => evidencePool.has(id)),

    evidenceSnapshot: () =>
      redactSensitiveValue([
        ...evidencePool.values(),
        ...provider.ambientEvidence(),
      ]) as SreEvidence[],
  }
}

/** Re-exported so callers keep one import for the evidence-serialisation helper. */
export { evidenceText }
