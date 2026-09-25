/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

// Stub Sheet primitives to render inline so we can assert on contents.
jest.mock("@/components/ui/sheet")

jest.mock("@/components/workflow/runs/run-status-pill", () => ({
  RunStatusPill: ({ status }: { status: string }) => <span data-testid="stub-pill">{status}</span>,
}))

import { RunDetailSheet, runProgressFraction } from "./run-detail-sheet"

function makeRun(overrides: Partial<UnifiedExecutionRun> = {}): UnifiedExecutionRun {
  return {
    unifiedId: "app:run-1",
    kind: "app",
    itemUnifiedId: "app:task-1",
    itemName: "Daily summary",
    status: "succeeded",
    startedAt: Date.parse("2026-05-10T09:00:00Z"),
    finishedAt: Date.parse("2026-05-10T09:00:05Z"),
    durationMs: 5_000,
    payload: { prompt: "hi" },
    result: { reply: "ok" },
    logs: [
      { ts: Date.parse("2026-05-10T09:00:01Z"), level: "info", message: "started" },
      { ts: Date.parse("2026-05-10T09:00:02Z"), level: "warn", message: "noted" },
    ],
    origin: { tableName: "scheduledTaskRuns", nativeId: "run-1" },
    ...overrides,
  }
}

describe("RunDetailSheet", () => {
  it("renders nothing when run is null", () => {
    const { container } = render(<RunDetailSheet open onOpenChange={() => {}} run={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when open is false", () => {
    const { container } = render(
      <RunDetailSheet open={false} onOpenChange={() => {}} run={makeRun()} />
    )
    expect(container.querySelector("[role='dialog']")).toBeNull()
  })

  it("names the item as a link back, with the pill, kind, payload, result and human duration", () => {
    const onOpenItem = jest.fn()
    render(<RunDetailSheet open onOpenChange={() => {}} run={makeRun()} onOpenItem={onOpenItem} />)
    fireEvent.click(screen.getByTestId("run-sheet-open-item"))
    expect(onOpenItem).toHaveBeenCalledWith("app:task-1")
    expect(screen.getByTestId("stub-pill")).toHaveTextContent("succeeded")
    expect(screen.getByText("App")).toBeInTheDocument()
    expect(screen.getByTestId("run-sheet-payload")).toHaveTextContent("prompt")
    expect(screen.getByTestId("run-sheet-result")).toHaveTextContent("reply")
    expect(screen.getByText("5.0s")).toBeInTheDocument()
    expect(screen.queryByTestId("run-sheet-previous")).not.toBeInTheDocument()
  })

  it("walks the list it came from", () => {
    const runs = [
      makeRun({ unifiedId: "app:a" }),
      makeRun({ unifiedId: "app:b" }),
      makeRun({ unifiedId: "app:c" }),
    ]
    const onNavigate = jest.fn()
    render(
      <RunDetailSheet
        open
        onOpenChange={() => {}}
        run={runs[1]}
        runs={runs}
        onNavigate={onNavigate}
      />
    )
    expect(screen.getByText("2 of 3")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("run-sheet-previous"))
    expect(onNavigate).toHaveBeenLastCalledWith(runs[0])
    fireEvent.click(screen.getByTestId("run-sheet-next"))
    expect(onNavigate).toHaveBeenLastCalledWith(runs[2])
    render(
      <RunDetailSheet
        open
        onOpenChange={() => {}}
        run={runs[0]}
        runs={runs}
        onNavigate={onNavigate}
      />
    )
    expect(screen.getAllByTestId("run-sheet-previous")[1]).toBeDisabled()
  })

  it("shows a trigger-source badge only when the run carries provenance", () => {
    const { rerender } = render(
      <RunDetailSheet open onOpenChange={() => {}} run={makeRun({ triggerSource: "backfill" })} />
    )
    expect(screen.getByText("Backfill")).toBeInTheDocument()
    rerender(<RunDetailSheet open onOpenChange={() => {}} run={makeRun()} />)
    expect(screen.queryByText("Backfill")).not.toBeInTheDocument()
  })

  it("hides the result block and shows the error block when the run failed", () => {
    render(
      <RunDetailSheet
        open
        onOpenChange={() => {}}
        run={makeRun({
          status: "failed",
          result: undefined,
          error: { message: "boom", code: "timeout" },
        })}
      />
    )
    expect(screen.queryByTestId("run-sheet-result")).toBeNull()
    const err = screen.getByTestId("run-sheet-error")
    expect(err).toHaveTextContent("boom")
    expect(err).toHaveTextContent("timeout")
    expect(screen.queryByTestId("run-sheet-stack")).toBeNull()
  })

  describe("a run that stopped for approval", () => {
    const blocked = (result: unknown) =>
      makeRun({
        status: "failed",
        terminalReason: "needs-approval",
        error: { message: "needs approval: Bash; workspace not trusted (/repo)" },
        result,
      })

    it("says what it waited on and how to clear it, instead of an error block", () => {
      render(
        <RunDetailSheet
          open
          onOpenChange={() => {}}
          run={blocked({
            sessionId: "session-1",
            status: "needs_approval",
            needsApproval: [{ toolName: "Bash" }, { toolName: "Edit" }],
            workspaceTrust: { restricted: true, untrustedRoots: ["/repo", "/docs"] },
          })}
          onOpenSession={jest.fn()}
        />
      )
      expect(screen.getByTestId("run-status-needs-approval")).toHaveTextContent("Needs approval")
      expect(screen.queryByTestId("stub-pill")).toBeNull()
      expect(screen.queryByTestId("run-sheet-error")).toBeNull()

      const section = screen.getByTestId("run-sheet-approval")
      expect(section).toHaveTextContent("Waiting for your approval")
      expect(section).toHaveTextContent("It was not retried")
      expect(screen.getByTestId("run-sheet-approval-tools")).toHaveTextContent("Bash, Edit")
      expect(screen.getByTestId("run-sheet-approval-tools")).toHaveTextContent(
        "allowed tools, or raise its permission mode"
      )
      const roots = screen.getByTestId("run-sheet-approval-roots")
      expect(roots).toHaveTextContent("Untrusted workspace roots")
      expect(roots).toHaveTextContent("/repo")
      expect(roots).toHaveTextContent("/docs")
      expect(roots).toHaveTextContent("Trust the workspace")
    })

    it("keeps the session link and result, where the user sees what it tried", () => {
      const onOpenSession = jest.fn()
      render(
        <RunDetailSheet
          open
          onOpenChange={() => {}}
          run={blocked({ sessionId: "session-1", status: "needs_approval", needsApproval: [] })}
          onOpenSession={onOpenSession}
        />
      )
      expect(screen.getByTestId("run-artifact-links")).toBeInTheDocument()
      expect(screen.getByTestId("run-sheet-result")).toHaveTextContent("needs_approval")
    })

    it("labels roots whose trust could not be checked as such", () => {
      render(
        <RunDetailSheet
          open
          onOpenChange={() => {}}
          run={blocked({
            needsApproval: [],
            workspaceTrust: { restricted: true, untrustedRoots: ["/repo"], unverified: true },
          })}
        />
      )
      expect(screen.queryByTestId("run-sheet-approval-tools")).toBeNull()
      expect(screen.getByTestId("run-sheet-approval-roots")).toHaveTextContent(
        "Roots whose trust could not be checked"
      )
    })

    it("falls back to the recorded reason when the result was not kept", () => {
      render(<RunDetailSheet open onOpenChange={() => {}} run={blocked(undefined)} />)
      expect(screen.getByTestId("run-sheet-approval")).toHaveTextContent(
        "needs approval: Bash; workspace not trusted (/repo)"
      )
      expect(screen.queryByTestId("run-sheet-result")).toBeNull()
    })
  })

  it("keeps a stack trace behind a closed, bounded disclosure", () => {
    render(
      <RunDetailSheet
        open
        onOpenChange={() => {}}
        run={makeRun({
          status: "failed",
          result: undefined,
          error: { message: "boom", stack: "at a()\nat b()" },
        })}
      />
    )
    const stack = screen.getByTestId("run-sheet-stack")
    expect(stack).toHaveAttribute("data-state", "closed")
    fireEvent.click(screen.getByRole("button", { name: "Stack trace" }))
    expect(stack).toHaveAttribute("data-state", "open")
    const pre = stack.querySelector("pre")!
    expect(pre.className).toContain("max-h-64")
    expect(pre.className).toContain("overflow-auto")
    expect(pre.className).toContain("break-words")
  })

  it("logs are collapsed by default, reveal on toggle, and colour every level", () => {
    render(
      <RunDetailSheet
        open
        onOpenChange={() => {}}
        run={makeRun({
          logs: [
            { ts: 0, level: "debug", message: "dbg" },
            { ts: 1, level: "info", message: "inf" },
            { ts: 2, level: "warn", message: "wrn" },
            { ts: 3, level: "error", message: "err" },
          ],
        })}
      />
    )
    expect(screen.queryByTestId("run-sheet-logs")).toBeNull()
    fireEvent.click(screen.getByTestId("run-sheet-logs-toggle"))
    const logs = screen.getByTestId("run-sheet-logs")
    expect(logs.querySelector(".text-blue-500")).not.toBeNull()
    expect(logs.querySelector(".text-yellow-500")).not.toBeNull()
    expect(logs.querySelector(".text-red-500")).not.toBeNull()
  })

  it("falls back to String() for a payload JSON.stringify cannot serialize", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    render(
      <RunDetailSheet
        open
        onOpenChange={() => {}}
        run={makeRun({ payload: circular, result: undefined })}
      />
    )
    expect(screen.getByTestId("run-sheet-payload")).toHaveTextContent("[object Object]")
  })

  it("hides the logs section entirely when the run has no logs", () => {
    render(<RunDetailSheet open onOpenChange={() => {}} run={makeRun({ logs: undefined })} />)
    expect(screen.queryByTestId("run-sheet-logs-toggle")).toBeNull()
  })

  it("shows a running plugin run's progress from its newest progress line", () => {
    const run = makeRun({
      status: "running",
      finishedAt: undefined,
      durationMs: undefined,
      logs: [
        { ts: 0, level: "info", message: "25% — fetching" },
        { ts: 1, level: "info", message: "60% — indexing" },
      ],
    })
    expect(runProgressFraction(run)).toBe(0.6)
    expect(runProgressFraction(makeRun())).toBeNull()
    render(<RunDetailSheet open onOpenChange={() => {}} run={run} />)
    expect(screen.getByTestId("run-sheet-progress")).toHaveTextContent("60% done")
    expect(screen.getAllByText("still running").length).toBeGreaterThan(0)
  })

  it("close button fires onOpenChange(false)", () => {
    const onOpenChange = jest.fn()
    render(<RunDetailSheet open onOpenChange={onOpenChange} run={makeRun()} />)
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("RunDetailSheet · stopping a run from where it is read", () => {
  it("offers Stop on a running run and hands the run back", () => {
    const onCancelRun = jest.fn()
    const run = makeRun({ status: "running", finishedAt: undefined })
    render(<RunDetailSheet open onOpenChange={jest.fn()} run={run} onCancelRun={onCancelRun} />)
    fireEvent.click(screen.getByTestId("run-sheet-stop"))
    expect(onCancelRun).toHaveBeenCalledWith(run)
  })

  it("has no Stop for a finished run, or without a way to stop", () => {
    const { rerender } = render(
      <RunDetailSheet open onOpenChange={jest.fn()} run={makeRun()} onCancelRun={jest.fn()} />
    )
    expect(screen.queryByTestId("run-sheet-stop")).not.toBeInTheDocument()
    rerender(<RunDetailSheet open onOpenChange={jest.fn()} run={makeRun({ status: "running" })} />)
    expect(screen.queryByTestId("run-sheet-stop")).not.toBeInTheDocument()
  })
})
