/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { StatCard } from "./stat-card"

function makeProps(overrides: Partial<React.ComponentProps<typeof StatCard>> = {}) {
  return {
    label: "Active",
    value: 7,
    icon: <span data-testid="stat-icon" />,
    accentGradient: "from-green-500 to-emerald-400",
    iconBgClassName: "bg-green-500/10",
    ...overrides,
  }
}

describe("StatCard", () => {
  it("renders the label, value, and icon", () => {
    render(<StatCard {...makeProps()} />)
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByText("7")).toBeInTheDocument()
    expect(screen.getByTestId("stat-icon")).toBeInTheDocument()
  })

  it("uses the md layout by default (text-2xl value)", () => {
    render(<StatCard {...makeProps()} />)
    expect(screen.getByText("7")).toHaveClass("text-2xl")
  })

  it("uses the sm layout when size='sm'", () => {
    render(<StatCard {...makeProps()} size="sm" />)
    expect(screen.getByText("7")).toHaveClass("text-xl")
  })

  it("applies the valueClassName for color tinting", () => {
    render(<StatCard {...makeProps()} valueClassName="text-green-500" />)
    expect(screen.getByText("7")).toHaveClass("text-green-500")
  })

  it("forwards the testid prop to the outer Card", () => {
    render(<StatCard {...makeProps()} testid="my-stat" />)
    expect(screen.getByTestId("my-stat")).toBeInTheDocument()
  })

  it("composes additional className tokens", () => {
    render(<StatCard {...makeProps()} className="ring-2" testid="ring-card" />)
    expect(screen.getByTestId("ring-card")).toHaveClass("ring-2")
  })

  it("paints the accent gradient at the bottom of the card", () => {
    render(
      <StatCard {...makeProps()} testid="grad-card" accentGradient="from-blue-500 to-sky-400" />
    )
    const card = screen.getByTestId("grad-card")
    const accent = card.querySelector(".bg-gradient-to-r")
    expect(accent).toHaveClass("from-blue-500")
    expect(accent).toHaveClass("to-sky-400")
  })
})
