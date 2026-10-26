/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { HarnessRunStatusBadge } from "./harness-run-status-badge"

describe("HarnessRunStatusBadge", () => {
  it("translates the status and tones it", () => {
    const { rerender } = render(<HarnessRunStatusBadge status="awaiting_approval" />)
    expect(screen.getByTestId("harness-run-status")).toHaveTextContent("Awaiting approval")
    expect(screen.getByTestId("harness-run-status")).toHaveAttribute("data-tone", "attention")
    rerender(<HarnessRunStatusBadge status="probing" />)
    expect(screen.getByTestId("harness-run-status")).toHaveAttribute("data-tone", "working")
    rerender(<HarnessRunStatusBadge status="budget_exceeded" />)
    expect(screen.getByTestId("harness-run-status")).toHaveTextContent("Budget exhausted")
    expect(screen.getByTestId("harness-run-status")).toHaveAttribute("data-tone", "bad")
  })
})
