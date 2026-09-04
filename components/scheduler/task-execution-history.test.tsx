/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import { TaskExecutionHistory } from "./task-execution-history"
import type { TaskExecution } from "@/types/scheduler"

function makeExecution(id: string, overrides: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id,
    taskId: "task-1",
    taskName: "Test task",
    taskType: "chat",
    status: "completed",
    startedAt: new Date("2026-05-01T10:00:00Z"),
    completedAt: new Date("2026-05-01T10:00:05Z"),
    duration: 5000,
    output: { summary: `result for ${id}` },
    error: undefined,
    terminalReason: undefined,
    retryAttempt: 0,
    logs: [],
    ...overrides,
  } as TaskExecution
}

describe("TaskExecutionHistory", () => {
  it("renders the empty state when there are no executions", () => {
    render(<TaskExecutionHistory executions={[]} />)
    expect(screen.queryByTestId("execution-row")).not.toBeInTheDocument()
  })

  it("renders only the first maxItems entries by default", () => {
    const executions = Array.from({ length: 25 }, (_, i) => makeExecution(`e-${i}`))
    render(<TaskExecutionHistory executions={executions} maxItems={10} />)
    expect(screen.getAllByTestId("execution-row")).toHaveLength(10)
    expect(screen.getByTestId("execution-load-more")).toBeInTheDocument()
    expect(screen.getByTestId("execution-load-more").textContent).toContain("15")
  })

  it("clicking Load more increases the displayed page by maxItems", () => {
    const executions = Array.from({ length: 25 }, (_, i) => makeExecution(`e-${i}`))
    render(<TaskExecutionHistory executions={executions} maxItems={10} />)
    fireEvent.click(screen.getByTestId("execution-load-more"))
    expect(screen.getAllByTestId("execution-row")).toHaveLength(20)
    expect(screen.getByTestId("execution-load-more").textContent).toContain("5")
  })

  it("hides the Load more button once all rows are displayed", () => {
    const executions = Array.from({ length: 12 }, (_, i) => makeExecution(`e-${i}`))
    render(<TaskExecutionHistory executions={executions} maxItems={10} />)
    expect(screen.getByTestId("execution-load-more")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("execution-load-more"))
    expect(screen.getAllByTestId("execution-row")).toHaveLength(12)
    expect(screen.queryByTestId("execution-load-more")).not.toBeInTheDocument()
  })

  it("shows a trigger-source badge for non-default provenance only", () => {
    render(
      <TaskExecutionHistory
        executions={[
          makeExecution("bf-1", { triggerSource: "backfill" }),
          makeExecution("sched-1", { triggerSource: "schedule" }),
        ]}
      />
    )
    const badges = screen.getAllByTestId("execution-trigger-source")
    expect(badges).toHaveLength(1)
  })

  it("shows the failed execution's error line", () => {
    const executions: TaskExecution[] = [
      makeExecution("fail-1", { status: "failed", error: "boom went wrong", output: undefined }),
    ]
    render(<TaskExecutionHistory executions={executions} />)
    expect(screen.getByTestId("error-message")).toHaveTextContent("boom went wrong")
  })

  it("summarizes a completed run's output from a string, summary, or message", () => {
    render(
      <TaskExecutionHistory
        executions={[
          // A raw string output is legal at runtime (executors return free-form
          // values) even though the row type narrows it to an object.
          makeExecution("s-1", {
            output: "plain string output" as unknown as TaskExecution["output"],
          }),
          makeExecution("s-2", { output: { summary: "from summary" } }),
          makeExecution("s-3", { output: { message: "from message" } }),
          makeExecution("s-4", { output: { other: "ignored" } }),
          makeExecution("s-5", { output: undefined }),
        ]}
      />
    )
    expect(screen.getByText("plain string output")).toBeInTheDocument()
    expect(screen.getByText("from summary")).toBeInTheDocument()
    expect(screen.getByText("from message")).toBeInTheDocument()
    expect(screen.queryByText("ignored")).toBeNull()
  })

  it("treats an empty string output as no summary", () => {
    render(
      <TaskExecutionHistory
        executions={[makeExecution("s-0", { output: "" as unknown as TaskExecution["output"] })]}
      />
    )
    expect(screen.getByTestId("execution-row").textContent).not.toContain("undefined")
  })

  it("spins the icon only while a run is in flight", () => {
    render(
      <TaskExecutionHistory
        executions={[makeExecution("r-1", { status: "running" }), makeExecution("c-1")]}
      />
    )
    const classOf = (testId: string) =>
      screen.getByTestId(testId).querySelector("svg")!.getAttribute("class") ?? ""
    expect(classOf("status-icon-running")).toContain("animate-spin")
    expect(classOf("status-icon-completed")).not.toContain("animate-spin")
  })

  it("renders the terminal reason when one is recorded", () => {
    render(
      <TaskExecutionHistory
        executions={[makeExecution("t-1", { terminalReason: "overlap-skipped" })]}
      />
    )
    expect(screen.getByText("overlap-skipped")).toBeInTheDocument()
  })

  it("opens the run sheet from the keyboard on a clickable row", () => {
    const onSelectExecution = jest.fn()
    render(
      <TaskExecutionHistory
        executions={[makeExecution("k-1")]}
        onSelectExecution={onSelectExecution}
      />
    )
    const row = screen.getByTestId("execution-row")
    fireEvent.keyDown(row, { key: "Enter" })
    fireEvent.keyDown(row, { key: " " })
    fireEvent.keyDown(row, { key: "a" })
    expect(onSelectExecution).toHaveBeenCalledTimes(2)
  })

  describe("error expansion", () => {
    const longError = `${"a stack frame line ".repeat(10)}\nand a second line`

    function renderFailed(error: string, onSelectExecution?: () => void) {
      return render(
        <TaskExecutionHistory
          executions={[makeExecution("fail-1", { status: "failed", error, output: undefined })]}
          onSelectExecution={onSelectExecution}
        />
      )
    }

    it("offers no toggle for an error that already fits on one line", () => {
      renderFailed("boom")
      expect(screen.queryByTestId("error-toggle")).not.toBeInTheDocument()
      expect(screen.getByTestId("error-message")).toHaveClass("truncate")
    })

    it("collapses a long error until the toggle is used", () => {
      renderFailed(longError)
      expect(screen.getByTestId("error-message")).toHaveClass("truncate")
      const toggle = screen.getByTestId("error-toggle")
      expect(toggle).toHaveAttribute("aria-expanded", "false")

      fireEvent.click(toggle)
      const message = screen.getByTestId("error-message")
      expect(message).not.toHaveClass("truncate")
      // Expanded errors wrap inside a bounded scroll box instead of pushing
      // every following row down the list.
      expect(message).toHaveClass("max-h-40", "overflow-y-auto", "whitespace-pre-wrap")
      expect(screen.getByTestId("error-toggle")).toHaveAttribute("aria-expanded", "true")
    })

    it("collapses again on a second toggle", () => {
      renderFailed(longError)
      fireEvent.click(screen.getByTestId("error-toggle"))
      fireEvent.click(screen.getByTestId("error-toggle"))
      expect(screen.getByTestId("error-message")).toHaveClass("truncate")
    })

    it("does not open the run sheet when the toggle is used", () => {
      const onSelectExecution = jest.fn()
      renderFailed(longError, onSelectExecution)
      fireEvent.click(screen.getByTestId("error-toggle"))
      expect(onSelectExecution).not.toHaveBeenCalled()
      // Nor does keying it — the row's Enter/Space handler must not see it.
      fireEvent.keyDown(screen.getByTestId("error-toggle"), { key: "Enter" })
      expect(onSelectExecution).not.toHaveBeenCalled()
      // The row itself still opens it.
      fireEvent.click(screen.getByTestId("execution-row"))
      expect(onSelectExecution).toHaveBeenCalledTimes(1)
    })

    it("keeps the untruncated error available as a tooltip while collapsed", () => {
      renderFailed(longError)
      expect(screen.getByTestId("error-message")).toHaveAttribute("title", longError)
    })
  })
})

