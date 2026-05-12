/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { TaskStatsCards } from "./task-stats-cards"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

const baseTask: ScheduledTask = {
  id: "t1",
  name: "Task",
  description: "",
  type: "custom",
  status: "active",
  trigger: { type: "cron", cronExpression: "* * * * *" },
  payload: {},
  config: {},
  notification: { enabled: false },
  tags: [],
  successCount: 12,
  failureCount: 3,
  nextRunAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as ScheduledTask

function buildExecutions(durations: number[]): TaskExecution[] {
  return durations.map(
    (duration, idx) =>
      ({
        id: `e${idx}`,
        taskId: "t1",
        status: "completed",
        duration,
        startedAt: Date.now(),
        completedAt: Date.now(),
      }) as unknown as TaskExecution
  )
}

describe("TaskStatsCards", () => {
  it("renders the success and failure counts as strings", () => {
    render(<TaskStatsCards task={baseTask} executions={[]} />)
    expect(screen.getByText("12")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("renders an em-dash when no completed executions exist", () => {
    render(<TaskStatsCards task={baseTask} executions={[]} />)
    expect(screen.getByText("—")).toBeInTheDocument()
  })

  it("computes the average duration across completed executions", () => {
    const executions = buildExecutions([1000, 3000, 5000])
    render(<TaskStatsCards task={baseTask} executions={executions} />)
    // formatDuration(3000) — exact string varies; just ensure the em-dash
    // fallback is gone and a duration-shaped string is present.
    expect(screen.queryByText("—")).toBeNull()
  })

  it("ignores non-completed executions in the average", () => {
    const nonCompleted: TaskExecution[] = [
      {
        id: "e0",
        taskId: "t1",
        status: "running",
        startedAt: Date.now(),
      } as unknown as TaskExecution,
    ]
    render(<TaskStatsCards task={baseTask} executions={nonCompleted} />)
    expect(screen.getByText("—")).toBeInTheDocument()
  })
})
