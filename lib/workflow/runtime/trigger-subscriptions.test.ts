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
