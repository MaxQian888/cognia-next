import { buildChartSvg, buildResponsiveChartSvg, visualizationColumns } from "./chart"
import {
  createVisualization,
  VISUALIZATION_PROFILES,
  type VisualizationDatum,
  type VisualizationProfile,
} from "./model"

function spec(
  profile: VisualizationProfile,
  data: VisualizationDatum[] = [{ label: "Q1", value: 10 }]
) {
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

it("lays every profile out for a phone-width frame without overflowing it", () => {
  const data = [
    {
      label: "Alpha",
      value: 10,
      group: "g1",
      source: "a",
      target: "b",
      start: "2026-01-01",
      x: 1,
      y: 2,
    },
    {
      label: "Beta",
      value: 4,
      group: "g2",
      source: "b",
      target: "c",
      start: "2026-02-01",
      x: 2,
      y: 5,
    },
    {
      label: "Gamma",
      value: 7,
      group: "g3",
      source: "c",
      target: "d",
      start: "2026-03-01",
      x: 3,
      y: 1,
    },
  ]
  for (const profile of VISUALIZATION_PROFILES) {
    const svg = buildChartSvg(spec(profile, data), { compact: true })
    expect(svg).toContain('viewBox="0 0 360 ')
    // Every text anchor point stays inside the 360-unit frame.
    for (const match of svg.matchAll(/<text x="(-?[\d.]+)"/g)) {
      const x = Number(match[1])
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(360)
    }
  }
  expect(buildChartSvg(spec("metric"), { compact: true })).toContain('font-size="72"')
})

it("buildResponsiveChartSvg emits the wide and compact layouts side by side", () => {
  const html = buildResponsiveChartSvg(spec("pie", [{ label: "A", value: 1 }]))
  expect(html).toContain('<div class="cviz-svg-wide"><svg')
  expect(html).toContain('<div class="cviz-svg-compact"><svg')
  expect(html).toContain('viewBox="0 0 720 ')
  expect(html).toContain('viewBox="0 0 360 ')
})

it("keeps graph labels inside the frame: right column grows leftwards", () => {
  const svg = buildChartSvg(
    spec("network", [{ label: "e", value: 1, source: "Left", target: "Right" }])
  )
  expect(svg).toMatch(/<text x="586"[^>]*text-anchor="end"[^>]*>Right<\/text>/)
})
