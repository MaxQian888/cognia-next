import { render, screen } from "@testing-library/react"

import { RunPhaseBreakdown } from "./run-phase-breakdown"

describe("RunPhaseBreakdown", () => {
  it("lists each phase in order with its label, duration and outcome", () => {
    render(
      <RunPhaseBreakdown
        phases={[
          { name: "fire-delay", startOffsetMs: -40, durationMs: 40 },
          { name: "environment-setup", startOffsetMs: 10, durationMs: 3, outcome: "reused" },
          { name: "turn", startOffsetMs: 20, durationMs: 8_200 },
        ]}
      />
    )
    expect(screen.getByText("Where the time went")).toBeInTheDocument()
    const rows = screen.getAllByRole("listitem")
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "run-phase-fire-delay",
      "run-phase-environment-setup",
      "run-phase-turn",
    ])
    expect(rows[0]).toHaveTextContent("Fire delay")
    expect(rows[0]).toHaveTextContent("40ms")
    expect(rows[1]).toHaveTextContent("Environment setup")
    expect(rows[1]).toHaveTextContent("reused")
    expect(rows[2]).toHaveTextContent("Agent turn")
    expect(rows[2]).toHaveTextContent("8.2s")
  })

  it("scales bars to the longest phase", () => {
    render(
      <RunPhaseBreakdown
        phases={[
          { name: "session", startOffsetMs: 0, durationMs: 500 },
          { name: "turn", startOffsetMs: 500, durationMs: 1_000 },
        ]}
      />
    )
    const bar = (name: string) =>
      screen.getByTestId(`run-phase-${name}`).querySelector("span[style]") as HTMLElement
    expect(bar("turn").style.width).toBe("100%")
    expect(bar("session").style.width).toBe("50%")
  })

  it("renders nothing without phases", () => {
    const { container } = render(<RunPhaseBreakdown phases={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
