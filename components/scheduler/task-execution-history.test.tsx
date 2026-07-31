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
})
