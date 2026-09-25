import { buildChartSvg, buildResponsiveChartSvg, escapeXml, visualizationColumns } from "./chart"
import type { VisualizationSpec } from "./model"

/** Localized strings the standalone exports need; resolved by `ctx.i18n.t`. */
export interface VisualizationExportLabels {
  columns: Record<string, string>
  dataHeading: string
  emptyReport: string
}

function tableHtml(spec: VisualizationSpec, labels: VisualizationExportLabels): string {
  const columns = visualizationColumns(spec)
  const header = columns
    .map((column) => `<th>${escapeXml(labels.columns[column] ?? column)}</th>`)
    .join("")
  const rows = spec.data
    .map((datum) => {
      const cells = columns
        .map((column) =>
          column === "value"
            ? `<td>${Number.isFinite(datum.value) ? datum.value : "—"}${escapeXml(spec.unit ?? "")}</td>`
            : `<td>${escapeXml(String(datum[column] ?? ""))}</td>`
        )
        .join("")
      return `<tr>${cells}</tr>`
    })
    .join("")
  // Wide tables scroll inside their own box instead of widening a phone page.
  return `<div class="table-scroll"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`
}

const PAGE_STYLE =
  "body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:32px;color:#0f172a;background:#fff}" +
  "main{max-width:860px;margin:0 auto}h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin:24px 0 8px}" +
  ".summary{color:#475569;margin:0 0 24px}.chart{border:1px solid #e2e8f0;border-radius:10px;padding:12px}" +
  ".chart svg{display:block;width:100%;height:auto}table{width:100%;border-collapse:collapse;font-size:.875rem}" +
  "th,td{border:1px solid #e2e8f0;padding:6px 10px;text-align:left}th{background:#f1f5f9}" +
  ".viz{border-top:1px solid #e2e8f0;padding-top:24px;margin-top:32px}.viz:first-of-type{border-top:0;margin-top:0;padding-top:0}" +
  ".table-scroll{overflow-x:auto}.cviz-svg-compact{display:none}" +
  "@media (max-width:520px){body{padding:16px}.cviz-svg-wide{display:none}.cviz-svg-compact{display:block}}"

export function exportVisualizationSvg(spec: VisualizationSpec): Uint8Array {
  return new TextEncoder().encode(buildChartSvg(spec, { standalone: true }))
}

export function exportVisualizationHtml(
  spec: VisualizationSpec,
  labels: VisualizationExportLabels,
  lang = "en"
): Uint8Array {
  const body =
    `<h1>${escapeXml(spec.title)}</h1>` +
    `<p class="summary">${escapeXml(spec.accessibility.summary)}</p>` +
    `<div class="chart">${buildResponsiveChartSvg(spec, { standalone: true })}</div>` +
    `<h2>${escapeXml(labels.dataHeading)}</h2>${tableHtml(spec, labels)}`
  return new TextEncoder().encode(
    `<!doctype html><html lang="${escapeXml(lang)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeXml(spec.title)}</title><style>${PAGE_STYLE}</style><body><main>${body}</main></body></html>`
  )
}

/**
 * Session report used by the `visualization-report` custom exporter: every
 * visualization artifact in the exported session rendered into one standalone
 * HTML document.
 */
export function exportVisualizationReport(
  specs: VisualizationSpec[],
  options: { title: string; lang: string; labels: VisualizationExportLabels }
): string {
  const sections = specs
    .map(
      (spec) =>
        `<section class="viz"><h1>${escapeXml(spec.title)}</h1>` +
        `<p class="summary">${escapeXml(spec.accessibility.summary)}</p>` +
        `<div class="chart">${buildResponsiveChartSvg(spec, { standalone: true })}</div>` +
        `<h2>${escapeXml(options.labels.dataHeading)}</h2>${tableHtml(spec, options.labels)}</section>`
    )
    .join("")
  const body = sections || `<p class="summary">${escapeXml(options.labels.emptyReport)}</p>`
  return (
    `<!doctype html><html lang="${escapeXml(options.lang)}"><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeXml(options.title)}</title><style>${PAGE_STYLE}</style>` +
    `<body><main><h1>${escapeXml(options.title)}</h1>${body}</main></body></html>`
  )
}
