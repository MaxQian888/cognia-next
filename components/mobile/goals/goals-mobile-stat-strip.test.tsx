/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { GoalsMobileStatStrip } from "./goals-mobile-stat-strip"

// next-intl globally mocked in jest.setup.ts (resolves keys against en.json).

describe("<GoalsMobileStatStrip />", () => {
  it("renders the three status cells with their counts", () => {
    render(<GoalsMobileStatStrip active={2} paused={1} done={5} />)
    expect(screen.getByTestId("mobile-goals-stats")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-goal-stat-active")).toHaveTextContent("2")
    expect(screen.getByTestId("mobile-goal-stat-paused")).toHaveTextContent("1")
    expect(screen.getByTestId("mobile-goal-stat-done")).toHaveTextContent("5")
  })

  it("labels the cells from the goal namespace", () => {
    render(<GoalsMobileStatStrip active={0} paused={0} done={0} />)
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByText("Paused")).toBeInTheDocument()
    expect(screen.getByText("Completed")).toBeInTheDocument()
  })
})
