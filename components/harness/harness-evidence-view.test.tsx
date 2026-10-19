/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { makeEvidence } from "@/lib/harness/test-fixtures"
import { HarnessEvidenceView } from "./harness-evidence-view"

describe("HarnessEvidenceView", () => {
  it("shows outcome, checks, metrics, blocked actions and caveats", () => {
    render(
      <HarnessEvidenceView
        evidence={makeEvidence({
          delivered: false,
          degraded: true,
          error: "turn limit reached",
          validation: [
            { check: "deliverable report.md", passed: false, status: "failed", detail: "missing" },
            { check: "acceptance unit", passed: false, status: "inconclusive" },
          ],
          blockedActions: [{ toolName: "WebFetch", reason: "network is off during probes" }],
          caveats: ["tool rules observed, not enforced"],
          delegations: ["researcher"],
          externalReads: ["mcp__github__get_issue"],
          metrics: { ...makeEvidence().metrics, costUsd: undefined, toolFailures: 2 },
        })}
      />
    )
    expect(screen.getByText("Not delivered")).toBeInTheDocument()
    expect(screen.getByText("Degraded run")).toBeInTheDocument()
    expect(screen.getByText("turn limit reached")).toBeInTheDocument()
    expect(screen.getByTestId("harness-evidence-checks")).toHaveTextContent("Failed")
    expect(screen.getByTestId("harness-evidence-checks")).toHaveTextContent("Inconclusive")
    expect(screen.getByText("Unpriced")).toBeInTheDocument()
    expect(screen.getByText("3 calls, 2 failed")).toBeInTheDocument()
    expect(screen.getByText("WebFetch")).toBeInTheDocument()
    expect(screen.getByTestId("harness-evidence-caveats")).toHaveTextContent("not enforced")
    expect(screen.getByText("Delegated to: researcher")).toBeInTheDocument()
    expect(screen.getByTestId("harness-evidence-external")).toHaveTextContent(
      "mcp__github__get_issue"
    )
    expect(screen.getByTestId("harness-evidence-output")).toHaveTextContent("Wrote report.md")
  })

  it("keeps the trajectory folded until asked", () => {
    render(<HarnessEvidenceView evidence={makeEvidence()} />)
    expect(screen.queryByTestId("harness-evidence-external")).not.toBeInTheDocument()
    expect(screen.queryByTestId("harness-evidence-trajectory")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Full trajectory"))
    expect(screen.getByTestId("harness-evidence-trajectory")).toHaveTextContent("[ACTION] Write")
    fireEvent.click(screen.getByText("Files produced (1)"))
    expect(screen.getByText("# Report")).toBeInTheDocument()
  })
})
