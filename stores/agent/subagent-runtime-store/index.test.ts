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

  it("setToolUses stores a floored, non-negative count", () => {
    snapshot().upsert(makeSubAgent())
    snapshot().setToolUses("sa-1", 4)
    expect(snapshot().subAgents["sa-1"]?.toolUses).toBe(4)
    snapshot().setToolUses("sa-1", 7.9)
    expect(snapshot().subAgents["sa-1"]?.toolUses).toBe(7)
    snapshot().setToolUses("sa-1", -3)
    expect(snapshot().subAgents["sa-1"]?.toolUses).toBe(0)
  })

  it("setToolUses is a no-op when the subagent is unknown", () => {
    snapshot().setToolUses("missing", 5)
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

  describe("applyRunEvent (batched log + progress + toolUses)", () => {
    it("applies all three fields in one write, with the same caps/clamps", () => {
      snapshot().upsert(makeSubAgent({ logs: [], progress: 0, toolUses: 0 }))
      snapshot().applyRunEvent("sa-1", {
        log: { timestamp: new Date(), level: "info", message: "Running Bash" },
        progress: 150,
        toolUses: 3.9,
      })
      const sa = snapshot().subAgents["sa-1"]!
      expect(sa.logs).toHaveLength(1)
      expect(sa.logs[0].message).toBe("Running Bash")
      expect(sa.progress).toBe(100) // clamped
      expect(sa.toolUses).toBe(3) // floored
      expect(sa.lastActivityAt).toBeInstanceOf(Date)
    })

    it("applies a partial patch (log only) without touching progress/toolUses", () => {
      snapshot().upsert(makeSubAgent({ logs: [], progress: 42, toolUses: 5 }))
      snapshot().applyRunEvent("sa-1", {
        log: { timestamp: new Date(), level: "warn", message: "Bash failed" },
      })
      const sa = snapshot().subAgents["sa-1"]!
      expect(sa.logs[0].message).toBe("Bash failed")
      expect(sa.progress).toBe(42)
      expect(sa.toolUses).toBe(5)
    })

    it("returns the SAME state reference for a no-op patch (no spurious notify)", () => {
      snapshot().upsert(makeSubAgent())
      const before = snapshot().subAgents
      snapshot().applyRunEvent("sa-1", {})
      expect(snapshot().subAgents).toBe(before)
    })

    it("caps the log at the last 50 entries", () => {
      snapshot().upsert(makeSubAgent({ logs: [] }))
      for (let i = 0; i < 60; i++) {
        snapshot().applyRunEvent("sa-1", {
          log: { timestamp: new Date(), level: "info", message: `m${i}` },
        })
      }
      const logs = snapshot().subAgents["sa-1"]!.logs
      expect(logs).toHaveLength(50)
      expect(logs[0].message).toBe("m10")
      expect(logs[49].message).toBe("m59")
    })

    it("is a no-op when the subagent is unknown", () => {
      snapshot().applyRunEvent("missing", { progress: 10 })
      expect(snapshot().subAgents.missing).toBeUndefined()
    })

    it("toolStart pushes a running tool call", () => {
      snapshot().upsert(makeSubAgent({ toolCalls: [] }))
      snapshot().applyRunEvent("sa-1", {
        toolStart: { id: "t1", name: "read", input: { path: "a.ts" } },
      })
      const calls = snapshot().subAgents["sa-1"]!.toolCalls!
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        id: "t1",
        name: "read",
        state: "running",
        input: { path: "a.ts" },
      })
    })

    it("toolEnd resolves the matching call by id", () => {
      snapshot().upsert(makeSubAgent({ toolCalls: [] }))
      snapshot().applyRunEvent("sa-1", { toolStart: { id: "t1", name: "grep" } })
      snapshot().applyRunEvent("sa-1", { toolEnd: { id: "t1", output: "5 matches" } })
      const call = snapshot().subAgents["sa-1"]!.toolCalls![0]
      expect(call.state).toBe("done")
      expect(call.output).toBe("5 matches")
    })

    it("toolEnd marks error state when isError", () => {
      snapshot().upsert(makeSubAgent({ toolCalls: [] }))
      snapshot().applyRunEvent("sa-1", { toolStart: { id: "t1", name: "bash" } })
      snapshot().applyRunEvent("sa-1", { toolEnd: { id: "t1", output: "boom", isError: true } })
      const call = snapshot().subAgents["sa-1"]!.toolCalls![0]
      expect(call.state).toBe("error")
      expect(call.isError).toBe(true)
    })

    it("toolEnd is a no-op (no change) when the id is unknown", () => {
      snapshot().upsert(makeSubAgent({ toolCalls: [] }))
      const before = snapshot().subAgents
      snapshot().applyRunEvent("sa-1", { toolEnd: { id: "nope", output: "x" } })
      expect(snapshot().subAgents).toBe(before)
    })

    it("usage patch replaces the live cumulative token usage", () => {
      snapshot().upsert(makeSubAgent({}))
      snapshot().applyRunEvent("sa-1", {
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      })
      expect(snapshot().subAgents["sa-1"]!.tokenUsage).toEqual({
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      })
    })

    it("retry patch bumps retryCount (floored, non-negative)", () => {
      snapshot().upsert(makeSubAgent({ retryCount: 0 }))
      snapshot().applyRunEvent("sa-1", { retry: { attempt: 2.9 } })
      expect(snapshot().subAgents["sa-1"]!.retryCount).toBe(2)
      snapshot().applyRunEvent("sa-1", { retry: { attempt: -5 } })
      expect(snapshot().subAgents["sa-1"]!.retryCount).toBe(0)
    })

    it("caps the tool-call list at the last 100 entries", () => {
      snapshot().upsert(makeSubAgent({ toolCalls: [] }))
      for (let i = 0; i < 110; i++) {
        snapshot().applyRunEvent("sa-1", { toolStart: { id: `t${i}`, name: "x" } })
      }
      const calls = snapshot().subAgents["sa-1"]!.toolCalls!
      expect(calls).toHaveLength(100)
      expect(calls[0].id).toBe("t10")
      expect(calls[99].id).toBe("t109")
    })
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