// ---------------------------------------------------------------------------
// Pagination past the loaded page, and cancelling a run that is still ours.
// Both halves existed in the store (`loadMoreExecutions` / `hasMoreExecutions`
// and `cancelPluginExecution` / `isPluginExecutionActive`) and were never
// reachable from the list.
// ---------------------------------------------------------------------------

describe("TaskExecutionHistory · reaching the rest of the history", () => {
  it("reveals already-loaded rows before asking the store for more", () => {
    const onLoadMore = jest.fn()
    const executions = Array.from({ length: 12 }, (_, i) => makeExecution(`e${i}`))
    render(
      <TaskExecutionHistory
        executions={executions}
        maxItems={10}
        hasMoreOnServer
        onLoadMore={onLoadMore}
      />
    )
    expect(screen.getAllByTestId("execution-row")).toHaveLength(10)
    fireEvent.click(screen.getByTestId("execution-load-more"))
    expect(onLoadMore).not.toHaveBeenCalled()
    expect(screen.getAllByTestId("execution-row")).toHaveLength(12)
  })

  it("fetches the next page once the loaded array is exhausted", async () => {
    const onLoadMore = jest.fn().mockResolvedValue(undefined)
    const executions = Array.from({ length: 10 }, (_, i) => makeExecution(`e${i}`))
    render(
      <TaskExecutionHistory
        executions={executions}
        maxItems={10}
        hasMoreOnServer
        onLoadMore={onLoadMore}
      />
    )
    // Before this the button was simply absent here — the page boundary hid
    // every remaining row in Dexie.
    fireEvent.click(screen.getByTestId("execution-load-more"))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it("hides the button when neither the array nor the store has more", () => {
    render(
      <TaskExecutionHistory
        executions={[makeExecution("only")]}
        maxItems={10}
        hasMoreOnServer={false}
        onLoadMore={jest.fn()}
      />
    )
    expect(screen.queryByTestId("execution-load-more")).not.toBeInTheDocument()
  })

  // Every running row gets the control now. It used to be gated on a predicate
  // that only accepted plugin runs, so an agent turn or a spawned command
  // showed nothing, and the missing button read as "this cannot be stopped".
  it("offers Cancel on every running row, and on no settled one", () => {
    const onCancelExecution = jest.fn()
    render(
      <TaskExecutionHistory
        executions={[
          makeExecution("running-a", { status: "running", duration: undefined }),
          makeExecution("running-b", { status: "running", duration: undefined }),
          makeExecution("done"),
        ]}
        onCancelExecution={onCancelExecution}
      />
    )
    const cancels = screen.getAllByTestId("execution-cancel")
    expect(cancels).toHaveLength(2)
    fireEvent.click(cancels[0])
    expect(onCancelExecution).toHaveBeenCalledWith("running-a")
  })

  it("offers no Cancel at all when the caller cannot handle one", () => {
    render(
      <TaskExecutionHistory
        executions={[makeExecution("r", { status: "running", duration: undefined })]}
      />
    )
    expect(screen.queryByTestId("execution-cancel")).not.toBeInTheDocument()
  })

  it("does not open the run sheet when Cancel is used", () => {
    const onSelectExecution = jest.fn()
    render(
      <TaskExecutionHistory
        executions={[makeExecution("r", { status: "running", duration: undefined })]}
        onSelectExecution={onSelectExecution}
        onCancelExecution={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId("execution-cancel"))
    expect(onSelectExecution).not.toHaveBeenCalled()
  })
})
