import type { ResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"

import {
  AgentCapabilityError,
  createAgentExecutionHandle,
  FrozenModelBindingError,
  nextCommandId,
} from "./agent-execution-handle"

function spec(overrides: Partial<ResolvedAgentExecutionSpec> = {}): ResolvedAgentExecutionSpec {
  return {
    specVersion: 1,
    identity: { sessionId: "s1", runId: "r1", attemptId: "a1" },
    executionFingerprint: "aexf1-x",
    executionKind: "agent",
    runtimeAdapter: "claude-agent-sdk",
    runtimePolicySource: "auto",
    modelBindings: { primary: "claude-sonnet-5", fast: "claude-haiku-4-5-20251001" },
    route: { kind: "direct", routePolicy: "direct" },
    hostRef: "desktop-sidecar",
    compatibility: { evidence: "native" },
    capabilities: {
      effective: [
        "streaming",
        "compaction",
        "permissions.interrupt-resume",
        "permissions.set-mode",
        "set-model",
      ],
      disabledOptional: [],
    },
    fallbackPolicy: "none",
    ...overrides,
  }
}

function makeDeps() {
  return {
    ipc: {
      interruptSession: jest.fn().mockResolvedValue(undefined),
      compactSession: jest.fn().mockResolvedValue(undefined),
      setSessionMode: jest.fn().mockResolvedValue(undefined),
      setSessionModel: jest.fn().mockResolvedValue(undefined),
      subscribeAgentEvents: jest.fn().mockImplementation(async (cb: (e: unknown) => void) => {
        makeDeps.lastSubscriber = cb
        return jest.fn()
      }),
      resolvePermission: jest.fn().mockResolvedValue(undefined),
    },
    closeSession: jest.fn().mockResolvedValue(undefined),
  }
}
makeDeps.lastSubscriber = undefined as unknown as (e: unknown) => void

describe("createAgentExecutionHandle", () => {
  it("routes supported commands through the injected IPC", async () => {
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", spec(), deps)

    await handle.interrupt()
    await handle.compact("focus")
    await handle.resolvePermission("req-1", "allow", { message: "ok" })
    await handle.setPermissionMode("plan")
    await handle.cancel()

    expect(deps.ipc.interruptSession).toHaveBeenCalledWith("s1")
    expect(deps.ipc.compactSession).toHaveBeenCalledWith("s1", "focus")
    expect(deps.ipc.resolvePermission).toHaveBeenCalledWith("s1", "req-1", "allow", "ok", undefined)
    expect(deps.ipc.setSessionMode).toHaveBeenCalledWith("s1", "plan")
    expect(deps.closeSession).toHaveBeenCalledWith("s1")
  })

  it("throws typed capability errors BEFORE any IPC for unsupported commands", async () => {
    const deps = makeDeps()
    const limited = spec({
      capabilities: { effective: ["streaming"], disabledOptional: [] },
    })
    const handle = createAgentExecutionHandle("s1", limited, deps)

    await expect(handle.compact()).rejects.toThrow(AgentCapabilityError)
    await expect(handle.setModel("claude-sonnet-5")).rejects.toThrow(AgentCapabilityError)
    await expect(handle.setPermissionMode("plan")).rejects.toThrow(AgentCapabilityError)
    await expect(handle.resolvePermission("r", "deny")).rejects.toThrow(AgentCapabilityError)
    expect(deps.ipc.compactSession).not.toHaveBeenCalled()
    expect(deps.ipc.setSessionModel).not.toHaveBeenCalled()
    expect(deps.ipc.setSessionMode).not.toHaveBeenCalled()
    expect(deps.ipc.resolvePermission).not.toHaveBeenCalled()
  })

  it("setModel only accepts models frozen into the spec bindings", async () => {
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", spec(), deps)

    await handle.setModel("claude-haiku-4-5-20251001")
    expect(deps.ipc.setSessionModel).toHaveBeenCalledWith("s1", "claude-haiku-4-5-20251001")

    await expect(handle.setModel("gpt-4o")).rejects.toThrow(FrozenModelBindingError)
    expect(deps.ipc.setSessionModel).toHaveBeenCalledTimes(1)
  })

  it("filters envelope events to this session", async () => {
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", spec(), deps)
    const seen: unknown[] = []
    await handle.events((e) => seen.push(e))

    const subscriber = makeDeps.lastSubscriber
    subscriber({ sessionId: "s1", sequence: 0 })
    subscriber({ sessionId: "other", sequence: 0 })
    expect(seen).toHaveLength(1)
  })

  it("mints unique idempotency command ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextCommandId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^cmd-\d+-/)
  })
})
