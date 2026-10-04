/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import type { TurnCostPoint } from "@/lib/usage/session-cost-profile"
import { SessionCostTimeline } from "./session-cost-timeline"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))
jest.mock("@/hooks/logging/use-theme-colors", () => ({
  useThemeColors: () => ({
    "chart-1": "#111",
    "chart-2": "#222",
    "chart-3": "#333",
    "chart-4": "#444",
    "chart-5": "#555",
  }),
}))

function point(index: number, costUsd: number, over: Partial<TurnCostPoint> = {}): TurnCostPoint {
  return {
    index,
    messageId: `m${index}`,
    at: Date.UTC(2026, 4, 20, 10, index),
    model: "claude-x",
    surface: "chat",
    costUsd,
    costKnown: true,
    contextTokens: 10_000 * index,
    outputTokens: 100,
    durationMs: 1000,
    cumulativeCostUsd: 0,
    ...over,
  }
}

describe("SessionCostTimeline", () => {
  it("renders nothing for a session without billed turns", () => {
    const { container } = render(<SessionCostTimeline points={[]} rank={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists the priciest turns and jumps back to chat turns only", () => {
    const onJump = jest.fn()
    const points = [
      point(1, 0.1),
      point(2, 0.9, { surface: "subagent" }),
      point(3, 0.5),
      point(4, 0, { costKnown: false }),
    ]
    render(<SessionCostTimeline points={points} rank={null} onJump={onJump} />)
    const list = screen.getByTestId("session-cost-top-turns")
    expect(list.querySelectorAll("li")).toHaveLength(3)
    expect(list.querySelectorAll("li")[0]).toHaveTextContent("Turn 2")
    // The subagent turn has no transcript row to land on.
    expect(screen.queryByTestId("session-cost-jump-2")).toBeNull()
    fireEvent.click(screen.getByTestId("session-cost-jump-3"))
    expect(onJump).toHaveBeenCalledWith("m3")
  })

  it("hides the jump affordance when no transcript is available", () => {
    render(<SessionCostTimeline points={[point(1, 0.2), point(2, 0.3)]} rank={null} />)
    expect(screen.queryByTestId("session-cost-jump-1")).toBeNull()
  })

  it("explains concentration, context growth and the rank", () => {
    render(
      <SessionCostTimeline
        points={[point(1, 0.1), point(2, 0.1), point(3, 0.8)]}
        rank={{ percentile: 85, peers: 12, medianUsd: 0.4 }}
      />
    )
    expect(screen.getByTestId("session-cost-rank")).toHaveTextContent(
      "Costs more than 85% of your other conversations in the last 30 days (median $0.40, 12 compared)."
    )
    expect(screen.getByTestId("session-cost-concentration")).toHaveTextContent(
      "Turn 3 alone carried 80%"
    )
    expect(screen.getByTestId("session-cost-growth")).toHaveTextContent(
      "Context grew 3.0× from the first turn to the last (10.0K → 30.0K)"
    )
  })

  it("stays quiet when spend is even and context is flat", () => {
    render(
      <SessionCostTimeline
        points={[
          point(1, 0.2, { contextTokens: 5000 }),
          point(2, 0.2, { contextTokens: 5000 }),
          point(3, 0.2, { contextTokens: 5000 }),
          point(4, 0.2, { contextTokens: 5000 }),
        ]}
        rank={null}
      />
    )
    expect(screen.queryByTestId("session-cost-concentration")).toBeNull()
    expect(screen.queryByTestId("session-cost-growth")).toBeNull()
    expect(screen.queryByTestId("session-cost-rank")).toBeNull()
  })

  it("drops its own heading when the host titles the section", () => {
    const { rerender } = render(<SessionCostTimeline points={[point(1, 0.1)]} rank={null} />)
    expect(screen.getByText("Cost per turn")).toBeInTheDocument()
    rerender(<SessionCostTimeline points={[point(1, 0.1)]} rank={null} hideTitle />)
    expect(screen.queryByText("Cost per turn")).toBeNull()
  })
})
