/** @jest-environment jsdom */

import { useState } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { SchedulerErrorBoundary } from "./scheduler-error-boundary"

function BoomComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("boom — testing boundary")
  }
  return <span>rendered fine</span>
}

/** Harness that fixes the throwing child only after onReset fires. */
function RetryHarness() {
  const [throwing, setThrowing] = useState(true)
  return (
    <SchedulerErrorBoundary onReset={() => setThrowing(false)}>
      <BoomComponent shouldThrow={throwing} />
    </SchedulerErrorBoundary>
  )
}

describe("SchedulerErrorBoundary", () => {
  let consoleErrorSpy: jest.SpyInstance

  beforeEach(() => {
    // React logs caught errors to console.error in dev — silence to keep
    // the test output readable.
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it("renders children when no error occurs", () => {
    render(
      <SchedulerErrorBoundary>
        <BoomComponent shouldThrow={false} />
      </SchedulerErrorBoundary>
    )
    expect(screen.getByText("rendered fine")).toBeInTheDocument()
  })

  it("renders PanelErrorState when a child throws", () => {
    render(
      <SchedulerErrorBoundary>
        <BoomComponent shouldThrow={true} />
      </SchedulerErrorBoundary>
    )
    expect(screen.getByTestId("scheduler-panel-error")).toBeInTheDocument()
    expect(screen.getByText("boom — testing boundary")).toBeInTheDocument()
  })

  it("renders a custom fallback when provided", () => {
    render(
      <SchedulerErrorBoundary fallback={<div data-testid="custom-fallback">custom</div>}>
        <BoomComponent shouldThrow={true} />
      </SchedulerErrorBoundary>
    )
    expect(screen.getByTestId("custom-fallback")).toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-panel-error")).not.toBeInTheDocument()
  })

  it("resets the error state and calls onReset when retry is clicked", () => {
    render(<RetryHarness />)
    expect(screen.getByTestId("scheduler-panel-error")).toBeInTheDocument()

    // Retry click fires onReset (which flips the harness to stop throwing)
    // AND clears the boundary's internal error state. On the next render the
    // non-throwing child mounts cleanly.
    fireEvent.click(screen.getByTestId("scheduler-panel-error-retry"))
    expect(screen.getByText("rendered fine")).toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-panel-error")).not.toBeInTheDocument()
  })

  it("logs with the panel name when supplied", () => {
    render(
      <SchedulerErrorBoundary panelName="dashboard">
        <BoomComponent shouldThrow={true} />
      </SchedulerErrorBoundary>
    )
    const logged = consoleErrorSpy.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("[dashboard]")
    )
    expect(logged).toBe(true)
  })
})
