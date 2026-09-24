import { isMaintenanceTask } from "./maintenance-tasks"
import type { ScheduledTask } from "@/types/scheduler"

const task = (type: string, tags?: string[]) =>
  ({ type, ...(tags ? { tags } : {}) }) as Pick<ScheduledTask, "type" | "tags">

describe("isMaintenanceTask", () => {
  it.each([
    "provider-diagnostics-refresh",
    "connection:presence:refresh",
    "connection:housekeeping:clock",
    "connection:housekeeping:outbound-retention",
    "connection:housekeeping:attachment-cache",
  ])("classifies %s as maintenance", (type) => {
    expect(isMaintenanceTask(task(type))).toBe(true)
  })

  it("classifies any system-tagged task as maintenance", () => {
    expect(isMaintenanceTask(task("bot", ["system:bot-trigger"]))).toBe(true)
    expect(isMaintenanceTask(task("custom", ["user", "system:connector-housekeeping"]))).toBe(true)
  })

  it.each([
    ["connection:scheduled:digest"],
    ["connection:outbound:send"],
    ["plugin"],
    ["agent-task"],
    ["workflow"],
  ])("keeps user-meaningful %s visible", (type) => {
    expect(isMaintenanceTask(task(type, ["plugin:demo", "loop"]))).toBe(false)
  })

  it("treats a missing task as not maintenance", () => {
    expect(isMaintenanceTask(undefined)).toBe(false)
    expect(isMaintenanceTask(null)).toBe(false)
  })
})
