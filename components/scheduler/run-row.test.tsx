import { fireEvent, render, renderHook, screen } from "@testing-library/react"

import { RunRow, useRunRelativeTime } from "./run-row"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

function run(overrides: Partial<UnifiedExecutionRun> = {}): UnifiedExecutionRun {
  return {
    unifiedId: "app:r1",
    kind: "app",
    itemUnifiedId: "app:t1",
    itemName: "Nightly build",
    status: "succeeded",
    startedAt: Date.now() - 5 * 60_000,
    finishedAt: Date.now(),
    durationMs: 12_500,
    origin: { tableName: "scheduledTaskRuns", nativeId: "r1" },
    ...overrides,
  }
}

describe("RunRow", () => {
  it("opens the run from the row and shows a human duration", () => {
    const onOpen = jest.fn()
    render(<RunRow run={run()} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole("button"))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ unifiedId: "app:r1" }))
    expect(screen.getByTestId("run-row-duration")).toHaveTextContent("12.5s")
    expect(screen.queryByTestId("run-row-error")).not.toBeInTheDocument()
    expect(screen.queryByTestId("run-row-trigger-source")).not.toBeInTheDocument()
  })

  it("names the item and kind when the list mixes items", () => {
    render(
      <RunRow
        run={run({ kind: "workflow", triggerSource: "run-now" })}
        onOpen={jest.fn()}
        showItem
      />
    )
    expect(screen.getByText("Nightly build")).toBeInTheDocument()
    expect(screen.getByTestId("run-row-trigger-source")).toHaveTextContent("Manual")
  })

  it("carries the error on a failed row", () => {
    render(
      <RunRow run={run({ status: "failed", error: { message: "disk full" } })} onOpen={jest.fn()} />
    )
    expect(screen.getByTestId("run-row-error")).toHaveTextContent("disk full")
    expect(screen.getByTestId("run-status-failed")).toBeInTheDocument()
  })

  describe("a run that stopped for approval", () => {
    const blocked = (result: unknown) =>
      run({
        status: "failed",
        terminalReason: "needs-approval",
        error: { message: "needs approval: Bash" },
        result,
      })

    it("reads as needing approval, naming the tools and roots, not as a crash", () => {
      render(
        <RunRow
          run={blocked({
            status: "needs_approval",
            needsApproval: [{ toolName: "Bash" }, { toolName: "Edit" }, { toolName: "Bash" }],
            workspaceTrust: { restricted: true, untrustedRoots: ["/repo"] },
          })}
          onOpen={jest.fn()}
        />
      )
      expect(screen.getByTestId("run-status-needs-approval")).toHaveTextContent("Needs approval")
      expect(screen.queryByTestId("run-status-failed")).not.toBeInTheDocument()
      expect(screen.queryByTestId("run-row-error")).not.toBeInTheDocument()
      expect(screen.getByTestId("run-row-approval")).toHaveTextContent(
        "Needs approval for Bash, Edit · Workspace not trusted: /repo"
      )
      expect(screen.getByTestId("run-row-app:r1")).toHaveAttribute(
        "data-terminal-reason",
        "needs-approval"
      )
    })

    it("says when trust could not be checked rather than refused", () => {
      render(
        <RunRow
          run={blocked({
            needsApproval: [],
            workspaceTrust: { restricted: true, untrustedRoots: ["/repo"], unverified: true },
          })}
          onOpen={jest.fn()}
        />
      )
      expect(screen.getByTestId("run-row-approval")).toHaveTextContent(
        "Could not check trust for /repo"
      )
    })

    it("still says why when the result was not kept", () => {
      render(<RunRow run={blocked(undefined)} onOpen={jest.fn()} />)
      expect(screen.getByTestId("run-row-approval")).toHaveTextContent("Stopped for your approval")
    })
  })

  it("offers Stop only on a running row when the caller can cancel", () => {
    const onCancel = jest.fn()
    const { rerender } = render(
      <RunRow
        run={run({ status: "running", durationMs: undefined })}
        onOpen={jest.fn()}
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByTestId("run-row-cancel"))
    expect(onCancel).toHaveBeenCalled()
    expect(screen.getByTestId("run-row-duration")).toHaveTextContent("…")
    rerender(<RunRow run={run()} onOpen={jest.fn()} onCancel={onCancel} />)
    expect(screen.queryByTestId("run-row-cancel")).not.toBeInTheDocument()
  })

  it("phrases relative time by magnitude", () => {
    const { result } = renderHook(() => useRunRelativeTime())
    const now = Date.now()
    expect(result.current(now - 10_000)).toBe("just now")
    expect(result.current(now - 3 * 60_000)).toBe("3m ago")
    expect(result.current(now - 2 * 3_600_000)).toBe("2h ago")
    expect(result.current(now - 3 * 86_400_000)).toBe("3d ago")
    expect(result.current(now - 30 * 86_400_000)).not.toMatch(/ago/)
  })
})
