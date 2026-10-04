/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import {
  buildSdkContextBreakdown,
  buildEstimateContextBreakdown,
} from "@/lib/claude/context-breakdown"
import { ContextCompositionDonut } from "./context-composition-donut"

const live = buildSdkContextBreakdown({
  totalTokens: 60_000,
  maxTokens: 100_000,
  percentage: 60,
  categories: [
    { name: "Messages", tokens: 40_000 },
    { name: "MCP tools", tokens: 15_000 },
    { name: "MCP tools (deferred)", tokens: 5_000, isDeferred: true },
    { name: "System prompt", tokens: 5_000 },
    { name: "Free space", tokens: 40_000 },
  ],
})

describe("ContextCompositionDonut", () => {
  it("draws one arc per loaded group and skips deferred ones", () => {
    const { container } = render(<ContextCompositionDonut breakdown={live} centerLabel="60%" />)
    const arcs = [...container.querySelectorAll("circle[data-group]")].map((c) =>
      c.getAttribute("data-group")
    )
    expect(arcs).toEqual(["messages", "mcp", "systemPrompt"])
    expect(container.querySelector('circle[data-group="messages"]')).toHaveClass("stroke-chart-1")
    expect(screen.getByTestId("context-composition-center")).toHaveTextContent("60%")
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Context window: 60.0K of 100.0K tokens"
    )
    expect(screen.getByTestId("context-composition-caption")).toHaveTextContent(
      "Shares of the whole window"
    )
  })

  it("lists the largest groups in the legend", () => {
    render(<ContextCompositionDonut breakdown={live} centerLabel="60%" />)
    const legend = screen.getByTestId("context-composition-legend")
    expect(legend.querySelectorAll("li")[0]).toHaveTextContent("40.0K")
  })

  it("says when the shares are of the attributed transcript only", () => {
    const estimate = buildEstimateContextBreakdown(
      [{ id: "u", role: "user", parts: [{ type: "text", text: "hello there" }] }] as never,
      100,
      1000
    )
    render(<ContextCompositionDonut breakdown={estimate} centerLabel="—" />)
    expect(screen.getByTestId("context-composition-caption")).toHaveTextContent(
      "Estimated from the transcript"
    )
  })
})
