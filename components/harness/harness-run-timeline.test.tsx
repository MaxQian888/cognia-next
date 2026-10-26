/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { renderHook } from "@testing-library/react"
import { makeRun, makeRunConfig, makeStep } from "@/lib/harness/test-fixtures"
import { HarnessRunTimeline, useStepLabel } from "./harness-run-timeline"

describe("useStepLabel", () => {
  it("reads every label the way a person would", () => {
    const { result } = renderHook(() => useStepLabel())
    expect(result.current("base2")).toBe("Current harness, run 2")
    expect(result.current("dom1")).toBe("Task-specific edit 1")
    expect(result.current("roll:agg1")).toBe("Rollout of Combined harness 1")
    expect(result.current("select")).toBe("Selection")
  })
})

describe("HarnessRunTimeline", () => {
  it("shows the whole plan, the state of each step, and selects reached steps", () => {
    const onSelect = jest.fn()
    render(
      <HarnessRunTimeline
        run={makeRun({ config: makeRunConfig({ mode: "parallel", k: 1 }) })}
        steps={[
          makeStep("base1"),
          makeStep("inv1", { kind: "propose", status: "running" }),
          makeStep("dom1", { kind: "propose", status: "failed", keptBase: true }),
          makeStep("roll:inv1", { cacheHitOf: "run-1:base1", costUsd: 0.5 }),
        ]}
        selectedLabel="base1"
        onSelect={onSelect}
      />
    )
    expect(screen.getByText("Proposing")).toBeInTheDocument()
    expect(screen.getByTestId("harness-step-base1")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("harness-step-inv1")).toHaveAttribute("data-state", "running")
    expect(screen.getByTestId("harness-step-dom1")).toHaveTextContent("No change")
    expect(screen.getByTestId("harness-step-roll:inv1")).toHaveTextContent("Reused")
    expect(screen.getByTestId("harness-step-roll:inv1")).toHaveTextContent("$0.50")
    // Planned steps not reached yet cannot be opened.
    expect(screen.getByTestId("harness-step-agg1")).toBeDisabled()
    expect(screen.getByTestId("harness-step-agg1")).toHaveAttribute("data-state", "planned")
    fireEvent.click(screen.getByTestId("harness-step-dom1"))
    expect(onSelect).toHaveBeenCalledWith("dom1")
  })

  it("labels sequential rounds", () => {
    render(
      <HarnessRunTimeline
        run={makeRun({ config: makeRunConfig({ mode: "sequential", k: 2 }) })}
        steps={[]}
        onSelect={jest.fn()}
      />
    )
    expect(screen.getByText("Proposing · round 2")).toBeInTheDocument()
  })
})
