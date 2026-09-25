export const VISUALIZATION_SCHEMA_VERSION = 1 as const
export const VISUALIZATION_ARTIFACT_KIND = "cognia-visualize/visualization"

/**
 * Profiles the renderer actually draws as what they claim to be. Each has its
 * own layout in `chart.ts`; there is no profile that silently falls back to
 * another chart.
 */
export const VISUALIZATION_PROFILES = [
  "line",
  "bar",
  "area",
  "scatter",
  "pie",
  "donut",
  "box",
  "heatmap",
  "treemap",
  "sankey",
  "network",
  "timeline",
  "gantt",
  "funnel",
  "radar",
  "gauge",
  "table",
  "metric",
  "process",
] as const
export type VisualizationProfile = (typeof VISUALIZATION_PROFILES)[number]

/**
 * Profiles earlier versions accepted but only faked: "histogram" drew plain
 * bars of the given values (no binning), "map" drew a scatter with no basemap,
 * "simulation" drew a line. New specs cannot use them; stored artifacts that
 * do are read as the chart they always rendered as.
 */
export const LEGACY_PROFILE_ALIASES: Readonly<Record<string, VisualizationProfile>> = {
  histogram: "bar",
  map: "scatter",
  simulation: "line",
}

function isVisualizationProfile(value: unknown): value is VisualizationProfile {
  return VISUALIZATION_PROFILES.includes(value as VisualizationProfile)
}

export interface VisualizationDatum {
  label: string
  value: number
  group?: string
  x?: number
  y?: number
  source?: string
  target?: string
  start?: string
  end?: string
}
export interface VisualizationSpec {
  schemaVersion: typeof VISUALIZATION_SCHEMA_VERSION
  title: string
  description?: string
  profile: VisualizationProfile
  data: VisualizationDatum[]
  unit?: string
  sourceNote?: string
  palette: string[]
  accessibility: { summary: string; showDataTable: boolean }
}

export function createVisualization(
  input: Omit<VisualizationSpec, "schemaVersion" | "palette" | "accessibility"> & {
    palette?: string[]
    accessibility?: Partial<VisualizationSpec["accessibility"]>
  },
  /** Summary used when the caller supplies none (the runtime passes a localized one). */
  defaultSummary?: string
): VisualizationSpec {
  if (!input.title.trim()) throw new Error("Visualization title is required.")
  if (!isVisualizationProfile(input.profile))
    throw new Error(
      `Unsupported visualization profile: ${String(input.profile)}. Use one of: ${VISUALIZATION_PROFILES.join(", ")}.`
    )
  return {
    ...input,
    title: input.title.trim(),
    schemaVersion: 1,
    palette: input.palette?.length
      ? input.palette
      : ["#2563eb", "#7c3aed", "#059669", "#d97706", "#dc2626"],
    accessibility: {
      summary:
        input.accessibility?.summary?.trim() ||
        defaultSummary ||
        `${input.title}: ${input.data.length} data points.`,
      showDataTable: input.accessibility?.showDataTable ?? true,
    },
  }
}

export function parseVisualization(content: string): VisualizationSpec {
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Unsupported Cognia visualization schema.")
  const spec = parsed as Partial<VisualizationSpec>
  const profile = isVisualizationProfile(spec.profile)
    ? spec.profile
    : typeof spec.profile === "string"
      ? LEGACY_PROFILE_ALIASES[spec.profile]
      : undefined
  if (spec.schemaVersion !== VISUALIZATION_SCHEMA_VERSION || !profile)
    throw new Error("Unsupported Cognia visualization schema.")
  if (!Array.isArray(spec.data)) throw new Error("Cognia visualization data must be an array.")
  return {
    ...spec,
    title: typeof spec.title === "string" ? spec.title : "",
    schemaVersion: VISUALIZATION_SCHEMA_VERSION,
    profile,
    data: spec.data.map((datum): VisualizationDatum => {
      const raw = datum && typeof datum === "object" ? (datum as VisualizationDatum) : null
      return {
        label: typeof raw?.label === "string" ? raw.label : "",
        value: typeof raw?.value === "number" ? raw.value : Number.NaN,
        ...(raw?.group !== undefined ? { group: String(raw.group) } : {}),
        ...(raw?.x !== undefined ? { x: Number(raw.x) } : {}),
        ...(raw?.y !== undefined ? { y: Number(raw.y) } : {}),
        ...(raw?.source !== undefined ? { source: String(raw.source) } : {}),
        ...(raw?.target !== undefined ? { target: String(raw.target) } : {}),
        ...(raw?.start !== undefined ? { start: String(raw.start) } : {}),
        ...(raw?.end !== undefined ? { end: String(raw.end) } : {}),
      }
    }),
    palette:
      Array.isArray(spec.palette) && spec.palette.length
        ? spec.palette.map((color) => String(color))
        : ["#2563eb", "#7c3aed", "#059669", "#d97706", "#dc2626"],
    accessibility: {
      summary: typeof spec.accessibility?.summary === "string" ? spec.accessibility.summary : "",
      showDataTable: spec.accessibility?.showDataTable ?? true,
    },
  }
}

