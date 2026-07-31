// Unit tests for the plan-mode → tasks bridge. Drives the bridge with
// synthetic SDK assistant messages and asserts on `useAgentTeamStore`
// state. These tests exercise the bridge against the real Zustand store
// (no mocks) — the store is in-memory, lightweight, and what the bridge
// would actually drive in production.

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { applyPlanModeBridge, mapStatus, parseTodos, soloTeamId } from "./plan-mode-bridge"
import type { SDKAssistantMessage } from "@cognia/agent-config-types"

function todoEvent(
  todos: Array<{ content: string; status?: string; activeForm?: string }>
): SDKAssistantMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "u",
    session_id: "sdk-x",
    message: {
      id: "m",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu1",
          name: "TodoWrite",
          input: { todos },
        },
      ],
    },
  } as SDKAssistantMessage
}

function toolUseEvent(name: string, input: Record<string, unknown>): SDKAssistantMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "u",
    session_id: "sdk-x",
    message: {
      id: "m",
      role: "assistant",
      content: [{ type: "tool_use", id: "tu", name, input }],
    },
  } as SDKAssistantMessage
}

function reset() {
  // Wipe the store between tests. We only mutate the buckets the bridge
  // touches; UI state can stay.
  useAgentTeamStore.setState({
    teams: {},
    teammates: {},
    tasks: {},
    messages: {},
    events: [],
    consensus: {},
    sharedMemory: {},
    delegations: {},
  })
}

describe("soloTeamId", () => {
  it("prefixes the session id", () => {
    expect(soloTeamId("s1")).toBe("solo:s1")
  })
})

describe("mapStatus", () => {
  it.each([
    ["pending", "pending"],
    ["in_progress", "in_progress"],
    ["running", "in_progress"],
    ["active", "in_progress"],
    ["completed", "completed"],
    ["done", "completed"],
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"],
    ["failed", "failed"],
    ["error", "failed"],
    ["blocked", "blocked"],
    ["review", "review"],
    [undefined, "pending"],
    [null, "pending"],
    ["bogus", "pending"],
  ])("maps %p to %p", (input, expected) => {
    expect(mapStatus(input as string | undefined | null)).toBe(expected)
  })
})

describe("parseTodos", () => {
  it("returns null for non-objects", () => {
    expect(parseTodos(null)).toBeNull()
    expect(parseTodos("nope")).toBeNull()
  })

  it("returns null when todos is not an array", () => {
    expect(parseTodos({ todos: "x" })).toBeNull()
  })

  it("filters out malformed entries", () => {
    const result = parseTodos({
      todos: [
        { content: "ok", status: "pending" },
        null,
        { content: 42 }, // non-string content
        { content: "  " }, // empty after trim
        { content: "trim", status: "in_progress" },
      ],
    })
    expect(result).toEqual([
      { content: "ok", status: "pending", activeForm: undefined },
      { content: "trim", status: "in_progress", activeForm: undefined },
    ])
  })

  it("falls back to title when content is missing", () => {
    expect(parseTodos({ todos: [{ title: "task A" }] })).toEqual([
      { content: "task A", status: "pending", activeForm: undefined },
    ])
  })

  it("supports a custom key (TaskList uses 'tasks')", () => {
    expect(parseTodos({ tasks: [{ content: "T", status: "completed" }] }, "tasks")).toEqual([
      { content: "T", status: "completed", activeForm: undefined },
    ])
  })
})

