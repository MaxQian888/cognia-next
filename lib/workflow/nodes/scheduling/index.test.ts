import "."
import { getExecutor } from "../registry"

describe("scheduler-nodes registration", () => {
  it.each([
    ["action.scheduler.event.trigger", 1],
    ["action.scheduler.execution.get", 1],
    ["action.scheduler.executions.recent", 1],
    ["action.scheduler.statistics", 1],
    ["action.scheduler.status", 1],
    ["action.scheduler.task.backfill", 1],
    ["action.scheduler.task.create", 1],
    ["action.scheduler.task.delete", 1],
    ["action.scheduler.task.executions", 1],
    ["action.scheduler.task.export", 1],
    ["action.scheduler.task.get", 1],
    ["action.scheduler.task.import", 1],
    ["action.scheduler.task.list", 1],
    ["action.scheduler.task.pause", 1],
    ["action.scheduler.task.resume", 1],
    ["action.scheduler.task.runNow", 1],
    ["action.scheduler.task.update", 1],
    ["action.scheduler.upcoming", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})
