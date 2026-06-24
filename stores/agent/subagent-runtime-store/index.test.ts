/**
 * @jest-environment jsdom
 */

import { useSubagentRuntimeStore } from "./index"
import { BUILT_IN_SUBAGENT_TEMPLATES } from "@/types/agent/sub-agent"
import type { SubAgent, SubAgentLog, SubAgentTemplate } from "@/types/agent/sub-agent"

function snapshot() {
  return useSubagentRuntimeStore.getState()
}

function makeSubAgent(overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    id: "sa-1",
    parentAgentId: "parent-1",
    name: "test",
    description: "",
    task: "do things",
    initialTask: "do things",
    threadId: "t-1",
    status: "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 0,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    retryCount: 0,
    order: 0,
    ...overrides,
  }
}

beforeEach(() => {
  // Reset store state to seed templates + empty runtime between tests.
  useSubagentRuntimeStore.setState((s) => {
    const seeded: Record<string, SubAgentTemplate> = {}
    for (const t of BUILT_IN_SUBAGENT_TEMPLATES) seeded[t.id] = t
    return { ...s, templates: seeded, subAgents: {} }
  })
})

describe("subagent-runtime-store — templates slice", () => {
  it("seeds built-in templates", () => {
    expect(Object.keys(snapshot().templates).length).toBe(BUILT_IN_SUBAGENT_TEMPLATES.length)
    expect(snapshot().templates["research-web"]?.isBuiltIn).toBe(true)
  })

  it("addTemplate stores a user template", () => {
    snapshot().addTemplate({
      id: "user-1",
      name: "Mine",
      description: "",
      category: "general",
      taskTemplate: "{{x}}",
      config: {},
      isBuiltIn: false,
    })
    expect(snapshot().templates["user-1"]?.name).toBe("Mine")
  })

  it("updateTemplate refuses to mutate built-ins", () => {
    const before = snapshot().templates["research-web"]
    snapshot().updateTemplate("research-web", { name: "should not change" })
    expect(snapshot().templates["research-web"]).toEqual(before)
  })

  it("updateTemplate patches a user template", () => {
    snapshot().addTemplate({
      id: "u",
      name: "first",
      description: "",
      category: "general",
      taskTemplate: "",
      config: {},
      isBuiltIn: false,
    })
    snapshot().updateTemplate("u", { name: "second" })
    expect(snapshot().templates.u?.name).toBe("second")
  })

  it("updateTemplate is a no-op for unknown ids", () => {
    const before = { ...snapshot().templates }
    snapshot().updateTemplate("missing", { name: "x" })
    expect(snapshot().templates).toEqual(before)
  })

  it("deleteTemplate refuses to delete built-ins", () => {
    snapshot().deleteTemplate("research-web")
    expect(snapshot().templates["research-web"]).toBeDefined()
  })

  it("deleteTemplate removes a user template", () => {
    snapshot().addTemplate({
      id: "u",
      name: "x",
      description: "",
      category: "general",
      taskTemplate: "",
      config: {},
      isBuiltIn: false,
    })
    snapshot().deleteTemplate("u")
    expect(snapshot().templates.u).toBeUndefined()
  })

  it("deleteTemplate is a no-op for unknown ids", () => {
    const before = { ...snapshot().templates }
    snapshot().deleteTemplate("missing")
    expect(snapshot().templates).toEqual(before)
  })
})

