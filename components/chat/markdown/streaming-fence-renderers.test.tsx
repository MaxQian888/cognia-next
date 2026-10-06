import { render, screen } from "@testing-library/react"
import type { PluginConfig } from "streamdown"
import {
  StreamingChartFence,
  StreamingMermaidFence,
  withStreamingFenceRenderers,
} from "./streaming-fence-renderers"

// Resolve each dynamic import to a stand-in named after its module.
jest.mock("next/dynamic", () => (loader: () => Promise<unknown>) => {
  const source = String(loader)
  const kind = source.includes("chart-block") ? "chart-block" : "mermaid-block"
  const Block = ({ content }: { content: string }) => <div data-testid={kind}>{content}</div>
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

describe("withStreamingFenceRenderers", () => {
  const plugins = { cjk: {} } as unknown as PluginConfig

  it("adds the mermaid renderer and keeps a stable identity", () => {
    const withMermaid = withStreamingFenceRenderers(plugins, { mermaid: true, charts: false })
    expect(withMermaid.renderers).toEqual([
      { language: "mermaid", component: StreamingMermaidFence },
    ])
    expect(withMermaid.cjk).toBe(plugins.cjk)
    expect(withStreamingFenceRenderers(plugins, { mermaid: true, charts: false })).toBe(withMermaid)
    expect(withStreamingFenceRenderers(plugins, { mermaid: true, charts: true }).renderers).toEqual(
      [
        { language: "mermaid", component: StreamingMermaidFence },
        { language: "chart", component: StreamingChartFence },
      ]
    )
  })

  it("returns the plugin set untouched when no fence is enabled", () => {
    expect(withStreamingFenceRenderers(plugins, { mermaid: false, charts: false })).toBe(plugins)
  })
})
