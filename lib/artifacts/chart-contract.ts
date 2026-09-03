/**
 * What a chart payload actually means.
 *
 * ADR-0139 wrote the chart contract down for the model (`chart-design`) but
 * left the renderer silent about violations: the series list came from
 * `data[0]` alone, an unknown `type` fell through to a line chart, and
 * pie/doughnut keyed slices off a literal `"value"` no matter what the rows
 * were called. Each of those failed without saying anything, so a model, an
 * imported artifact, and a user hand-editing JSON all produced the same
 * symptom: a wrong or blank chart with no explanation.
 *
 * This module is the single answer to "what does this payload mean?". It
 * parses, resolves the shape, decides which keys are drawable, and reports
 * every rule the payload broke as a structured finding. It is pure and free
 * of React so the renderer, the artifact detector, and (later) the Canvas
 * preview can all ask the same question and get the same answer.
 *
 * Findings carry a CODE and ICU params, never a sentence: the copy lives in
 * `artifactPreview.chartFindings.*` because a pure function cannot translate.
 */

import type { ArtifactChartType, ChartDataPoint } from "@/types"

/** The seven shapes `components/artifacts/chart-renderer.tsx` can draw. */
export const CHART_TYPES: readonly ArtifactChartType[] = [
  "line",
  "bar",
  "pie",
  "doughnut",
  "area",
  "scatter",
  "radar",
] as const

/** Shapes that slice one series rather than plotting many. */
const SINGLE_SERIES_TYPES: readonly ArtifactChartType[] = ["pie", "doughnut"] as const

export type ChartFindingCode =
  /** `content` was not JSON at all. */
  | "invalidJson"
  /** Valid JSON, but not an array and not `{ data: [...] }`. */
  | "unsupportedShape"
  /** `type` was present but not one of the seven, so the fallback was drawn. */
  | "unknownType"
  /** A numeric key that appears only after row 0, so it is never drawn. */
  | "lateSeries"
  /** Rows whose `name` is missing or not a non-empty string. */
  | "missingName"
  /** Rows where a drawn series holds something other than a finite number. */
  | "nonNumericValue"
  /** Scatter rows without finite `x` and `y`. */
  | "scatterMissingXY"
  /** pie/doughnut draws one series, so these were not drawn. */
  | "extraSeriesDropped"
  /** Nothing numeric to plot. */
  | "noNumericSeries"

export interface ChartFinding {
  code: ChartFindingCode
  /** `fatal` replaces the chart. `degraded` annotates it and still draws. */
  severity: "fatal" | "degraded"
  /** ICU params for `artifactPreview.chartFindings.<code>`. Never a sentence. */
  params?: Record<string, string | number>
}

export interface ChartContract {
  data: ChartDataPoint[]
  /** Always one of `CHART_TYPES`. */
  chartType: ArtifactChartType
  /**
   * Where `chartType` came from. The artifact detector only stamps
   * `metadata.chartType` when this is not `"fallback"`, so an ambiguous
   * payload stays unpinned rather than being frozen as a line chart.
   */
  resolvedFrom: "declared" | "inferred" | "fallback"
  /** Series to draw, in `data[0]` key order. Empty for scatter. */
  series: string[]
  /** The key pie/doughnut slices by, or `null` when nothing is drawable. */
  valueKey: string | null
  /** `false` means render the empty state. The findings still apply. */
  drawable: boolean
  findings: ChartFinding[]
}

export interface ParseChartPayloadOptions {
  /** Shape to assume when the payload does not declare one. */
  fallbackType?: ArtifactChartType
  /** Pre-parsed rows, which win over `content` (the renderer's prop path). */
  chartData?: ChartDataPoint[]
}

/** Findings render in this order, so the notice is stable across renders. */
const FINDING_ORDER: readonly ChartFindingCode[] = [
  "invalidJson",
  "unsupportedShape",
  "noNumericSeries",
  "unknownType",
  "lateSeries",
  "extraSeriesDropped",
  "scatterMissingXY",
  "missingName",
  "nonNumericValue",
] as const

