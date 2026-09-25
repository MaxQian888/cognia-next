import { SCHEDULE_TOOL, SCHEDULE_TOOL_NAMES, scheduleToolVerb } from "./tool-names"
import { getSharedBuiltInSkillRegistry } from "../registry"
import "./index"

describe("schedule tool names", () => {
  it("is the name every registered schedule.* skill actually uses", () => {
    const registered = getSharedBuiltInSkillRegistry()
      .list()
      .filter((skill) => skill.family === "schedule")
      .map((skill) => skill.mcpToolName)
      .sort()
    expect(registered).toEqual([...SCHEDULE_TOOL_NAMES].sort())
  })

  it("maps a bare tool name back to its verb, and nothing else", () => {
    expect(scheduleToolVerb(SCHEDULE_TOOL.create)).toBe("create")
    expect(scheduleToolVerb("scheduler_delete_task")).toBe("delete")
    expect(scheduleToolVerb("mcp__cognia-plugin-tools__scheduler_delete_task")).toBeUndefined()
    expect(scheduleToolVerb("lark_calendar_list_events")).toBeUndefined()
    expect(scheduleToolVerb(undefined)).toBeUndefined()
  })
})
