import { render, screen } from "@testing-library/react"
import type { PluginConfig } from "streamdown"
import {
  StreamingA2UIFence,
  StreamingChartFence,
  StreamingMermaidFence,
  withStreamingFenceRenderers,
} from "./streaming-fence-renderers"

// Resolve each dynamic import to a stand-in named after its module.
jest.mock("next/dynamic", () => (loader: () => Promise<unknown>) => {
  const source = String(loader)
  const kind = source.includes("chart-block")
    ? "chart-block"
    : source.includes("a2ui-streaming-fence")
      ? "a2ui-streaming-fence"
      : "mermaid-block"
  const Block = ({ content, code }: { content?: string; code?: string }) => (
    <div data-testid={kind}>{content ?? code}</div>
  )
  return Block
})

describe("StreamingMermaidFence", () => {
  it("holds a sized placeholder in the block frame while the fence is open", () => {
    const { container } = render(
      <StreamingMermaidFence code="graph TD; A-" isIncomplete language="mermaid" />
    )
    const frame = container.querySelector('[data-rich-block="mermaid"]')!
    expect(frame).toHaveAttribute("aria-busy", "true")
    expect(frame).toHaveAttribute("data-fence-pending")
    expect(screen.queryByTestId("mermaid-block")).not.toBeInTheDocument()
  })

  it("renders the app's MermaidBlock once the fence closes", () => {
    render(<StreamingMermaidFence code="graph TD; A-->B" isIncomplete={false} language="mermaid" />)
    expect(screen.getByTestId("mermaid-block")).toHaveTextContent("graph TD; A-->B")
  })
})

describe("StreamingChartFence", () => {
  it("holds the chart frame while the fence is open, then draws the chart block", () => {
    const { container, rerender } = render(
      <StreamingChartFence code='{"type":"bar"' isIncomplete language="chart" />
    )
    expect(container.querySelector('[data-rich-block="chart"]')).toHaveAttribute(
      "aria-busy",
      "true"
    )
    rerender(<StreamingChartFence code='{"data":[]}' isIncomplete={false} language="chart" />)
    expect(screen.getByTestId("chart-block")).toHaveTextContent('{"data":[]}')
  })
})

describe("StreamingA2UIFence", () => {
  it("hands the open fence to the preview renderer instead of a code block", () => {
    render(<StreamingA2UIFence code='{"components":[' isIncomplete language="a2ui" />)
    expect(screen.getByTestId("a2ui-streaming-fence")).toHaveTextContent('{"components":[')
  })
})

describe("withStreamingFenceRenderers", () => {
  const plugins = { cjk: {} } as unknown as PluginConfig
  const a2ui = { language: "a2ui", component: StreamingA2UIFence }

  it("adds the mermaid renderer and keeps a stable identity", () => {
    const withMermaid = withStreamingFenceRenderers(plugins, { mermaid: true, charts: false })
    expect(withMermaid.renderers).toEqual([
      { language: "mermaid", component: StreamingMermaidFence },
      a2ui,
    ])
    expect(withMermaid.cjk).toBe(plugins.cjk)
    expect(withStreamingFenceRenderers(plugins, { mermaid: true, charts: false })).toBe(withMermaid)
    expect(withStreamingFenceRenderers(plugins, { mermaid: true, charts: true }).renderers).toEqual(
      [
        { language: "mermaid", component: StreamingMermaidFence },
        { language: "chart", component: StreamingChartFence },
        a2ui,
      ]
    )
  })

  it("always streams a2ui fences, even with mermaid and charts off", () => {
    const next = withStreamingFenceRenderers(plugins, { mermaid: false, charts: false })
    expect(next.renderers).toEqual([a2ui])
    expect(next.cjk).toBe(plugins.cjk)
  })
})
