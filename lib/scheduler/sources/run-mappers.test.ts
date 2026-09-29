import type { TaskExecution } from "@/types/scheduler"
import { filterRunsByKind, taskExecutionKind, toUnifiedFromTaskExecution } from "./run-mappers"

const execution: TaskExecution = {
  id: "exec-1",
  taskId: "task-1",
  taskName: "Task",
  taskType: "plugin",
  status: "completed",
  retryAttempt: 0,
  startedAt: new Date("2026-07-16T00:00:00Z"),
  completedAt: new Date("2026-07-16T00:00:01Z"),
  duration: 1_000,
  logs: [],
}

describe("scheduler run mappers", () => {
  it("classifies task executions by their owning source", () => {
    expect(taskExecutionKind("plugin")).toBe("plugin")
    expect(taskExecutionKind("connection:scheduled:digest")).toBe("connector")
    expect(taskExecutionKind("chat")).toBe("app")
  })

  it("maps plugin runs and filters them for the plugin source", () => {
    const run = toUnifiedFromTaskExecution(execution)
    expect(run).toMatchObject({ kind: "plugin", itemUnifiedId: "plugin:task-1" })
    expect(filterRunsByKind([run], "plugin")).toEqual([run])
    expect(filterRunsByKind([run], "app")).toEqual([])
  })

  it("carries phase timings when the run measured any", () => {
    const phases = [{ name: "turn" as const, startOffsetMs: 0, durationMs: 900 }]
    expect(toUnifiedFromTaskExecution({ ...execution, phases })).toMatchObject({ phases })
    expect(toUnifiedFromTaskExecution(execution)).not.toHaveProperty("phases")
    expect(toUnifiedFromTaskExecution({ ...execution, phases: [] })).not.toHaveProperty("phases")
  })

  it("carries the terminal reason so a run list can tell why it ended", () => {
    const run = toUnifiedFromTaskExecution({
      ...execution,
      taskType: "chat",
      status: "failed",
      terminalReason: "needs-approval",
      error: "needs approval: Bash",
    })
    expect(run).toMatchObject({ status: "failed", terminalReason: "needs-approval" })
    expect(toUnifiedFromTaskExecution(execution)).not.toHaveProperty("terminalReason")
  })
})
