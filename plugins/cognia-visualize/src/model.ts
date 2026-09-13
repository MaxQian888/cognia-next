export const VISUALIZATION_SCHEMA_VERSION = 1 as const
export const VISUALIZATION_ARTIFACT_KIND = "cognia-visualize/visualization"

export const VISUALIZATION_PROFILES = [
  "line",
  "bar",
  "area",
  "scatter",
  "pie",
  "donut",
  "histogram",
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
  "map",
  "table",
  "metric",
  "process",
  "simulation",
] as const
export type VisualizationProfile = (typeof VISUALIZATION_PROFILES)[number]

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
  }
): VisualizationSpec {
  if (!input.title.trim()) throw new Error("Visualization title is required.")
  if (!VISUALIZATION_PROFILES.includes(input.profile))
    throw new Error(`Unsupported visualization profile: ${input.profile}`)
  return {
    ...input,
    title: input.title.trim(),
    schemaVersion: 1,
    palette: input.palette?.length
      ? input.palette
      : ["#2563eb", "#7c3aed", "#059669", "#d97706", "#dc2626"],
    accessibility: {
      summary:
        input.accessibility?.summary?.trim() || `${input.title}: ${input.data.length} data points.`,
      showDataTable: input.accessibility?.showDataTable ?? true,
    },
  }
}

export function parseVisualization(content: string): VisualizationSpec {
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Unsupported Cognia visualization schema.")
  const spec = parsed as Partial<VisualizationSpec>
  if (
    spec.schemaVersion !== VISUALIZATION_SCHEMA_VERSION ||
    !VISUALIZATION_PROFILES.includes(spec.profile as VisualizationProfile)
  )
    throw new Error("Unsupported Cognia visualization schema.")
  if (!Array.isArray(spec.data)) throw new Error("Cognia visualization data must be an array.")
  return {
    ...spec,
    title: typeof spec.title === "string" ? spec.title : "",
    schemaVersion: VISUALIZATION_SCHEMA_VERSION,
    profile: spec.profile as VisualizationProfile,
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

export function validateVisualization(spec: VisualizationSpec) {
  const findings: Array<{ severity: "error" | "warning"; code: string; message: string }> = []
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
      })
    if (!Number.isFinite(datum.value))
      findings.push({
        severity: "error",
        code: "data.value",
        message: `Data point ${index + 1} has a non-finite value.`,
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
    })
  if (["timeline", "gantt"].includes(spec.profile) && spec.data.some((datum) => !datum.start))
    findings.push({
      severity: "error",
      code: "time.start",
      message: `${spec.profile} data points require start dates.`,
    })
  if (
    spec.profile === "map" &&
    spec.data.some((datum) => datum.x === undefined || datum.y === undefined)
  )
    findings.push({
      severity: "error",
      code: "map.coordinates",
      message: "Map data points require x/longitude and y/latitude.",
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
    [/location|geographic|地图|地域/, "map", "Maps encode values at geographic coordinates."],
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
