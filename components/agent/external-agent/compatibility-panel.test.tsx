/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from "@testing-library/react"

import en from "@/i18n/messages/en.json"
import type { ExternalAgentBenchmarkCapabilityEntry } from "@/types/agent/external-agent"
import { ExternalAgentCompatibilityPanel } from "./compatibility-panel"

const diag = en.externalAgent.manager.diagnostics

function entry(
  overrides: Partial<ExternalAgentBenchmarkCapabilityEntry>
): ExternalAgentBenchmarkCapabilityEntry {
  return {
    id: "e",
    title: "Entry",
    referenceBehavior: "Reference does X.",
    cogniaBehavior: "Cognia does Y.",
    adaptationTarget: "manager",
    gapGrade: "minor",
    status: "validated",
    evidence: [],
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  }
}

describe("ExternalAgentCompatibilityPanel", () => {
  it("explains the list and says so when it is empty", () => {
    render(<ExternalAgentCompatibilityPanel entries={[]} />)
    expect(screen.getByText(diag.compatibilityDesc)).toBeInTheDocument()
    expect(screen.getByText(diag.noBenchmarkAdaptation)).toBeInTheDocument()
    expect(screen.queryByTestId("compatibility-summary")).not.toBeInTheDocument()
  })

  it("counts entries per status and lists what needs attention first", () => {
    render(
      <ExternalAgentCompatibilityPanel
        entries={[
          entry({ id: "a", title: "Done one", status: "validated" }),
          entry({ id: "b", title: "Working", status: "in-progress", gapGrade: "blocking" }),
          entry({ id: "c", title: "Done two", status: "validated" }),
        ]}
      />
    )
    const summary = screen.getByTestId("compatibility-summary")
    expect(
      within(summary).getByText(diag.compatibilityStatus["in-progress"]).parentElement
    ).toHaveTextContent("1")
    expect(
      within(summary).getByText(diag.compatibilityStatus.validated).parentElement
    ).toHaveTextContent("2")
    expect(within(summary).queryByText(diag.compatibilityStatus["not-started"])).toBeNull()

    const rows = screen.getAllByTestId(/^compatibility-entry-/)
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "compatibility-entry-b",
      "compatibility-entry-a",
      "compatibility-entry-c",
    ])
    expect(within(rows[0]).getByText(diag.gapGrade.blocking)).toBeInTheDocument()
  })

  it("keeps details behind each entry's own toggle", () => {
    render(
      <ExternalAgentCompatibilityPanel
        entries={[
          entry({
            id: "a",
            title: "Validated thing",
            evidence: [
              {
                id: "ev",
                kind: "test",
                summary: "covered",
                reference: "lib/x.test.ts",
                recordedAt: new Date(),
              },
            ],
          }),
        ]}
      />
    )
    const toggle = screen.getByRole("button", { name: /Validated thing/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("lib/x.test.ts")).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Reference does X.")).toBeInTheDocument()
    expect(screen.getByText("Cognia does Y.")).toBeInTheDocument()
    expect(screen.getByText("lib/x.test.ts")).toBeInTheDocument()
  })

  it("shows a deviation's reasoning, and the reviewer as plain text without a link", () => {
    render(
      <ExternalAgentCompatibilityPanel
        entries={[
          entry({
            id: "d",
            title: "Deviation",
            status: "intentional-deviation",
            deviation: {
              rationale: "Keep chats going.",
              tradeOff: "Lineage may split.",
              userImpact: "No hard failure.",
              review: { reviewedBy: "@runtime", reviewedAt: new Date() },
            },
          }),
        ]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Deviation/ }))
    expect(screen.getByText("Keep chats going.")).toBeInTheDocument()
    expect(screen.getByText("Lineage may split.")).toBeInTheDocument()
    expect(screen.getByText("No hard failure.")).toBeInTheDocument()
    expect(screen.getByText("@runtime")).toBeInTheDocument()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    // Evidence is only meaningful for a validated entry.
    expect(screen.queryByText(diag.compatibilityField.evidence)).not.toBeInTheDocument()
  })
})
