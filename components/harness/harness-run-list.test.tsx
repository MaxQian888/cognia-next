/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { emptyLedger } from "@/lib/harness/budget"
import { makeRun, makeTask } from "@/lib/harness/test-fixtures"
import { HarnessRunList } from "./harness-run-list"

describe("HarnessRunList", () => {
  it("lists runs with status, trigger, spend and outcome, and opens one", () => {
    const onSelect = jest.fn()
    render(
      <HarnessRunList
        runs={[
          makeRun({
            id: "r1",
            task: makeTask({ title: "Monthly report" }),
            status: "completed",
            trigger: "failure-triggered",
            ledger: { ...emptyLedger(), costUsd: 1.5, costUnknown: true },
            decision: { outcome: "keep-base", reason: "x", requiresApproval: false },
          }),
          makeRun({ id: "r2", task: makeTask({ title: "Fix parser" }), status: "probing" }),
        ]}
        selectedId="r1"
        onSelect={onSelect}
        showAgent
      />
    )
    expect(screen.getByRole("button", { name: "Open run Monthly report" })).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(screen.getByText("After a failure")).toBeInTheDocument()
    expect(screen.getByText("$1.50+")).toBeInTheDocument()
    expect(screen.getByText("Kept current")).toBeInTheDocument()
    expect(screen.getAllByText("Analyst")).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "Open run Fix parser" }))
    expect(onSelect).toHaveBeenCalledWith("r2")
  })

  it("says when there are no runs", () => {
    render(<HarnessRunList runs={[]} onSelect={jest.fn()} />)
    expect(screen.getByTestId("harness-run-list-empty")).toBeInTheDocument()
  })
})
