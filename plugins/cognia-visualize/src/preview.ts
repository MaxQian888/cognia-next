import type { Artifact, ArtifactRenderer } from "@cognia/plugin-sdk"
import { buildChartSvg, visualizationColumns } from "./chart"
import { parseVisualization, validateVisualization, type VisualizationSpec } from "./model"

/** Resolves a plugin i18n key at render time so locale switches take effect. */
export type PreviewTranslator = (key: string, params?: Record<string, string | number>) => string

export interface VisualizationPreviewDeps {
  t: PreviewTranslator
  /** Called once per mount; must return a disposer. */
  onLocaleChange: (handler: () => void) => () => void
}

export function createVisualizationRenderer(deps: VisualizationPreviewDeps): ArtifactRenderer {
  return {
    name: "Cognia Visualization",
    mount: (artifact: Artifact, container: HTMLElement) => {
      let current: Artifact = artifact
      const disposers: Array<() => void> = []

      const render = (content: string) => {
        const root = document.createElement("div")
        root.className = "cviz"
        root.appendChild(buildStyles())
        try {
          root.appendChild(renderVisualization(parseVisualization(content), deps.t))
        } catch (error) {
          const card = document.createElement("section")
          card.className = "cviz-error"
          card.setAttribute("role", "alert")
          card.textContent = deps.t("visualize.preview.parseError", {
            error: error instanceof Error ? error.message : String(error),
          })
          root.appendChild(card)
        }
        container.replaceChildren(root)
      }

      disposers.push(deps.onLocaleChange(() => render(current.content)))
      render(artifact.content)
      return {
        update: (updated) => {
          current = updated
          render(updated.content)
        },
        dispose: () => {
          disposers.forEach((dispose) => dispose())
          container.replaceChildren()
        },
      }
    },
  }
}

export function renderVisualization(spec: VisualizationSpec, t: PreviewTranslator): HTMLElement {
  const figure = document.createElement("figure")
  figure.className = "cviz-figure"
  figure.setAttribute("aria-label", spec.accessibility.summary)

  const head = document.createElement("figcaption")
  const title = document.createElement("h1")
  title.className = "cviz-title"
  title.textContent = spec.title
  head.appendChild(title)
  const meta = document.createElement("p")
  meta.className = "cviz-meta"
  meta.textContent = t("visualize.preview.meta", { count: spec.data.length })
  head.appendChild(meta)
  if (spec.description) {
    const description = document.createElement("p")
    description.className = "cviz-desc"
    description.textContent = spec.description
    head.appendChild(description)
  }
  figure.appendChild(head)

  const chart = document.createElement("div")
  chart.className = "cviz-chart"
  if (spec.profile === "table") {
    chart.appendChild(renderTable(spec, t))
  } else {
    // All user-visible strings inside the SVG markup are XML-escaped by
    // buildChartSvg; the numbers are formatted through fmt().
    chart.innerHTML = buildChartSvg(spec)
  }
  figure.appendChild(chart)

  if (spec.accessibility.showDataTable && spec.profile !== "table") {
    const wrap = document.createElement("section")
    wrap.className = "cviz-data"
    const heading = document.createElement("h2")
    heading.className = "cviz-section-title"
    heading.textContent = t("visualize.preview.data")
    wrap.append(heading, renderTable(spec, t))
    figure.appendChild(wrap)
  }

  const findings = validateVisualization(spec)
  if (findings.length) {
    const section = document.createElement("section")
    section.className = "cviz-validation"
    section.setAttribute("role", "status")
    const heading = document.createElement("h2")
    heading.className = "cviz-section-title"
    heading.textContent = t("visualize.preview.validation")
    const list = document.createElement("ul")
    for (const finding of findings) {
      const item = document.createElement("li")
      item.className = `cviz-finding is-${finding.severity}`
      item.textContent = `${finding.code}: ${finding.message}`
      list.appendChild(item)
    }
    section.append(heading, list)
    figure.appendChild(section)
  }
  return figure
}

function renderTable(spec: VisualizationSpec, t: PreviewTranslator): HTMLTableElement {
  const columns = visualizationColumns(spec)
  const table = document.createElement("table")
  table.className = "cviz-table"
  table.setAttribute("aria-label", t("visualize.preview.data"))
  const head = table.createTHead().insertRow()
  for (const column of columns) {
    const th = document.createElement("th")
    th.textContent = t(`visualize.preview.col.${column}`)
    head.appendChild(th)
  }
  const body = table.createTBody()
  for (const datum of spec.data) {
    const row = body.insertRow()
    for (const column of columns) {
      const cell = row.insertCell()
      cell.textContent =
        column === "value"
          ? `${Number.isFinite(datum.value) ? datum.value : "—"}${spec.unit ?? ""}`
          : String(datum[column] ?? "")
    }
  }
  return table
}

function buildStyles(): HTMLStyleElement {
  const style = document.createElement("style")
  style.textContent = `
.cviz { font: inherit; color: var(--foreground); }
.cviz-figure { display: grid; gap: 18px; padding: 24px; margin: 0; min-height: 320px; }
.cviz-title { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
.cviz-meta { color: var(--muted-foreground); font-size: .8125rem; margin: 6px 0 0; }
.cviz-desc { color: var(--muted-foreground); font-size: .925rem; line-height: 1.6; margin: 10px 0 0; }
.cviz-chart { border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: 12px; }
.cviz-chart svg { display: block; width: 100%; height: auto; }
.cviz-section-title { font-size: .8125rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted-foreground); margin: 0 0 8px; }
.cviz-table { width: 100%; border-collapse: collapse; font-size: .875rem; }
.cviz-table th, .cviz-table td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
.cviz-table th { background: var(--muted); font-weight: 600; }
.cviz-validation ul { margin: 0; padding-left: 1.2em; font-size: .8125rem; }
.cviz-finding { margin-bottom: 2px; }
.cviz-finding.is-error { color: var(--destructive, #dc2626); }
.cviz-finding.is-warning { color: var(--warning, #d97706); }
.cviz-error { color: var(--destructive, #dc2626); padding: 16px; border: 1px solid var(--border); border-radius: 8px; }
`
  return style
}
