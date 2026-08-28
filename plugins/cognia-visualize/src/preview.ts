import type { ArtifactRenderer } from "@cognia/plugin-sdk"
import { parseVisualization, validateVisualization, type VisualizationSpec } from "./model"

export function createVisualizationRenderer(labels: {
  data: string
  validation: string
}): ArtifactRenderer {
  return {
    name: "Cognia Visualization",
    mount: (artifact, container) => {
      const render = (content: string) =>
        container.replaceChildren(renderVisualization(parseVisualization(content), labels))
      render(artifact.content)
      return {
        update: (updated) => render(updated.content),
        dispose: () => container.replaceChildren(),
      }
    },
  }
}

export function renderVisualization(
  spec: VisualizationSpec,
  labels = { data: "Data", validation: "Validation" }
): HTMLElement {
  const root = document.createElement("figure")
  root.setAttribute("aria-label", spec.accessibility.summary)
  root.style.cssText = "display:grid;gap:16px;padding:20px;min-height:320px;color:var(--foreground)"
  const heading = document.createElement("figcaption")
  heading.textContent = spec.title
  heading.style.cssText = "font-size:20px;font-weight:700"
  root.appendChild(heading)
  if (spec.description) {
    const description = document.createElement("p")
    description.textContent = spec.description
    root.appendChild(description)
  }
  root.appendChild(
    ["table"].includes(spec.profile)
      ? renderTable(spec, labels.data)
      : ["network", "sankey", "process"].includes(spec.profile)
        ? renderGraph(spec)
        : renderBars(spec)
  )
  if (spec.accessibility.showDataTable && spec.profile !== "table")
    root.appendChild(renderTable(spec, labels.data))
  const findings = validateVisualization(spec)
  if (findings.length) {
    const status = document.createElement("div")
    status.setAttribute("role", "status")
    status.textContent = `${labels.validation}: ${findings.map((finding) => finding.message).join(" · ")}`
    root.appendChild(status)
  }
  return root
}

function renderBars(spec: VisualizationSpec): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 720 320")
  svg.setAttribute("role", "img")
  svg.setAttribute("aria-label", spec.accessibility.summary)
  const max = Math.max(...spec.data.map((datum) => Math.abs(datum.value)), 1)
  spec.data.forEach((datum, index) => {
    const width = Math.max(2, (Math.abs(datum.value) / max) * 560)
    const y = 16 + index * Math.min(42, 270 / Math.max(spec.data.length, 1))
    const rect = document.createElementNS(svg.namespaceURI, "rect")
    rect.setAttribute("x", "130")
    rect.setAttribute("y", String(y))
    rect.setAttribute("width", String(width))
    rect.setAttribute("height", "24")
    rect.setAttribute("fill", spec.palette[index % spec.palette.length])
    const label = document.createElementNS(svg.namespaceURI, "text")
    label.setAttribute("x", "4")
    label.setAttribute("y", String(y + 17))
    label.textContent = datum.label
    const value = document.createElementNS(svg.namespaceURI, "text")
    value.setAttribute("x", String(138 + width))
    value.setAttribute("y", String(y + 17))
    value.textContent = `${datum.value}${spec.unit ?? ""}`
    svg.append(rect, label, value)
  })
  return svg
}

function renderGraph(spec: VisualizationSpec): HTMLElement {
  const list = document.createElement("ol")
  for (const edge of spec.data) {
    const item = document.createElement("li")
    item.textContent = `${edge.source} → ${edge.target}: ${edge.value}${spec.unit ?? ""}`
    list.appendChild(item)
  }
  return list
}
function renderTable(spec: VisualizationSpec, label: string): HTMLTableElement {
  const table = document.createElement("table")
  table.setAttribute("aria-label", label)
  const head = table.createTHead().insertRow()
  ;["Label", "Value", "Group"].forEach((text) => {
    const th = document.createElement("th")
    th.textContent = text
    head.appendChild(th)
  })
  const body = table.createTBody()
  for (const datum of spec.data) {
    const row = body.insertRow()
    ;[datum.label, `${datum.value}${spec.unit ?? ""}`, datum.group ?? ""].forEach((text) => {
      const cell = row.insertCell()
      cell.textContent = text
    })
  }
  return table
}