function isChartType(value: unknown): value is ArtifactChartType {
  return typeof value === "string" && (CHART_TYPES as readonly string[]).includes(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isRow(value: unknown): value is ChartDataPoint {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A payload with no `type` is scatter when every row carries finite `x`/`y`
 * and none carries a `name`. Requiring the absence of `name` keeps a
 * `{ name, x, y }` row (a cartesian series that happens to use those keys)
 * out of the scatter branch, where its `name` would be dropped silently.
 */
function looksLikeScatter(rows: ChartDataPoint[]): boolean {
  if (rows.length === 0) return false
  return rows.every(
    (row) => isFiniteNumber(row.x) && isFiniteNumber(row.y) && row.name === undefined
  )
}

function fatal(code: Extract<ChartFindingCode, "invalidJson" | "unsupportedShape">): ChartContract {
  return {
    data: [],
    chartType: "line",
    resolvedFrom: "fallback",
    series: [],
    valueKey: null,
    drawable: false,
    findings: [{ code, severity: "fatal" }],
  }
}

/**
 * Read a chart payload the way the renderer will draw it, plus every rule the
 * payload broke on the way.
 */
export function parseChartPayload(
  content: string,
  options: ParseChartPayloadOptions = {}
): ChartContract {
  const { fallbackType, chartData } = options

  let declaredType: unknown
  let rawRows: unknown

  if (chartData) {
    rawRows = chartData
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return fatal("invalidJson")
    }
    if (Array.isArray(parsed)) {
      rawRows = parsed
    } else if (isRow(parsed) && Array.isArray((parsed as { data?: unknown }).data)) {
      rawRows = (parsed as { data: unknown }).data
      declaredType = (parsed as { type?: unknown }).type
    } else {
      return fatal("unsupportedShape")
    }
  }

  const data = (rawRows as unknown[]).filter(isRow)
  const findings: ChartFinding[] = []
  const push = (code: ChartFindingCode, params?: Record<string, string | number>) =>
    findings.push({ code, severity: "degraded", ...(params ? { params } : {}) })

  // --- shape --------------------------------------------------------------
  let chartType: ArtifactChartType
  let resolvedFrom: ChartContract["resolvedFrom"]

  if (isChartType(declaredType)) {
    chartType = declaredType
    resolvedFrom = "declared"
  } else if (typeof declaredType === "string" && declaredType.length > 0) {
    // Named a shape we do not draw. Say so, because this used to fall through
    // to a line chart with no signal at all.
    chartType = fallbackType ?? "line"
    resolvedFrom = "fallback"
    push("unknownType", { type: declaredType })
  } else if (fallbackType) {
    chartType = fallbackType
    resolvedFrom = "declared"
  } else if (looksLikeScatter(data)) {
    chartType = "scatter"
    resolvedFrom = "inferred"
  } else {
    chartType = "line"
    resolvedFrom = "fallback"
  }

  // --- scatter has its own row contract -----------------------------------
  if (chartType === "scatter") {
    const missing = data.filter((row) => !isFiniteNumber(row.x) || !isFiniteNumber(row.y)).length
    if (missing > 0) push("scatterMissingXY", { count: missing })
    const drawable = data.length > missing
    if (!drawable && data.length > 0) push("noNumericSeries")
    return {
      data,
      chartType,
      resolvedFrom,
      series: [],
      valueKey: null,
      drawable,
      findings: sortFindings(findings),
    }
  }

  // --- series -------------------------------------------------------------
  // Deliberately `data[0]` only. Widening to the all-rows union would change
  // how existing charts look, and would falsify `chart-design`'s "read from
  // the first row only", which `lib/skills/built-in-catalog.test.ts` pins
  // verbatim. The union is computed anyway, purely to report the difference.
  const firstRow = data[0] ?? {}
  const series = Object.keys(firstRow).filter(
    (key) => key !== "name" && isFiniteNumber(firstRow[key])
  )

  const union = new Set<string>()
  for (const row of data) {
    for (const key of Object.keys(row)) {
      if (key !== "name" && isFiniteNumber(row[key])) union.add(key)
    }
  }
  for (const key of union) {
    if (!series.includes(key)) push("lateSeries", { series: key })
  }

  if (series.length === 0) {
    if (data.length > 0) push("noNumericSeries")
    return {
      data,
      chartType,
      resolvedFrom,
      series,
      valueKey: null,
      drawable: false,
      findings: sortFindings(findings),
    }
  }

  // --- the slice key, and the back-compat rule that protects existing charts
  // `dataKey="value"` was hardcoded for a long time. Preferring a literal
  // `value` when one exists keeps every `{name, value}` and `{name, errors,
  // value}` artifact rendering exactly as it did. Falling back to `series[0]`
  // is what fixes `{name, share}`, which used to draw nothing at all.
  const valueKey = series.includes("value") ? "value" : series[0]

  if (SINGLE_SERIES_TYPES.includes(chartType) && series.length > 1) {
    push("extraSeriesDropped", {
      series: series.filter((key) => key !== valueKey).join(", "),
      count: series.length - 1,
    })
  }

  // --- per-row rules ------------------------------------------------------
  const unnamed = data.filter((row) => typeof row.name !== "string" || row.name.length === 0).length
  if (unnamed > 0) push("missingName", { count: unnamed })

  const drawnSeries = SINGLE_SERIES_TYPES.includes(chartType) ? [valueKey] : series
  for (const key of drawnSeries) {
    const bad = data.filter((row) => key in row && !isFiniteNumber(row[key])).length
    if (bad > 0) push("nonNumericValue", { series: key, count: bad })
  }

  return {
    data,
    chartType,
    resolvedFrom,
    series,
    valueKey,
    drawable: true,
    findings: sortFindings(findings),
  }
}

/** Stable order, and no duplicate (code, params) pair. */
function sortFindings(findings: ChartFinding[]): ChartFinding[] {
  const seen = new Set<string>()
  const unique = findings.filter((finding) => {
    const key = `${finding.code}:${JSON.stringify(finding.params ?? {})}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique.sort((a, b) => FINDING_ORDER.indexOf(a.code) - FINDING_ORDER.indexOf(b.code))
}
