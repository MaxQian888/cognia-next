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

  it("keeps all three counts on one row instead of behind a swipe", () => {
    // The carousel this replaced sized each card at `w-[42%]`, so a 375px
    // screen showed two and a half of three and the completed count scrolled
    // off. `StatStrip` also stacks three stats into one column until its
    // console pane is wide, which is wrong for a strip that IS the page width.
    render(<GoalsMobileStatStrip active={2} paused={1} done={5} />)
    const strip = screen.getByTestId("mobile-goals-stats")
    expect(strip).not.toHaveClass("overflow-x-auto")
    expect(strip).toHaveClass("grid-cols-3")
  })

  it("labels the cells from the goal namespace", () => {
    render(<GoalsMobileStatStrip active={0} paused={0} done={0} />)
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByText("Paused")).toBeInTheDocument()
    expect(screen.getByText("Completed")).toBeInTheDocument()
  })
})
