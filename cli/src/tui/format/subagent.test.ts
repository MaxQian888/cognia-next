import {
  inflightSubagentRows,
  isSubagentTool,
  runningSubagents,
  subagentDispatchCount,
  subagentName,
  subagentTask,
} from "./subagent"
import type { ToolCell } from "../state/types"

const tool = (over: Partial<ToolCell>): ToolCell => ({
  id: "t",
  kind: "tool",
  callKey: "k",
  toolName: "task",
  input: {},
  status: "running",
  collapsed: true,
  ...over,
})

describe("isSubagentTool", () => {
  it("matches the dispatch tool names case-insensitively", () => {
    expect(isSubagentTool("task")).toBe(true)
    expect(isSubagentTool("dispatch_agent")).toBe(true)
    expect(isSubagentTool("Agent")).toBe(true)
    expect(isSubagentTool("DISPATCH_AGENT")).toBe(true)
    expect(isSubagentTool("mcp__cognia_tools__dispatch_agent")).toBe(true)
  })

  it("rejects ordinary tools", () => {
    expect(isSubagentTool("bash")).toBe(false)
    expect(isSubagentTool("read")).toBe(false)
    expect(isSubagentTool("")).toBe(false)
  })
})

describe("subagentName", () => {
  it("prefers dispatch_agent ids before legacy agent labels", () => {
    expect(subagentName({ subagent_type: "reviewer" })).toBe("reviewer")
    expect(subagentName({ subagentId: "frontend-reviewer", agent: "planner" })).toBe(
      "frontend-reviewer"
    )
    expect(subagentName({ subagent_id: "backend-reviewer", name: "scout" })).toBe(
      "backend-reviewer"
    )
    expect(subagentName({ agent: "planner" })).toBe("planner")
    expect(subagentName({ name: "scout" })).toBe("scout")
  })

  it("falls back to a generic label and truncates long ids", () => {
    expect(subagentName({})).toBe("agent")
    expect(subagentName({ subagent_type: "x".repeat(60) })).toHaveLength(40)
  })

  it("labels one batched dispatch by its real parallel width", () => {
    const input = {
      dispatches: [
        { subagentId: "frontend", prompt: "review UI" },
        { subagentId: "backend", prompt: "review runtime" },
        { subagentId: "tests", prompt: "review tests" },
      ],
    }
    expect(subagentDispatchCount(input)).toBe(3)
    expect(subagentName(input)).toBe("3 agents")
    expect(subagentTask(input)).toBe("frontend · backend · tests")
  })
})

describe("subagentTask", () => {
  it("prefers description over prompt", () => {
    expect(subagentTask({ description: "find bugs", prompt: "p" })).toBe("find bugs")
    expect(subagentTask({ prompt: "review the diff" })).toBe("review the diff")
  })

  it("is empty when neither is present", () => {
    expect(subagentTask({})).toBe("")
  })
})

describe("runningSubagents", () => {
  it("returns null when no sub-agent is running", () => {
    expect(runningSubagents([])).toBeNull()
    expect(runningSubagents([tool({ toolName: "bash" })])).toBeNull()
    expect(runningSubagents([tool({ status: "done" })])).toBeNull()
  })

  it("summarizes the running dispatches, naming the most recent", () => {
    const result = runningSubagents([
      tool({ id: "a", input: { subagent_type: "reviewer" } }),
      tool({ id: "b", toolName: "bash", status: "running" }),
      tool({ id: "c", toolName: "dispatch_agent", input: { subagentId: "planner" } }),
    ])
    expect(result).toEqual({ name: "planner", count: 2 })
  })

  it("counts every sibling represented by a parallel batch", () => {
    const result = runningSubagents([
      tool({
        toolName: "dispatch_agent",
        input: {
          dispatches: [
            { subagentId: "a", prompt: "a" },
            { subagentId: "b", prompt: "b" },
            { subagentId: "c", prompt: "c" },
          ],
        },
      }),
    ])
    expect(result).toEqual({ name: "3 agents", count: 3 })
  })
})

describe("inflightSubagentRows", () => {
  it("keeps only running sub-agent dispatches, one row each", () => {
    const rows = inflightSubagentRows([
      tool({
        callKey: "k1",
        input: { subagent_type: "reviewer", description: "find bugs" },
      }),
      tool({ callKey: "k2", toolName: "bash", status: "running" }),
      tool({ callKey: "k3", toolName: "task", status: "done" }),
      tool({
        callKey: "k4",
        toolName: "dispatch_agent",
        input: { subagentId: "planner", prompt: "plan it" },
      }),
    ])
    expect(rows).toEqual([
      { callKey: "k1", name: "reviewer", task: "find bugs" },
      { callKey: "k4", name: "planner", task: "plan it" },
    ])
  })

  it("returns an empty list when nothing is running", () => {
    expect(inflightSubagentRows([])).toEqual([])
  })
})
