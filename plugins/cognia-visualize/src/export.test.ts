import { createVisualization } from "./model"
import { exportVisualizationHtml, exportVisualizationSvg } from "./export"

it("exports self-contained accessible SVG and HTML without injecting labels", () => {
  const spec = createVisualization({
    title: "A < B",
    profile: "bar",
    data: [{ label: "<script>", value: 2 }],
  })
  expect(new TextDecoder().decode(exportVisualizationSvg(spec))).toContain("&lt;script&gt;")
  expect(new TextDecoder().decode(exportVisualizationHtml(spec))).not.toContain("<script>")
})
