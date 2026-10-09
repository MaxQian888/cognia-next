/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { GoalsMobileStatStrip } from "./goals-mobile-stat-strip"

// next-intl globally mocked in jest.setup.ts (resolves keys against en.json).

describe("<GoalsMobileStatStrip />", () => {
  it("renders the three cells with their counts", () => {
    render(<GoalsMobileStatStrip active={2} paused={1} completed={5} finished={8} />)
    expect(screen.getByTestId("mobile-goals-stats")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-goal-stat-active")).toHaveTextContent("2")
    expect(screen.getByTestId("mobile-goal-stat-paused")).toHaveTextContent("1")
  })

  it("counts completed out of finished, as the desktop strip does", () => {
    // The cell used to count every terminal status as "Done", so phone and
    // desktop printed different numbers under the same word.
    render(<GoalsMobileStatStrip active={0} paused={0} completed={5} finished={8} />)
    const done = screen.getByTestId("mobile-goal-stat-done")
    expect(done).toHaveTextContent("5")
    expect(done).toHaveTextContent("/8")
  })

  it("keeps all three counts on one row instead of behind a swipe", () => {
    // The carousel this replaced sized each card at `w-[42%]`, so a 375px
    // screen showed two and a half of three and the completed count scrolled
    // off. `StatStrip` also stacks three stats into one column until its
    // console pane is wide, which is wrong for a strip that IS the page width.
    render(<GoalsMobileStatStrip active={2} paused={1} completed={5} finished={5} />)
    const strip = screen.getByTestId("mobile-goals-stats")
    expect(strip).not.toHaveClass("overflow-x-auto")
    expect(strip).toHaveClass("grid-cols-3")
  })

  it("keeps the three-column grid alongside a caller's class", () => {
    render(
      <GoalsMobileStatStrip active={0} paused={0} completed={0} finished={0} className="mt-2" />
    )
    expect(screen.getByTestId("mobile-goals-stats")).toHaveClass("grid-cols-3", "mt-2")
  })

  it("labels the cells from the goal namespace", () => {
    render(<GoalsMobileStatStrip active={0} paused={0} completed={0} finished={0} />)
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByText("Paused")).toBeInTheDocument()
    expect(screen.getByText("Completed")).toBeInTheDocument()
  })

  it("tints Paused only when something is paused", () => {
    const { rerender } = render(
      <GoalsMobileStatStrip active={0} paused={0} completed={0} finished={0} />
    )
    expect(screen.getByTestId("mobile-goal-stat-paused").querySelector(".text-amber-600")).toBeNull()
    rerender(<GoalsMobileStatStrip active={0} paused={3} completed={0} finished={0} />)
    expect(screen.getByTestId("mobile-goal-stat-paused").querySelector(".text-amber-600")).toHaveTextContent("3")
  })
})
