/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { makeRun, makeRunConfig } from "@/lib/harness/test-fixtures"
import { HarnessDecisionPanel, HarnessSelectionView } from "./harness-decision-panel"

const decision = {
  outcome: "adopt" as const,
  reason: "agg1 beat every run of the current harness on the checks.",
  chosenLabel: "agg1",
  chosenSnapshotId: "snap-agg1",
  risk: "medium" as const,
  riskReasons: ["skill csv-check added"],
  requiresApproval: true,
}

describe("HarnessDecisionPanel", () => {
  it("explains the choice and its risk, and takes the person's approval", () => {
    const onApprove = jest.fn()
    const onReject = jest.fn()
    render(
      <HarnessDecisionPanel
        run={makeRun({
          status: "awaiting_approval",
          decision,
          projectId: "proj-1",
          config: makeRunConfig({ scope: "workspace" }),
        })}
        onApprove={onApprove}
        onReject={onReject}
      />
    )
    expect(screen.getByText("Adopt Combined harness 1")).toBeInTheDocument()
    expect(screen.getByTestId("harness-decision-risk")).toHaveTextContent("Medium risk")
    expect(screen.getByTestId("harness-risk-reasons")).toHaveTextContent("skill csv-check added")
    expect(screen.getByText("This workspace")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByTestId("harness-approve"))
    expect(onApprove).toHaveBeenCalledWith({ setAsWorkspaceDefault: true })
    fireEvent.click(screen.getByTestId("harness-reject"))
    expect(onReject).toHaveBeenCalled()
  })

  it("reads an adoption after the fact and offers no choice", () => {
    render(
      <HarnessDecisionPanel
        run={makeRun({
          status: "completed",
          decision: { ...decision, requiresApproval: false },
          config: makeRunConfig({ scope: "session" }),
          adoption: {
            scope: "session",
            approvedBy: "auto-low-risk",
            adoptedAt: 5,
            variantCreated: true,
          },
        })}
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />
    )
    expect(screen.getByTestId("harness-adoption")).toHaveTextContent(
      "Adopted (This conversation) automatically as a low-risk change."
    )
    expect(screen.getByTestId("harness-adoption")).toHaveTextContent("evolved variant")
    expect(screen.queryByTestId("harness-approve")).not.toBeInTheDocument()
  })

  it("waits for a decision", () => {
    render(<HarnessDecisionPanel run={makeRun()} />)
    expect(screen.getByText("No decision yet.")).toBeInTheDocument()
  })
})

describe("HarnessSelectionView", () => {
  it("de-anonymizes the judge's ranking", () => {
    render(
      <HarnessSelectionView
        selection={{
          method: "judge",
          regressed: ["agg2"],
          dominant: [],
          unchanged: ["c1"],
          anonymized: { A: "agg1", B: "base" },
          verdict: {
            best: "A",
            ranking: ["A", "B"],
            confidence: "medium",
            evidence: { A: "parsed the file", B: "misread separators" },
          },
        }}
      />
    )
    expect(screen.getByText(/a judge model/)).toBeInTheDocument()
    expect(
      screen.getByText("The judge preferred Combined harness 1 (medium confidence).")
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Did worse than the current harness: Combined harness 2/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Identical to the current harness: Composed harness 1/)
    ).toBeInTheDocument()
    expect(screen.getByText(/misread separators/)).toBeInTheDocument()
  })
})
