/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import type { TurnCostPoint } from "@/lib/usage/session-cost-profile"
import { ContextGrowthChart } from "./context-growth-chart"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

function point(index: number, contextTokens: number): TurnCostPoint {
  return {
    index,
    messageId: `m${index}`,
    at: index,
    surface: "chat",
    costUsd: 0.1,
    costKnown: true,
    contextTokens,
    outputTokens: 10,
    durationMs: 0,
    cumulativeCostUsd: 0,
  }
}

describe("ContextGrowthChart", () => {
  it("summarises the peak, the latest turn and context drops", () => {
    render(
      <ContextGrowthChart
        points={[point(1, 20_000), point(2, 90_000), point(3, 30_000)]}
        maxTokens={200_000}
        compactAtTokens={167_000}
      />
    )
    expect(screen.getByTestId("context-growth")).toBeInTheDocument()
    expect(screen.getByTestId("context-growth-summary")).toHaveTextContent(
      "Peak 90.0K, latest 30.0K. Context dropped once"
    )
  })

  it("omits the drop note when context only grew", () => {
    render(<ContextGrowthChart points={[point(1, 1000), point(2, 2000)]} />)
    expect(screen.getByTestId("context-growth-summary")).not.toHaveTextContent("dropped")
  })

  it("shows an empty hint without turns", () => {
    render(<ContextGrowthChart points={[]} />)
    expect(screen.getByTestId("context-growth-empty")).toBeInTheDocument()
  })
})
