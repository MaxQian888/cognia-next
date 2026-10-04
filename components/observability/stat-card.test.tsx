/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { ActivityIcon } from "lucide-react"
import { StatCard } from "./stat-card"

describe("StatCard", () => {
  it("renders label and value", () => {
    render(<StatCard icon={ActivityIcon} label="Workers" value={4} />)
    expect(screen.getByText("Workers")).toBeInTheDocument()
    expect(screen.getByText("4")).toBeInTheDocument()
  })

  it("renders the optional sub line", () => {
    render(<StatCard icon={ActivityIcon} label="CPU" value="42%" sub="2 cores" />)
    expect(screen.getByText("2 cores")).toBeInTheDocument()
  })

  it("omits the sub line when not provided", () => {
    const { container } = render(<StatCard icon={ActivityIcon} label="CPU" value="42%" />)
    // Only the label is a muted-foreground line; no sub paragraph follows.
    expect(container.querySelectorAll("p.text-muted-foreground")).toHaveLength(1)
  })

  it("applies a custom color chip class", () => {
    const { container } = render(
      <StatCard icon={ActivityIcon} label="X" value={1} color="bg-chart-1/10 text-chart-1" />
    )
    expect(container.querySelector(".bg-chart-1\\/10")).toBeTruthy()
  })

  it("falls back to the primary color chip", () => {
    const { container } = render(<StatCard icon={ActivityIcon} label="X" value={1} />)
    expect(container.querySelector(".bg-primary\\/10")).toBeTruthy()
  })

  it("forwards a data-testid", () => {
    render(<StatCard icon={ActivityIcon} label="X" value={1} data-testid="my-card" />)
    expect(screen.getByTestId("my-card")).toBeInTheDocument()
  })

  it.each(["up", "down", "stable"] as const)("renders the %s trend arrow", (trend) => {
    const { container } = render(<StatCard icon={ActivityIcon} label="X" value={1} trend={trend} />)
    // Two svgs: the chip icon + the trend arrow.
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2)
  })

  it("is a plain tile, not a control, without onClick", () => {
    render(<StatCard icon={ActivityIcon} label="X" value={1} />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("becomes a focusable button that fires onClick with the action as its tooltip", () => {
    const onClick = jest.fn()
    render(
      <StatCard
        icon={ActivityIcon}
        label="Error rate"
        value="4%"
        onClick={onClick}
        actionLabel="Show errors"
      />
    )
    const button = screen.getByRole("button", { name: /Error rate.*4%.*Show errors/ })
    expect(button).toHaveAttribute("type", "button")
    expect(button).toHaveAttribute("title", "Show errors")
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
