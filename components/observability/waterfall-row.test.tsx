/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { WaterfallRow } from "./waterfall-row"
import type { WaterfallNode } from "@/lib/observability/trace-rollup"
import { makeSpan } from "@/lib/observability/fixtures"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

function node(over: Partial<WaterfallNode> = {}): WaterfallNode {
  return {
    span: makeSpan({ spanId: "s1", operationName: "chat", responseModel: "opus" }),
    label: "chat",
    depth: 0,
    offsetMs: 0,
    widthMs: 100,
    isError: false,
    children: [],
    ...over,
  }
}

describe("WaterfallRow", () => {
  it("positions the timing bar by offset and width", () => {
    render(<WaterfallRow node={node({ offsetMs: 50, widthMs: 100 })} totalMs={200} color="#abc" />)
    const bar = screen.getByTestId("waterfall-bar-s1")
    expect(bar).toHaveStyle({ left: "25%", width: "50%" })
  })

  it("clamps width to a minimum so tiny spans stay visible", () => {
    render(<WaterfallRow node={node({ offsetMs: 0, widthMs: 0 })} totalMs={1000} color="#abc" />)
    expect(screen.getByTestId("waterfall-bar-s1")).toHaveStyle({ width: "0.5%" })
  })

  it("shows an error icon for failed spans", () => {
    render(<WaterfallRow node={node({ isError: true })} totalMs={100} color="#f00" />)
    // The meta is collapsed; the error icon sits in the label row.
    expect(screen.getByTestId("waterfall-row-s1")).toBeInTheDocument()
  })

  it("expands events when toggled", () => {
    const withEvents = node({
      span: makeSpan({
        spanId: "s2",
        startTime: 1000,
        events: [{ name: "tool_use", at: 1050 }],
      }),
    })
    render(<WaterfallRow node={withEvents} totalMs={100} color="#abc" />)
    expect(screen.queryByTestId("waterfall-meta-s2")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("waterfall-toggle-s2"))
    const meta = screen.getByTestId("waterfall-meta-s2")
    expect(meta).toHaveTextContent("tool_use")
    expect(meta).toHaveTextContent("+50ms")
  })

  it("renders no toggle when there are no events", () => {
    render(
      <WaterfallRow node={node({ span: makeSpan({ spanId: "s3" }) })} totalMs={100} color="#abc" />
    )
    expect(screen.queryByTestId("waterfall-toggle-s3")).not.toBeInTheDocument()
  })
})
