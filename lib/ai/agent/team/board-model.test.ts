import {
  BOARD_COLUMN_ORDER,
  EMPTY_BOARD_FILTER,
  applyBoardFilter,
  buildBoardColumns,
  buildSwimlanes,
  collectFilterOptions,
  columnDropId,
  dependencyLockInfo,
  isFilterActive,
  parseDndId,
  resolveDrop,
  wipHint,
  originIssuesOfTasks,
} from "./board-model"
import type { AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"

const task = (id: string, overrides: Partial<AgentTeamTask> = {}): AgentTeamTask =>
  ({
    id,
    teamId: "team-1",
    title: `Task ${id}`,
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    createdAt: new Date(2026, 0, 1),
    order: 0,
    ...overrides,
  }) as AgentTeamTask

const mate = (id: string, overrides: Partial<AgentTeammate> = {}): AgentTeammate =>
  ({
    id,
    teamId: "team-1",
    name: `Mate ${id}`,
    description: "",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(2026, 0, 1),
    ...overrides,
  }) as AgentTeammate

const byId = (tasks: AgentTeamTask[]) => new Map(tasks.map((t) => [t.id, t]))

describe("applyBoardFilter", () => {
  const tasks = [
    task("a", { tags: ["ui"], priority: "high", assignedTo: "w1" }),
    task("b", { tags: ["api"], priority: "normal", claimedBy: "w2" }),
    task("c", { tags: [], priority: "low" }),
  ]

  it("returns a copy when the filter is empty", () => {
    expect(isFilterActive(EMPTY_BOARD_FILTER)).toBe(false)
    const out = applyBoardFilter(tasks, EMPTY_BOARD_FILTER)
    expect(out).toEqual(tasks)
    expect(out).not.toBe(tasks)
  })

  it("filters by tag / priority / assignee (claimedBy wins over assignedTo)", () => {
    expect(
      applyBoardFilter(tasks, { ...EMPTY_BOARD_FILTER, tags: ["ui"] }).map((t) => t.id)
    ).toEqual(["a"])
    expect(
      applyBoardFilter(tasks, { ...EMPTY_BOARD_FILTER, priorities: ["low"] }).map((t) => t.id)
    ).toEqual(["c"])
    expect(
      applyBoardFilter(tasks, { ...EMPTY_BOARD_FILTER, assigneeIds: ["w2"] }).map((t) => t.id)
    ).toEqual(["b"])
    // Unowned tasks never match an assignee filter.
    expect(
      applyBoardFilter(tasks, { ...EMPTY_BOARD_FILTER, assigneeIds: ["w9"] }).map((t) => t.id)
    ).toEqual([])
  })

  it("collects distinct sorted filter options", () => {
    expect(collectFilterOptions(tasks)).toEqual({ tags: ["api", "ui"], assigneeIds: ["w1", "w2"] })
  })
})

describe("buildBoardColumns", () => {
  it("always yields the 8 canonical columns, sorted by order", () => {
    const cols = buildBoardColumns([
      task("b", { status: "pending", order: 1 }),
      task("a", { status: "pending", order: 0 }),
      task("z", { status: "review" }),
    ])
    expect(cols.map((c) => c.status)).toEqual([...BOARD_COLUMN_ORDER])
    expect(cols[0].tasks.map((t) => t.id)).toEqual(["a", "b"])
    expect(cols.find((c) => c.status === "review")?.tasks.map((t) => t.id)).toEqual(["z"])
    expect(cols.find((c) => c.status === "failed")?.tasks).toEqual([])
  })
})

describe("buildSwimlanes", () => {
  it("groups by claimedBy ?? assignedTo, keeps roster order, appends orphans as unassigned", () => {
    const lanes = buildSwimlanes(
      [
        task("a", { assignedTo: "w2" }),
        task("b", { claimedBy: "w1", assignedTo: "w2" }), // claim wins
        task("c" /* unowned */),
        task("d", { assignedTo: "gone" }), // off-roster → unassigned lane
      ],
      [mate("w1", { config: { twinId: "twin-9" } }), mate("w2"), mate("w3")]
    )
    expect(lanes.map((l) => l.teammateId)).toEqual(["w1", "w2", null])
    expect(lanes[0].twinId).toBe("twin-9")
    expect(lanes[0].taskCount).toBe(1)
    expect(lanes[1].columns.find((c) => c.status === "pending")?.tasks.map((t) => t.id)).toEqual([
      "a",
    ])
    expect(lanes[2].taskCount).toBe(2) // c + d
    // w3 has no tasks → no lane.
    expect(lanes.some((l) => l.teammateId === "w3")).toBe(false)
  })
})

describe("wipHint", () => {
  it("counts claimed + in_progress against capacity", () => {
    const tasks = [
      task("a", { status: "claimed" }),
      task("b", { status: "in_progress" }),
      task("c", { status: "pending" }),
    ]
    expect(wipHint(tasks, 2)).toEqual({ active: 2, capacity: 2, over: false })
    expect(wipHint(tasks, 1)).toEqual({ active: 2, capacity: 1, over: true })
    // Bad capacity input clamps to 1.
    expect(wipHint(tasks, 0)).toEqual({ active: 2, capacity: 1, over: true })
  })
})

describe("dependencyLockInfo", () => {
  it("reports unfinished upstream tasks; absent/finished deps are satisfied", () => {
    const all = [
      task("dep-open", { status: "in_progress" }),
      task("dep-done", { status: "completed" }),
      task("dep-dropped", { status: "cancelled" }),
    ]
    const info = dependencyLockInfo(
      { dependencies: ["dep-open", "dep-done", "dep-dropped", "dep-missing"] },
      byId(all)
    )
    expect(info.locked).toBe(true)
    expect(info.blocking).toEqual([{ id: "dep-open", title: "Task dep-open" }])
    expect(dependencyLockInfo({ dependencies: ["dep-done"] }, byId(all)).locked).toBe(false)
  })
})

describe("resolveDrop", () => {
  const tasks = [
    task("p1", { status: "pending", order: 0 }),
    task("p2", { status: "pending", order: 1 }),
    task("f1", { status: "failed" }),
    task("r1", { status: "review" }),
  ]
  const map = byId(tasks)

  it("round-trips dnd ids", () => {
    expect(parseDndId(columnDropId("review"))).toEqual({ kind: "column", status: "review" })
    expect(parseDndId("t-42")).toEqual({ kind: "card", taskId: "t-42" })
  })

  it("returns null for missing/self drops", () => {
    expect(resolveDrop(null, "col:review", map, "idle")).toBeNull()
    expect(resolveDrop("p1", null, map, "idle")).toBeNull()
    expect(resolveDrop("p1", "p1", map, "idle")).toBeNull()
    expect(resolveDrop("missing", "col:review", map, "idle")).toBeNull()
    expect(resolveDrop("col:review", "p1", map, "idle")).toBeNull()
  })

  it("same-column card drop → reorder to the target's index", () => {
    expect(resolveDrop("p1", "p2", map, "executing")).toEqual({
      type: "reorder",
      taskId: "p1",
      targetIndex: 1,
    })
    // Dropping on its own column header is a no-op.
    expect(resolveDrop("p1", "col:pending", map, "idle")).toBeNull()
  })

  it("cross-column drop → guarded move (column or card target)", () => {
    expect(resolveDrop("f1", "col:pending", map, "idle")).toEqual({
      type: "move",
      taskId: "f1",
      to: "pending",
    })
    // Dropping a failed task onto a pending CARD also means "move to pending".
    expect(resolveDrop("f1", "p2", map, "idle")).toEqual({
      type: "move",
      taskId: "f1",
      to: "pending",
    })
    expect(resolveDrop("r1", "col:completed", map, "executing")).toEqual({
      type: "move",
      taskId: "r1",
      to: "completed",
    })
  })

  it("denied moves carry the guard reason", () => {
    expect(resolveDrop("p1", "col:completed", map, "idle")).toEqual({
      type: "denied",
      taskId: "p1",
      reason: "illegal-transition",
    })
    expect(resolveDrop("p1", "col:blocked", map, "idle")).toEqual({
      type: "denied",
      taskId: "p1",
      reason: "blocked-column",
    })
  })
})

describe("originIssuesOfTasks", () => {
  it("collects the distinct issues the run adapter stamped, in first-seen order", () => {
    const stamped = (id: string, issueId: string, identifier?: string) =>
      task(id, { metadata: { issueId, issueIdentifier: identifier } })
    expect(
      originIssuesOfTasks([
        stamped("t1", "iss-b", "MERC-2"),
        stamped("t2", "iss-a"),
        stamped("t3", "iss-b", "MERC-2"),
        task("t4"),
      ])
    ).toEqual([{ issueId: "iss-b", identifier: "MERC-2" }, { issueId: "iss-a" }])
  })

  it("ignores malformed metadata", () => {
    expect(
      originIssuesOfTasks([
        task("t1", { metadata: { issueId: 7 } }),
        task("t2", { metadata: { issueId: "" } }),
      ])
    ).toEqual([])
  })
})
