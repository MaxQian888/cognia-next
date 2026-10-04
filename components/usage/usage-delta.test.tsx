/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { UsageDelta } from "./usage-delta"

describe("UsageDelta", () => {
  it("renders a muted dash with an explanation when there is no baseline", () => {
    render(<UsageDelta change={null} testid="d" />)
    const chip = screen.getByTestId("d")
    expect(chip).toHaveTextContent("—")
    expect(chip).toHaveAttribute("data-direction", "none")
    expect(chip).toHaveAttribute("aria-label", "No comparable data in the previous period")
  })

  it("colours a cost increase as a warning and a decrease as an improvement", () => {
    const { rerender } = render(<UsageDelta change={0.234} polarity="lower-is-better" testid="d" />)
    expect(screen.getByTestId("d")).toHaveTextContent("+23%")
    expect(screen.getByTestId("d")).toHaveAttribute("data-direction", "up")
    expect(screen.getByTestId("d").className).toContain("text-amber-600")
    expect(screen.getByTestId("d")).toHaveAttribute("aria-label", "Up 23% vs the previous period")

    rerender(<UsageDelta change={-0.05} polarity="lower-is-better" testid="d" />)
    expect(screen.getByTestId("d")).toHaveTextContent("−5.0%")
    expect(screen.getByTestId("d").className).toContain("text-emerald-600")
  })

  it("keeps volume figures neutral and treats sub-0.5% moves as flat", () => {
    const { rerender } = render(<UsageDelta change={0.5} testid="d" />)
    expect(screen.getByTestId("d").className).toContain("text-muted-foreground")
    rerender(<UsageDelta change={0.004} polarity="lower-is-better" testid="d" />)
    expect(screen.getByTestId("d")).toHaveAttribute("data-direction", "flat")
    expect(screen.getByTestId("d")).toHaveTextContent("0%")
  })

  it("formats percentage-point changes", () => {
    render(<UsageDelta change={12.4} unit="points" polarity="higher-is-better" testid="d" />)
    expect(screen.getByTestId("d")).toHaveTextContent("+12 pts")
    expect(screen.getByTestId("d").className).toContain("text-emerald-600")
  })
})