describe("applyPlanModeBridge", () => {
  beforeEach(reset)

  it("creates a synthetic team and tasks for a non-team session", () => {
    applyPlanModeBridge(
      todoEvent([
        { content: "Plan A", status: "pending" },
        { content: "Plan B", status: "in_progress" },
      ]),
      "s1",
      undefined
    )
    const teamId = soloTeamId("s1")
    const team = useAgentTeamStore.getState().teams[teamId]
    expect(team).toBeDefined()
    expect(team.sessionId).toBe("s1")

    const tasks = useAgentTeamStore.getState().getTeamTasks(teamId)
    expect(tasks).toHaveLength(2)
    expect(tasks.find((t) => t.title === "Plan A")?.status).toBe("pending")
    expect(tasks.find((t) => t.title === "Plan B")?.status).toBe("in_progress")
  })

  it("idempotent: second TodoWrite does not duplicate, just patches state", () => {
    applyPlanModeBridge(todoEvent([{ content: "T", status: "pending" }]), "s1", undefined)
    applyPlanModeBridge(todoEvent([{ content: "T", status: "completed" }]), "s1", undefined)
    const tasks = useAgentTeamStore.getState().getTeamTasks(soloTeamId("s1"))
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe("completed")
  })

  it("marks missing items as cancelled in the next TodoWrite", () => {
    applyPlanModeBridge(todoEvent([{ content: "Keep" }, { content: "Drop" }]), "s1", undefined)
    applyPlanModeBridge(todoEvent([{ content: "Keep" }]), "s1", undefined)
    const tasks = useAgentTeamStore.getState().getTeamTasks(soloTeamId("s1"))
    expect(tasks.find((t) => t.title === "Drop")?.status).toBe("cancelled")
    expect(tasks.find((t) => t.title === "Keep")?.status).toBe("pending")
  })

  it("does not re-cancel items already completed", () => {
    applyPlanModeBridge(todoEvent([{ content: "Done", status: "completed" }]), "s1", undefined)
    applyPlanModeBridge(todoEvent([]), "s1", undefined)
    const tasks = useAgentTeamStore.getState().getTeamTasks(soloTeamId("s1"))
    // Completed item should remain completed, not flipped to cancelled.
    expect(tasks[0].status).toBe("completed")
  })

  it("TaskCreate creates a single task", () => {
    applyPlanModeBridge(
      toolUseEvent("TaskCreate", { content: "single", activeForm: "Doing single" }),
      "s1",
      undefined
    )
    const tasks = useAgentTeamStore.getState().getTeamTasks(soloTeamId("s1"))
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe("single")
    expect(tasks[0].description).toBe("Doing single")
  })

  it("TaskCreate ignores empty content", () => {
    applyPlanModeBridge(toolUseEvent("TaskCreate", { content: "  " }), "s1", undefined)
    expect(useAgentTeamStore.getState().getTeamTasks(soloTeamId("s1"))).toEqual([])
  })

  it("TaskUpdate patches an existing task by id", () => {
    applyPlanModeBridge(todoEvent([{ content: "T" }]), "s1", undefined)
    const tasks = useAgentTeamStore.getState().getTeamTasks(soloTeamId("s1"))
    const id = tasks[0].id
    applyPlanModeBridge(toolUseEvent("TaskUpdate", { id, status: "completed" }), "s1", undefined)
    expect(useAgentTeamStore.getState().tasks[id].status).toBe("completed")
  })

  it("TaskUpdate is a silent no-op when id or status is missing", () => {
    applyPlanModeBridge(toolUseEvent("TaskUpdate", { id: 42, status: "running" }), "s1", undefined)
    applyPlanModeBridge(toolUseEvent("TaskUpdate", { id: "nope" }), "s1", undefined)
    // No tasks created and no errors thrown.
    expect(useAgentTeamStore.getState().getTeamTasks(soloTeamId("s1"))).toEqual([])
  })

  it("TaskList behaves like TodoWrite", () => {
    applyPlanModeBridge(
      toolUseEvent("TaskList", { tasks: [{ content: "L", status: "in_progress" }] }),
      "s1",
      undefined
    )
    const tasks = useAgentTeamStore.getState().getTeamTasks(soloTeamId("s1"))
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe("in_progress")
  })

  it("does not create a synthetic team when teamId is provided", () => {
    // Seed the real team first.
    useAgentTeamStore.setState({
      teams: {
        "real-team": {
          id: "real-team",
          name: "Real",
          description: "",
          task: "",
          status: "idle",
          config: useAgentTeamStore.getState().defaultConfig,
          leadId: "",
          teammateIds: [],
          taskIds: [],
          messageIds: [],
          progress: 0,
          totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          createdAt: new Date(),
        },
      },
    })
    applyPlanModeBridge(todoEvent([{ content: "T" }]), "s1", "real-team")
    expect(useAgentTeamStore.getState().teams[soloTeamId("s1")]).toBeUndefined()
    expect(useAgentTeamStore.getState().getTeamTasks("real-team")).toHaveLength(1)
  })

  it("ExitPlanMode is a no-op (Phase 1)", () => {
    applyPlanModeBridge(toolUseEvent("ExitPlanMode", { plan: "step 1" }), "s1", undefined)
    expect(useAgentTeamStore.getState().teams).toEqual({})
    expect(useAgentTeamStore.getState().tasks).toEqual({})
  })

  it("unknown tool names are silently ignored", () => {
    applyPlanModeBridge(toolUseEvent("RandomTool", { foo: "bar" }), "s1", undefined)
    expect(useAgentTeamStore.getState().tasks).toEqual({})
  })

  it("ignores non-assistant events", () => {
    // user messages also have content but the bridge only inspects assistant.
    applyPlanModeBridge(
      {
        type: "user",
        parent_tool_use_id: null,
        uuid: "u",
        session_id: "sdk",
        message: { role: "user", content: [] },
      } as never,
      "s1",
      undefined
    )
    expect(useAgentTeamStore.getState().tasks).toEqual({})
  })

  it("handles 5 sequential TaskUpdate calls converging to the final status", () => {
    applyPlanModeBridge(todoEvent([{ content: "T" }]), "s1", undefined)
    const id = useAgentTeamStore.getState().getTeamTasks(soloTeamId("s1"))[0].id
    for (const status of ["in_progress", "completed", "in_progress", "failed", "completed"]) {
      applyPlanModeBridge(toolUseEvent("TaskUpdate", { id, status }), "s1", undefined)
    }
    expect(useAgentTeamStore.getState().tasks[id].status).toBe("completed")
  })
})
