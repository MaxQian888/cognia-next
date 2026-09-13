/** @jest-environment jsdom */
import type { Artifact } from "@cognia/plugin-sdk"
import { createVisualization } from "./model"
import { createVisualizationRenderer, renderVisualization } from "./preview"

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

it("renders an accessible visual and exact-value fallback table", () => {
  const root = renderVisualization(
    createVisualization({ title: "Revenue", profile: "bar", data: [{ label: "Q1", value: 10 }] }),
    t
  )
  expect(root).toHaveAccessibleName("Revenue: 1 data points.")
  expect(root.querySelector("svg")).toHaveAttribute("role", "img")
  expect(root.querySelector("table")).toHaveTextContent("Q1")
})

it("dispatches real chart families instead of one bar fallback", () => {
  const pie = renderVisualization(
    createVisualization({
      title: "Share",
      profile: "pie",
      data: [
        { label: "A", value: 3 },
        { label: "B", value: 1 },
      ],
    }),
    t
  )
  expect(pie.querySelector("svg path")).not.toBeNull()
  const metric = renderVisualization(
    createVisualization({ title: "KPI", profile: "metric", data: [{ label: "ARR", value: 42 }] }),
    t
  )
  expect(metric.querySelector("svg")).toHaveTextContent("42")
})

it("renders graph profiles as a node-link diagram with adaptive table columns", () => {
  const root = renderVisualization(
    createVisualization({
      title: "Flow",
      profile: "sankey",
      data: [{ label: "e1", value: 5, source: "A", target: "B" }],
    }),
    t
  )
  expect(root.querySelector("svg path")).not.toBeNull()
  const headers = [...root.querySelectorAll("th")].map((th) => th.textContent)
  expect(headers).toEqual(
    expect.arrayContaining(["visualize.preview.col.source", "visualize.preview.col.target"])
  )
})

it("shows an error card instead of throwing on malformed content", () => {
  const renderer = createVisualizationRenderer({ t, onLocaleChange: () => jest.fn() })
  const container = document.createElement("div")
  const handle = renderer.mount(
    { id: "a1", content: '{"schemaVersion":2}', type: "chart" } as Artifact,
    container
  )
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  handle.dispose()
  expect(container.childElementCount).toBe(0)
})

it("re-renders on locale change and on artifact updates", () => {
  let localeHandler: (() => void) | undefined
  const renderer = createVisualizationRenderer({
    t,
    onLocaleChange: (handler) => {
      localeHandler = handler
      return jest.fn()
    },
  })
  const container = document.createElement("div")
  const artifact = {
    id: "a1",
    type: "chart",
    content: JSON.stringify(
      createVisualization({ title: "Revenue", profile: "bar", data: [{ label: "Q1", value: 10 }] })
    ),
  } as Artifact
  const handle = renderer.mount(artifact, container)
  expect(container.querySelector("svg")).not.toBeNull()
  localeHandler?.()
  expect(container.querySelector("svg")).not.toBeNull()
  handle.update?.({
    ...artifact,
    content: JSON.stringify(
      createVisualization({ title: "Costs", profile: "bar", data: [{ label: "Q1", value: 4 }] })
    ),
  } as Artifact)
  expect(container).toHaveTextContent("Costs")
})
