/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import { SquadGatePart } from "./squad-gate-part"
import type { SquadGatePart as SquadGatePartType } from "@/lib/claude/parts-extensions"

function part(over: Partial<SquadGatePartType> = {}): SquadGatePartType {
  return {
    type: "squad-gate",
    runId: "execution:team:run_1",
    gateType: "budget",
    decision: "approved",
    title: "Budget exceeded — continue?",
    answeredAt: 1000,
    ...over,
  }
}

describe("SquadGatePart", () => {
  it("shows the gate's own wording, not a re-description of it", () => {
    // The reader answered a dialog with this exact title.
    render(<SquadGatePart part={part()} />)
    expect(screen.getByTestId("squad-gate-part")).toHaveTextContent("Budget exceeded — continue?")
  })

  it("names the decision and exposes it for styling", () => {
    for (const [decision, label] of [
      ["approved", "Approved"],
      ["rejected", "Rejected"],
      ["dismissed", "Dismissed"],
    ] as const) {
      const { unmount } = render(<SquadGatePart part={part({ decision })} />)
      const node = screen.getByTestId("squad-gate-part")
      expect(node).toHaveTextContent(label)
      expect(node).toHaveAttribute("data-decision", decision)
      unmount()
    }
  })

  it("links back to the run the decision applied to", () => {
    render(<SquadGatePart part={part()} />)
    expect(screen.getByTestId("squad-gate-open-run")).toHaveAttribute(
      "href",
      "/agent-runs?run=execution%3Ateam%3Arun_1"
    )
  })
})
