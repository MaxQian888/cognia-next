/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, _vars?: Record<string, unknown>) => key,
}))

let mockRuns: UnifiedExecutionRun[] = []
jest.mock("@/hooks/scheduler/use-unified-recent-runs", () => ({
  useUnifiedRecentRuns: () => ({ runs: mockRuns, isLoading: false }),
}))

import { SchedulerUpcomingRail } from "./scheduler-upcoming-rail"

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Daily summary",
    type: "chat",
    trigger: { type: "cron", cronExpression: "0 9 * * *" },
    config: {
      timeoutMs: 60_000,
      maxRetries: 0,
      retryDelayMs: 0,
      allowConcurrent: false,
      runMissedOnStartup: false,
      maxMissedRuns: 0,
    },
    notification: {
      onStart: false,
      onComplete: false,
      onError: false,
      channels: [],
    },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    nextRunAt: new Date(Date.now() + 600_000),
    ...overrides,
  } as ScheduledTask
}

function makeExecution(overrides: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id: "exec-1",
    taskId: "task-1",
    taskName: "Daily summary",
    status: "completed",
    startedAt: new Date(Date.now() - 120_000),
    completedAt: new Date(Date.now() - 60_000),
    duration: 60_000,
    ...overrides,
  } as TaskExecution
}

function makeRun(overrides: Partial<UnifiedExecutionRun> = {}): UnifiedExecutionRun {
  return {
    unifiedId: "app:run-1",
    kind: "app",
    itemUnifiedId: "app:task-1",
    itemName: "Cross-kind run",
    status: "succeeded",
    startedAt: Date.now() - 60_000,
    origin: { tableName: "schedulerDb.executions", nativeId: "run-1" },
    ...overrides,
  }
}

describe("SchedulerUpcomingRail", () => {
  beforeEach(() => {
    mockRuns = []
  })

  it("renders the upcoming and recent sections with empty state copy", () => {
    render(
      <SchedulerUpcomingRail upcomingTasks={[]} recentExecutions={[]} onSelectTask={jest.fn()} />
    )
    expect(screen.getByTestId("scheduler-upcoming-rail")).toBeInTheDocument()
    expect(screen.getByTestId("upcoming-rail-no-upcoming")).toBeInTheDocument()
    expect(screen.getByTestId("upcoming-rail-no-recent")).toBeInTheDocument()
  })

  it("renders up to 5 upcoming tasks and fires onSelectTask on click", () => {
    const tasks = Array.from({ length: 7 }, (_, i) =>
      makeTask({ id: `task-${i}`, name: `Task ${i}` })
    )
    const onSelectTask = jest.fn()
    render(
      <SchedulerUpcomingRail
        upcomingTasks={tasks}
        recentExecutions={[]}
        onSelectTask={onSelectTask}
      />
    )
    expect(screen.getAllByRole("button")).toHaveLength(5)
    fireEvent.click(screen.getByTestId("upcoming-rail-upcoming-task-2"))
    expect(onSelectTask).toHaveBeenCalledWith("task-2")
  })

  it("uses yellow status dot for paused upcoming tasks", () => {
    render(
      <SchedulerUpcomingRail
        upcomingTasks={[makeTask({ id: "p1", status: "paused", name: "Paused" })]}
        recentExecutions={[]}
        onSelectTask={jest.fn()}
      />
    )
    const button = screen.getByTestId("upcoming-rail-upcoming-p1")
    expect(button.querySelector(".bg-yellow-500")).toBeInTheDocument()
  })

  it("falls back to app-only recent executions when onSelectRun is not provided", () => {
    const execs = [makeExecution({ id: "e1", taskName: "Recent A" })]
    render(
      <SchedulerUpcomingRail upcomingTasks={[]} recentExecutions={execs} onSelectTask={jest.fn()} />
    )
    expect(screen.getByTestId("upcoming-rail-recent-e1")).toBeInTheDocument()
    expect(screen.getByText("Recent A")).toBeInTheDocument()
  })

  it("uses unified runs when onSelectRun is provided and triggers it on click", () => {
    mockRuns = [makeRun({ unifiedId: "app:run-x", itemName: "Unified run" })]
    const onSelectRun = jest.fn()
    render(
      <SchedulerUpcomingRail
        upcomingTasks={[]}
        recentExecutions={[]}
        onSelectTask={jest.fn()}
        onSelectRun={onSelectRun}
      />
    )
    const row = screen.getByTestId("upcoming-rail-recent-app:run-x")
    expect(row).toBeInTheDocument()
    fireEvent.click(row)
    expect(onSelectRun).toHaveBeenCalledWith(mockRuns[0])
  })

  it("renders the no-recent empty state when onSelectRun is set but hook returns no runs", () => {
    mockRuns = []
    render(
      <SchedulerUpcomingRail
        upcomingTasks={[]}
        recentExecutions={[]}
        onSelectTask={jest.fn()}
        onSelectRun={jest.fn()}
      />
    )
    expect(screen.getByTestId("upcoming-rail-no-recent")).toBeInTheDocument()
  })

  it("paints status dots by run status", () => {
    mockRuns = [
      makeRun({ unifiedId: "k:1", status: "succeeded" }),
      makeRun({ unifiedId: "k:2", status: "failed" }),
      makeRun({ unifiedId: "k:3", status: "running" }),
      makeRun({ unifiedId: "k:4", status: "cancelled" }),
    ]
    render(
      <SchedulerUpcomingRail
        upcomingTasks={[]}
        recentExecutions={[]}
        onSelectTask={jest.fn()}
        onSelectRun={jest.fn()}
      />
    )
    expect(
      screen.getByTestId("upcoming-rail-recent-k:1").querySelector(".bg-green-500")
    ).toBeInTheDocument()
    expect(
      screen.getByTestId("upcoming-rail-recent-k:2").querySelector(".bg-red-500")
    ).toBeInTheDocument()
    expect(
      screen.getByTestId("upcoming-rail-recent-k:3").querySelector(".bg-blue-500")
    ).toBeInTheDocument()
    expect(
      screen.getByTestId("upcoming-rail-recent-k:4").querySelector(".bg-muted-foreground\\/40")
    ).toBeInTheDocument()
  })
})
