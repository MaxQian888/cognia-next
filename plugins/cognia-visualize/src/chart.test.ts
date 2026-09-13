import { buildChartSvg, visualizationColumns } from "./chart"
import { createVisualization, VISUALIZATION_PROFILES, type VisualizationProfile } from "./model"

function spec(profile: VisualizationProfile, data = [{ label: "Q1", value: 10 }]) {
  return createVisualization({ title: "Demo", profile, data })
}

it("renders every supported profile to escaped, aria-labeled SVG", () => {
  const data = [
    {
      label: "A",
      value: 10,
      group: "g1",
      source: "a",
      target: "b",
      start: "2026-01-01",
      end: "2026-02-01",
      x: 1,
      y: 2,
    },
    {
      label: "B",
      value: -4,
      group: "g2",
      source: "b",
      target: "c",
      start: "2026-02-01",
      end: "2026-03-01",
      x: 2,
      y: 5,
    },
    {
      label: "C",
      value: 7,
      group: "g1",
      source: "c",
      target: "a",
      start: "2026-03-01",
      end: "2026-04-01",
      x: 3,
      y: 1,
    },
  ]
  for (const profile of VISUALIZATION_PROFILES) {
    const svg = buildChartSvg(spec(profile, data))
    expect(svg).toContain("<svg")
    expect(svg).toContain('role="img"')
    expect(svg).toContain('aria-label="Demo: 3 data points."')
  }
})

it("renders sign-aware diverging bars for negative values", () => {
  const svg = buildChartSvg(
    spec("bar", [
      { label: "Up", value: 10 },
      { label: "Down", value: -5 },
    ])
  )
  expect(svg).toContain("<line")
  // The negative bar starts left of the zero axis and its label is end-anchored.
  expect(svg).toContain('text-anchor="end"')
})

it("pie, radar, gauge, metric, and graph produce their own geometry", () => {
  expect(
    buildChartSvg(
      spec("pie", [
        { label: "A", value: 3 },
        { label: "B", value: 1 },
      ])
    )
  ).toContain("<path")
  expect(
    buildChartSvg(
      spec("donut", [
        { label: "A", value: 3 },
        { label: "B", value: 1 },
      ])
    )
  ).toContain("<path")
  expect(
    buildChartSvg(
      spec("radar", [
        { label: "a", value: 1 },
        { label: "b", value: 2 },
        { label: "c", value: 3 },
      ])
    )
  ).toContain("<polygon")
  expect(buildChartSvg(spec("gauge"))).toContain("<path")
  expect(buildChartSvg(spec("metric"))).toContain('font-size="104"')
  const graph = buildChartSvg(spec("network", [{ label: "e", value: 2, source: "A", target: "B" }]))
  expect(graph).toContain("<path")
  expect(graph).toContain("A")
})

it("escapes every user-supplied string in markup", () => {
  const svg = buildChartSvg(spec("bar", [{ label: '<img src=x onerror="pwn">', value: 1 }]))
  expect(svg).not.toContain("<img")
  expect(svg).toContain("&lt;img")
})

it("visualizationColumns emits optional columns only when data carries them", () => {
  expect(visualizationColumns(spec("bar"))).toEqual(["label", "value"])
  expect(
    visualizationColumns(spec("sankey", [{ label: "e", value: 1, source: "a", target: "b" }]))
  ).toEqual(["label", "value", "source", "target"])
})