/**
 * One validation finding. `message` is the English text tools hand to the
 * model; `params` carries what the preview needs to render the same finding
 * through the `finding.<code>` translation key.
 */
export interface VisualizationFinding {
  severity: "error" | "warning"
  code: string
  message: string
  params?: Record<string, string | number>
}

export function validateVisualization(spec: VisualizationSpec): VisualizationFinding[] {
  const findings: VisualizationFinding[] = []
  if (!spec.data.length)
    findings.push({
      severity: "error",
      code: "data.empty",
      message: "Visualization requires at least one data point.",
    })
  spec.data.forEach((datum, index) => {
    if (!datum.label.trim())
      findings.push({
        severity: "error",
        code: "data.label",
        message: `Data point ${index + 1} requires a label.`,
        params: { index: index + 1 },
      })
    if (!Number.isFinite(datum.value))
      findings.push({
        severity: "error",
        code: "data.value",
        message: `Data point ${index + 1} has a non-finite value.`,
        params: { index: index + 1 },
      })
  })
  if (!spec.accessibility.summary.trim())
    findings.push({
      severity: "error",
      code: "a11y.summary",
      message: "An accessibility summary is required.",
    })
  if (
    ["sankey", "network", "process"].includes(spec.profile) &&
    spec.data.some((datum) => !datum.source || !datum.target)
  )
    findings.push({
      severity: "error",
      code: "graph.edge",
      message: `${spec.profile} data points require source and target.`,
      params: { profile: spec.profile },
    })
  if (["timeline", "gantt"].includes(spec.profile) && spec.data.some((datum) => !datum.start))
    findings.push({
      severity: "error",
      code: "time.start",
      message: `${spec.profile} data points require start dates.`,
      params: { profile: spec.profile },
    })
  return findings
}

export function recommendProfile(intent: string): {
  profile: VisualizationProfile
  reason: string
} {
  const normalized = intent.toLowerCase()
  const routes: Array<[RegExp, VisualizationProfile, string]> = [
    [
      /trend|over time|time series|趋势|随时间/,
      "line",
      "Line charts reveal change over ordered time.",
    ],
    [
      /compare|ranking|rank|比较|排名/,
      "bar",
      "Bar charts support accurate categorical comparison.",
    ],
    [
      /share|part of|proportion|占比|构成/,
      "donut",
      "Donut charts communicate a small part-to-whole set.",
    ],
    [
      /relationship|correlation|相关|关系/,
      "scatter",
      "Scatter plots reveal relationships between two measures.",
    ],
    [/flow|transfer|流向|转化路径/, "sankey", "Sankey diagrams emphasize weighted flows."],
    [/schedule|project plan|排期|甘特/, "gantt", "Gantt charts show tasks across time ranges."],
    [
      /network|dependenc(?:y|ies)|依赖|网络/,
      "network",
      "Network diagrams show connected entities.",
    ],
    [/process|workflow|流程/, "process", "Process diagrams show ordered steps and decisions."],
    [
      /location|geographic|地图|地域/,
      "scatter",
      "There is no basemap: plot longitude as x and latitude as y on a scatter, or use a table.",
    ],
    [
      /distribution|histogram|分布|直方图/,
      "bar",
      "Bin the values first, then chart one bar per bin with the count as its value.",
    ],
    [/single|headline|kpi|指标/, "metric", "A metric view foregrounds one headline value."],
    [/exact|table|明细|表格/, "table", "Tables preserve exact values and dense lookup."],
  ]
  const match = routes.find(([pattern]) => pattern.test(normalized))
  return match
    ? { profile: match[1], reason: match[2] }
    : {
        profile: "bar",
        reason: "A bar chart is the safest default for labeled quantitative values.",
      }
}
