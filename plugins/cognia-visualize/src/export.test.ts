import { createVisualization } from "./model"
import {
  exportVisualizationHtml,
  exportVisualizationReport,
  exportVisualizationSvg,
  type VisualizationExportLabels,
} from "./export"

const labels: VisualizationExportLabels = {
  columns: { label: "Label", value: "Value", group: "Group", source: "Source", target: "Target" },
  dataHeading: "Data",
  emptyReport: "No visualizations.",
}

it("exports self-contained accessible SVG and HTML without injecting labels", () => {
  const spec = createVisualization({
    title: "A < B",
    profile: "bar",
    data: [{ label: "<script>", value: 2 }],
  })
  expect(new TextDecoder().decode(exportVisualizationSvg(spec))).toContain("&lt;script&gt;")
  const html = new TextDecoder().decode(exportVisualizationHtml(spec, labels, "zh-CN"))
  expect(html).not.toContain("<script>")
  expect(html).toContain('lang="zh-CN"')
  expect(html).toContain("<svg")
  expect(html).toContain("<th>Label</th>")
})

it("report renders every session visualization into one standalone document", () => {
  const a = createVisualization({
    title: "Revenue",
    profile: "bar",
    data: [{ label: "Q1", value: 10 }],
  })
  const b = createVisualization({
    title: "Share",
    profile: "pie",
    data: [
      { label: "A", value: 3 },
      { label: "B", value: 1 },
    ],
  })
  const html = exportVisualizationReport([a, b], { title: "Report", lang: "en", labels })
  expect(html).toContain("Revenue")
  expect(html).toContain("Share")
  expect((html.match(/<svg/g) ?? []).length).toBe(2)
  expect(exportVisualizationReport([], { title: "Report", lang: "en", labels })).toContain(
    "No visualizations."
  )
})
