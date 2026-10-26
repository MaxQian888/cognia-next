/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { HarnessEvolutionRun, HarnessEvolutionStep } from "@/types/harness/evolution"
import { makeRun, makeStep, makeTask } from "@/lib/harness/test-fixtures"

let mockRun: HarnessEvolutionRun | null | undefined
let mockSteps: HarnessEvolutionStep[] = []
jest.mock("@/hooks/harness/use-harness-data", () => ({
  useHarnessRun: () => mockRun,
  useHarnessSteps: () => mockSteps,
  useHarnessSnapshots: () => new Map(),
  useHarnessLiveLedger: (run: HarnessEvolutionRun | undefined) => run?.ledger,
}))
const actions = {
  busy: null,
  cancel: jest.fn(),
  resume: jest.fn(),
  approve: jest.fn(),
  reject: jest.fn(),
  rollback: jest.fn(),
}
jest.mock("@/hooks/harness/use-harness-run-actions", () => ({
  useHarnessRunActions: () => actions,
}))
let mockActiveHere = false
jest.mock("@/lib/harness/runtime/run-control", () => ({
  isHarnessRunActiveHere: () => mockActiveHere,
}))
jest.mock("@/hooks/fleet/use-now-ticker", () => ({ useNowTicker: () => 1_000_000 }))

import { HarnessRunViewer } from "./harness-run-viewer"

beforeEach(() => {
  mockRun = makeRun({ task: makeTask({ title: "Monthly report" }) })
  mockSteps = []
  mockActiveHere = false
  for (const fn of Object.values(actions)) if (typeof fn === "function") fn.mockReset()
})

describe("HarnessRunViewer", () => {
  it("says when the run is loading or gone", () => {
    mockRun = undefined
    const { rerender } = render(<HarnessRunViewer runId="r" />)
    expect(screen.getByText("Loading run…")).toBeInTheDocument()
    mockRun = null
    rerender(<HarnessRunViewer runId="r" />)
    expect(screen.getByTestId("harness-run-missing")).toBeInTheDocument()
  })

  it("offers resume on an interrupted run and explains what resuming costs", () => {
    mockRun = makeRun({ status: "interrupted" })
    render(<HarnessRunViewer runId="run-1" />)
    expect(screen.getByText(/spends again/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("harness-resume"))
    expect(actions.resume).toHaveBeenCalled()
  })

  it("does not offer resume for a run this process is driving", () => {
    mockRun = makeRun({ status: "probing", owner: { ownerId: "me", leaseExpiresAt: 0 } })
    mockActiveHere = true
    render(<HarnessRunViewer runId="run-1" />)
    expect(screen.queryByTestId("harness-resume")).not.toBeInTheDocument()
    expect(screen.getByTestId("harness-cancel")).toBeInTheDocument()
  })

  it("confirms before cancelling or rolling back", () => {
    mockRun = makeRun({ status: "probing" })
    const { unmount } = render(<HarnessRunViewer runId="run-1" />)
    fireEvent.click(screen.getByTestId("harness-cancel"))
    expect(screen.getByText("Cancel this run?")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("harness-confirm-action"))
    expect(actions.cancel).toHaveBeenCalled()
    unmount()

    mockRun = makeRun({
      status: "completed",
      adoption: { scope: "global", approvedBy: "person", adoptedAt: 1 },
    })
    render(<HarnessRunViewer runId="run-1" />)
    fireEvent.click(screen.getByTestId("harness-rollback"))
    expect(screen.getByText("Roll back this adoption?")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("harness-confirm-action"))
    expect(actions.rollback).toHaveBeenCalled()
  })

  it("opens a waiting run on its decision and passes approval through", () => {
    mockRun = makeRun({
      status: "awaiting_approval",
      decision: {
        outcome: "adopt",
        reason: "agg1 won",
        chosenLabel: "agg1",
        requiresApproval: true,
        risk: "high",
      },
    })
    mockSteps = [
      makeStep("select", {
        kind: "select",
        selection: { method: "deterministic", regressed: [], dominant: ["agg1"], unchanged: [] },
      }),
    ]
    render(<HarnessRunViewer runId="run-1" />)
    expect(screen.getByTestId("harness-decision")).toHaveTextContent("agg1 won")
    expect(screen.getByTestId("harness-selection")).toHaveTextContent("Beat every run")
    fireEvent.click(screen.getByTestId("harness-approve"))
    expect(actions.approve).toHaveBeenCalledWith({ setAsWorkspaceDefault: false })
    fireEvent.click(screen.getByTestId("harness-reject"))
    expect(actions.reject).toHaveBeenCalled()
  })

  it("shows the task, failures, and a picked step's detail", () => {
    mockRun = makeRun({
      status: "failed",
      error: "The agent was edited during the run.",
      stopReason: "converged",
      retrievedExperienceIds: ["e1", "e2"],
    })
    mockSteps = [makeStep("base1", { error: "boom", status: "failed" })]
    render(<HarnessRunViewer runId="run-1" />)
    expect(screen.getByTestId("harness-run-error")).toHaveTextContent("edited during the run")
    expect(screen.getByText("Stopped early: converged")).toBeInTheDocument()
    expect(
      screen.getByText("2 lessons from the library were given to the editors.")
    ).toBeInTheDocument()
    expect(screen.getByText("Pick a step to see its evidence.")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("harness-step-base1"))
    expect(screen.getByTestId("harness-step-detail")).toHaveTextContent("boom")
  })
})