describe("subagent-runtime-store — runtime slice", () => {
  it("upsert stores a fresh subagent", () => {
    snapshot().upsert(makeSubAgent())
    expect(snapshot().subAgents["sa-1"]?.name).toBe("test")
  })

  it("upsert overwrites prior entry with same id (idempotent for replays)", () => {
    snapshot().upsert(makeSubAgent({ name: "v1" }))
    snapshot().upsert(makeSubAgent({ name: "v2" }))
    expect(snapshot().subAgents["sa-1"]?.name).toBe("v2")
    expect(Object.keys(snapshot().subAgents)).toHaveLength(1)
  })

  it("setStatus updates status and stamps completedAt for terminal states", () => {
    snapshot().upsert(makeSubAgent({ status: "running", completedAt: undefined }))
    snapshot().setStatus("sa-1", "completed")
    expect(snapshot().subAgents["sa-1"]?.status).toBe("completed")
    expect(snapshot().subAgents["sa-1"]?.completedAt).toBeInstanceOf(Date)
  })

  it("setStatus does NOT set completedAt for transient states", () => {
    snapshot().upsert(makeSubAgent({ status: "running", completedAt: undefined }))
    snapshot().setStatus("sa-1", "queued")
    expect(snapshot().subAgents["sa-1"]?.completedAt).toBeUndefined()
  })

  it("setStatus is a no-op when the subagent is unknown", () => {
    snapshot().setStatus("missing", "completed")
    expect(snapshot().subAgents.missing).toBeUndefined()
  })

  it("setProgress clamps to [0, 100]", () => {
    snapshot().upsert(makeSubAgent({ progress: 0 }))
    snapshot().setProgress("sa-1", 150)
    expect(snapshot().subAgents["sa-1"]?.progress).toBe(100)
    snapshot().setProgress("sa-1", -10)
    expect(snapshot().subAgents["sa-1"]?.progress).toBe(0)
    snapshot().setProgress("sa-1", 42)
    expect(snapshot().subAgents["sa-1"]?.progress).toBe(42)
  })

  it("setProgress is a no-op when the subagent is unknown", () => {
    snapshot().setProgress("missing", 50)
    expect(snapshot().subAgents.missing).toBeUndefined()
  })

  it("appendLog appends in order", () => {
    snapshot().upsert(makeSubAgent({ logs: [] }))
    const a: SubAgentLog = { timestamp: new Date(), level: "info", message: "first" }
    const b: SubAgentLog = { timestamp: new Date(), level: "warn", message: "second" }
    snapshot().appendLog("sa-1", a)
    snapshot().appendLog("sa-1", b)
    expect(snapshot().subAgents["sa-1"]?.logs).toHaveLength(2)
    expect(snapshot().subAgents["sa-1"]?.logs[1].message).toBe("second")
  })

  it("appendLog is a no-op when the subagent is unknown", () => {
    snapshot().appendLog("missing", {
      timestamp: new Date(),
      level: "info",
      message: "x",
    })
    expect(snapshot().subAgents.missing).toBeUndefined()
  })

  it("appendLog caps the log at the last 50 entries", () => {
    snapshot().upsert(makeSubAgent({ logs: [] }))
    for (let i = 0; i < 60; i++) {
      snapshot().appendLog("sa-1", { timestamp: new Date(), level: "info", message: `m${i}` })
    }
    const logs = snapshot().subAgents["sa-1"]!.logs
    expect(logs).toHaveLength(50)
    expect(logs[0].message).toBe("m10")
    expect(logs[49].message).toBe("m59")
  })

  it("pushStreamText coalesces consecutive streaming text into one entry", () => {
    snapshot().upsert(makeSubAgent({ logs: [] }))
    snapshot().pushStreamText("sa-1", "Hel")
    snapshot().pushStreamText("sa-1", "Hello")
    let logs = snapshot().subAgents["sa-1"]!.logs
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe("Hello")
    // A non-text log breaks the run; the next text starts a fresh entry.
    snapshot().appendLog("sa-1", { timestamp: new Date(), level: "info", message: "Read" })
    snapshot().pushStreamText("sa-1", "World")
    logs = snapshot().subAgents["sa-1"]!.logs
    expect(logs.map((l) => l.message)).toEqual(["Hello", "Read", "World"])
  })

  it("pushStreamText is a no-op when the subagent is unknown", () => {
    expect(() => snapshot().pushStreamText("missing", "x")).not.toThrow()
    expect(snapshot().subAgents.missing).toBeUndefined()
  })

  it("remove drops a single subagent", () => {
    snapshot().upsert(makeSubAgent())
    snapshot().remove("sa-1")
    expect(snapshot().subAgents["sa-1"]).toBeUndefined()
  })

  it("remove is a no-op when the subagent is unknown", () => {
    const before = { ...snapshot().subAgents }
    snapshot().remove("missing")
    expect(snapshot().subAgents).toEqual(before)
  })

  it("clearRuntime empties the runtime registry but keeps templates", () => {
    snapshot().upsert(makeSubAgent({ id: "a" }))
    snapshot().upsert(makeSubAgent({ id: "b" }))
    snapshot().clearRuntime()
    expect(Object.keys(snapshot().subAgents)).toHaveLength(0)
    expect(Object.keys(snapshot().templates).length).toBeGreaterThan(0)
  })
})
