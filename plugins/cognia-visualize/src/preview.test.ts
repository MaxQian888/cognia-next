/** @jest-environment jsdom */
import type { Artifact } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { createVisualization } from "./model"
import { createVisualizationRenderer, localizeFinding, renderVisualization } from "./preview"

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>
const translate = (locale: string) => (key: string, params?: Record<string, string | number>) => {
  let text = LOCALES[locale]?.[key] ?? LOCALES.en[key] ?? key
  for (const [name, value] of Object.entries(params ?? {}))
    text = text.replace(`{${name}}`, String(value))
  return text
}

it("renders an accessible visual and exact-value fallback table", () => {
  const root = renderVisualization(
    createVisualization({ title: "Revenue", profile: "bar", data: [{ label: "Q1", value: 10 }] }),
    t
  )
  expect(root).toHaveAccessibleName("Revenue: 1 data points.")
  expect(root.querySelector("svg")).toHaveAttribute("role", "img")
  expect(root.querySelector("table")).toHaveTextContent("Q1")
})

it("ships a phone-width chart layout and scrollable tables for a 375px panel", () => {
  const root = renderVisualization(
    createVisualization({ title: "Revenue", profile: "bar", data: [{ label: "Q1", value: 10 }] }),
    t
  )
  expect(root.querySelector(".cviz-svg-wide svg")?.getAttribute("viewBox")).toBe("0 0 720 400")
  expect(root.querySelector(".cviz-svg-compact svg")?.getAttribute("viewBox")).toBe("0 0 360 400")
  const scroller = root.querySelector(".cviz-table-scroll")!
  expect(scroller).toHaveAttribute("role", "region")
  expect(scroller).toHaveAttribute("tabindex", "0")
  expect(scroller.querySelector("table")).not.toBeNull()

  const container = document.createElement("div")
  createVisualizationRenderer({ t, onLocaleChange: () => jest.fn() }).mount(
    {
      id: "a1",
      type: "chart",
      content: JSON.stringify(
        createVisualization({ title: "R", profile: "bar", data: [{ label: "Q1", value: 1 }] })
      ),
    } as Artifact,
    container
  )
  const css = container.querySelector("style")?.textContent ?? ""
  expect(css).toContain("container-type: inline-size")
  expect(css).toContain("@container (max-width: 520px)")
})

it("localizes findings and the renderer name", () => {
  expect(
    createVisualizationRenderer({ t: translate("zh-CN"), onLocaleChange: () => jest.fn() }).name
  ).toBe("Cognia 可视化")
  expect(
    localizeFinding(
      { severity: "error", code: "data.label", message: "raw", params: { index: 2 } },
      translate("zh-CN")
    )
  ).toBe("第 2 个数据点缺少标签。")
  expect(
    localizeFinding({ severity: "error", code: "unknown", message: "raw" }, translate("en"))
  ).toBe("raw")
})

it("keeps focus on a scrolled data table across re-renders", () => {
  let localeHandler: () => void = () => {}
  const container = document.createElement("div")
  document.body.appendChild(container)
  createVisualizationRenderer({
    t,
    onLocaleChange: (handler) => {
      localeHandler = handler
      return jest.fn()
    },
  }).mount(
    {
      id: "a1",
      type: "chart",
      content: JSON.stringify(
        createVisualization({ title: "R", profile: "bar", data: [{ label: "Q1", value: 1 }] })
      ),
    } as Artifact,
    container
  )
  container.querySelector<HTMLElement>(".cviz-table-scroll")!.focus()
  localeHandler()
  expect(document.activeElement).toBe(container.querySelector(".cviz-table-scroll"))
  document.body.replaceChildren()
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
  expect(headers).toEqual(expect.arrayContaining(["preview.col.source", "preview.col.target"]))
})

it("shows an error card instead of throwing on malformed content", () => {
  const renderer = createVisualizationRenderer({ t, onLocaleChange: () => jest.fn() })
  const container = document.createElement("div")
  const handle = renderer.mount(
    { id: "a1", content: '{"schemaVersion":2}', type: "chart" } as Artifact,
    container
  )
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("preview.parseError")
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
