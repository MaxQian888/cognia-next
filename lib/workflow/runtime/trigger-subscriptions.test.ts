import type { WorkflowRow } from "@/types/workflow/visual"
import {
  _peekTriggerSubscriptions,
  _seedTriggerSubscriptionsForTest,
  disposeTriggerSubscriptions,
  findMatchingWorkflows,
} from "./trigger-subscriptions"

function wf(id: string, nodes: WorkflowRow["nodes"]): WorkflowRow {
  return {
    id,
    schemaVersion: 1,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges: [],
    settings: {} as WorkflowRow["settings"],
  }
}

function trigger(
  id: string,
  type: WorkflowRow["nodes"][number]["type"],
  params: Record<string, unknown>
) {
  return {
    id,
    type,
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { params },
  } as WorkflowRow["nodes"][number]
}

afterEach(() => {
  disposeTriggerSubscriptions()
})

describe("trigger-subscriptions", () => {
  it("indexes only chat.message and connector.inbound triggers", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_a", [
        trigger("n1", "trigger.connector.inbound", { adapterId: "tg" }),
        trigger("n2", "trigger.cron", { cron: "* * * * *" }),
        trigger("n3", "trigger.webhook", { path: "/hook" }),
      ]),
      wf("wf_b", [trigger("n4", "trigger.chat.message", { characterId: "char_1" })]),
    ])
    const idx = _peekTriggerSubscriptions()
    expect(idx.get("trigger.connector.inbound")).toHaveLength(1)
    expect(idx.get("trigger.chat.message")).toHaveLength(1)
    expect(idx.get("trigger.cron" as never)).toBeUndefined()
    expect(idx.get("trigger.webhook" as never)).toBeUndefined()
  })

  it("matches connector.inbound by adapterId when params bind it", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_tg", [trigger("n", "trigger.connector.inbound", { adapterId: "tg" })]),
      wf("wf_disc", [trigger("n", "trigger.connector.inbound", { adapterId: "discord" })]),
      wf("wf_any", [trigger("n", "trigger.connector.inbound", {})]),
    ])
    const tg = findMatchingWorkflows("trigger.connector.inbound", { adapterId: "tg" })
    expect(tg.map((m) => m.workflowId)).toEqual(expect.arrayContaining(["wf_tg", "wf_any"]))
    expect(tg.map((m) => m.workflowId)).not.toContain("wf_disc")
  })

  it("matches chat.message by characterId and optionally by sessionId", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_global", [trigger("n", "trigger.chat.message", { characterId: "char_a" })]),
      wf("wf_scoped", [
        trigger("n", "trigger.chat.message", { characterId: "char_a", sessionId: "sess_42" }),
      ]),
    ])
    const broad = findMatchingWorkflows("trigger.chat.message", {
      characterId: "char_a",
      sessionId: "sess_99",
    })
    expect(broad.map((m) => m.workflowId)).toEqual(["wf_global"])
    const narrow = findMatchingWorkflows("trigger.chat.message", {
      characterId: "char_a",
      sessionId: "sess_42",
    })
    expect(narrow.map((m) => m.workflowId)).toEqual(
      expect.arrayContaining(["wf_global", "wf_scoped"])
    )
  })

  it("indexes goal.completed and matches by goalId / status (unscoped matches any)", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_any", [trigger("n", "trigger.goal.completed", {})]),
      wf("wf_goal", [trigger("n", "trigger.goal.completed", { goalId: "g1" })]),
      wf("wf_status", [trigger("n", "trigger.goal.completed", { status: "completed" })]),
    ])
    expect(_peekTriggerSubscriptions().get("trigger.goal.completed")).toHaveLength(3)

    const g1Completed = findMatchingWorkflows("trigger.goal.completed", {
      goalId: "g1",
      status: "completed",
    })
    expect(g1Completed.map((m) => m.workflowId)).toEqual(
      expect.arrayContaining(["wf_any", "wf_goal", "wf_status"])
    )

    // A different goal that stopped: only the unscoped node fires.
    const otherStopped = findMatchingWorkflows("trigger.goal.completed", {
      goalId: "g2",
      status: "stopped",
    })
    expect(otherStopped.map((m) => m.workflowId)).toEqual(["wf_any"])
  })

  it("indexes terminal.command and matches by session / project / status / substring", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_any", [trigger("n", "trigger.terminal.command", {})]),
      wf("wf_sess", [trigger("n", "trigger.terminal.command", { sessionId: "tab-1" })]),
      wf("wf_proj", [trigger("n", "trigger.terminal.command", { projectId: "proj-1" })]),
      wf("wf_fail", [trigger("n", "trigger.terminal.command", { status: "failure" })]),
      wf("wf_sub", [trigger("n", "trigger.terminal.command", { commandContains: "pnpm test" })]),
    ])
    expect(_peekTriggerSubscriptions().get("trigger.terminal.command")).toHaveLength(5)

    const all = findMatchingWorkflows("trigger.terminal.command", {
      sessionId: "tab-1",
      projectId: "proj-1",
      status: "failure",
      command: "pnpm test -- --coverage",
    })
    expect(all.map((m) => m.workflowId)).toEqual(
      expect.arrayContaining(["wf_any", "wf_sess", "wf_proj", "wf_fail", "wf_sub"])
    )

    // A successful command in another tab/project: only the unscoped node fires.
    const other = findMatchingWorkflows("trigger.terminal.command", {
      sessionId: "tab-2",
      projectId: "proj-2",
      status: "success",
      command: "git status",
    })
    expect(other.map((m) => m.workflowId)).toEqual(["wf_any"])
  })

  it("a commandContains filter never matches a redacted (empty) command", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_sub", [trigger("n", "trigger.terminal.command", { commandContains: "deploy" })]),
      wf("wf_any", [trigger("n", "trigger.terminal.command", {})]),
    ])
    const matches = findMatchingWorkflows("trigger.terminal.command", {
      sessionId: "tab-1",
      status: "success",
      command: "",
    })
    expect(matches.map((m) => m.workflowId)).toEqual(["wf_any"])
  })

  it("returns an empty array when nothing matches or cache is empty", () => {
    expect(findMatchingWorkflows("trigger.chat.message", {})).toEqual([])
    _seedTriggerSubscriptionsForTest([])
    expect(findMatchingWorkflows("trigger.chat.message", { characterId: "x" })).toEqual([])
  })

  it("disposeTriggerSubscriptions clears the cache", () => {
    _seedTriggerSubscriptionsForTest([wf("wf", [trigger("n", "trigger.chat.message", {})])])
    expect(findMatchingWorkflows("trigger.chat.message", {}).length).toBeGreaterThan(0)
    disposeTriggerSubscriptions()
    expect(findMatchingWorkflows("trigger.chat.message", {})).toEqual([])
  })
})
