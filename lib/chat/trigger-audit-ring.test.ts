import {
  recordTriggerAuditEntry,
  listTriggerAuditEntries,
  listAllTriggerAuditEntries,
  countTriggerAuditForMessage,
  clearTriggerAuditForSession,
  clearAllTriggerAudit,
  subscribeTriggerAuditChanges,
  getTriggerAuditRevision,
} from "./trigger-audit-ring"

beforeEach(() => {
  clearAllTriggerAudit()
})

afterEach(() => {
  clearAllTriggerAudit()
})

describe("trigger-audit-ring", () => {
  it("records an entry and surfaces it via listTriggerAuditEntries", () => {
    recordTriggerAuditEntry({
      sessionId: "s1",
      messageId: "m1",
      kind: "trigger.chat.message",
      pluginId: null,
      workflowId: "wf1",
      status: "dispatched",
    })
    const rows = listTriggerAuditEntries({ sessionId: "s1" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sessionId: "s1",
      messageId: "m1",
      kind: "trigger.chat.message",
      workflowId: "wf1",
      status: "dispatched",
    })
    expect(rows[0].id).toMatch(/^tau-/)
    expect(typeof rows[0].timestamp).toBe("number")
  })

  it("countTriggerAuditForMessage returns the right tally", () => {
    recordTriggerAuditEntry({
      sessionId: "s1",
      messageId: "m1",
      kind: "trigger.chat.message",
      pluginId: null,
      workflowId: "wf1",
      status: "dispatched",
    })
    recordTriggerAuditEntry({
      sessionId: "s1",
      messageId: "m1",
      kind: "trigger.chat.message",
      pluginId: null,
      workflowId: "wf2",
      status: "dispatched",
    })
    recordTriggerAuditEntry({
      sessionId: "s1",
      messageId: "m2",
      kind: "trigger.chat.message",
      pluginId: null,
      workflowId: "wf3",
      status: "dispatched",
    })
    expect(countTriggerAuditForMessage("s1", "m1")).toBe(2)
    expect(countTriggerAuditForMessage("s1", "m2")).toBe(1)
    expect(countTriggerAuditForMessage("s1", "missing")).toBe(0)
  })

  it("filters by messageId / pluginId / kind", () => {
    recordTriggerAuditEntry({
      sessionId: "s1",
      messageId: "m1",
      kind: "trigger.plugin-a.x",
      pluginId: "plugin-a",
      workflowId: "wf-a",
      status: "dispatched",
    })
    recordTriggerAuditEntry({
      sessionId: "s1",
      messageId: "m1",
      kind: "trigger.plugin-b.y",
      pluginId: "plugin-b",
      workflowId: "wf-b",
      status: "rejected",
    })
    expect(listTriggerAuditEntries({ sessionId: "s1", pluginId: "plugin-a" })).toHaveLength(1)
    expect(listTriggerAuditEntries({ sessionId: "s1", kind: "trigger.plugin-b.y" })).toHaveLength(1)
    expect(listTriggerAuditEntries({ sessionId: "s1", messageId: "m2" })).toHaveLength(0)
  })

  it("caps each session at 200 entries (oldest dropped)", () => {
    for (let i = 0; i < 250; i++) {
      recordTriggerAuditEntry({
        sessionId: "s1",
        messageId: `m${i}`,
        kind: "trigger.chat.message",
        pluginId: null,
        workflowId: "wf",
        status: "dispatched",
      })
    }
    const rows = listTriggerAuditEntries({ sessionId: "s1" })
    expect(rows).toHaveLength(200)
    // Oldest should be m50 onwards.
    expect(rows[0].messageId).toBe("m50")
  })

  it("listAllTriggerAuditEntries returns across sessions newest last", () => {
    recordTriggerAuditEntry({
      sessionId: "s-a",
      messageId: "m1",
      kind: "trigger.chat.message",
      pluginId: null,
      workflowId: "wf",
      status: "dispatched",
      timestamp: 100,
    })
    recordTriggerAuditEntry({
      sessionId: "s-b",
      messageId: "m2",
      kind: "trigger.chat.message",
      pluginId: null,
      workflowId: "wf",
      status: "dispatched",
      timestamp: 200,
    })
    const all = listAllTriggerAuditEntries()
    expect(all.map((e) => e.sessionId)).toEqual(["s-a", "s-b"])
  })

  it("clearTriggerAuditForSession only drops the targeted session", () => {
    recordTriggerAuditEntry({
      sessionId: "s-a",
      messageId: "m1",
      kind: "trigger.chat.message",
      pluginId: null,
      workflowId: "wf",
      status: "dispatched",
    })
    recordTriggerAuditEntry({
      sessionId: "s-b",
      messageId: "m1",
      kind: "trigger.chat.message",
      pluginId: null,
      workflowId: "wf",
      status: "dispatched",
    })
    clearTriggerAuditForSession("s-a")
    expect(listTriggerAuditEntries({ sessionId: "s-a" })).toEqual([])
    expect(listTriggerAuditEntries({ sessionId: "s-b" })).toHaveLength(1)
  })

  it("subscribe fires on record + clear, returns disposer that stops events", () => {
    const beforeRevision = getTriggerAuditRevision()
    const calls: number[] = []
    const dispose = subscribeTriggerAuditChanges(() => calls.push(1))
    recordTriggerAuditEntry({
      sessionId: "s1",
      messageId: "m1",
      kind: "trigger.chat.message",
      pluginId: null,
      workflowId: "wf",
      status: "dispatched",
    })
    expect(calls.length).toBeGreaterThan(0)
    expect(getTriggerAuditRevision()).toBeGreaterThan(beforeRevision)
    clearTriggerAuditForSession("s1")
    expect(calls.length).toBeGreaterThanOrEqual(2)
    dispose()
    const after = calls.length
    recordTriggerAuditEntry({
      sessionId: "s1",
      messageId: "m1",
      kind: "trigger.chat.message",
      pluginId: null,
      workflowId: "wf",
      status: "dispatched",
    })
    expect(calls.length).toBe(after) // unsubscribed
  })
})
