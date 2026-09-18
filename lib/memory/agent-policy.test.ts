import { resolveAgentMemoryPolicy, scopeAllowedByAgentMemoryPolicy } from "./agent-policy"
import { DEFAULT_MEMORY_CONFIG } from "@/types/memory/memory"

const restrictive = {
  operations: { recall: false, create: true, update: false, forget: false },
  readableScopes: ["character" as const],
  writableScopes: ["agent" as const],
  autoLearn: false,
}

describe("resolveAgentMemoryPolicy", () => {
  it("keeps the application policy as an upper bound", () => {
    const resolved = resolveAgentMemoryPolicy({
      config: { ...DEFAULT_MEMORY_CONFIG, enabled: false },
      agentPolicy: restrictive,
      session: { memoryUse: true, memoryLearn: true },
    })
    expect(resolved.canRecall).toBe(false)
    expect(resolved.canCreate).toBe(false)
    expect(resolved.canUpdate).toBe(false)
    expect(resolved.canForget).toBe(false)
    expect(resolved.canAutoLearn).toBe(false)
  })

  it("never lets a session toggle override an Agent's hard operation deny", () => {
    const resolved = resolveAgentMemoryPolicy({
      config: DEFAULT_MEMORY_CONFIG,
      agentPolicy: restrictive,
      session: { memoryUse: true, memoryLearn: true },
    })
    // operations.recall=false and autoLearn=false are the Agent's contract —
    // a chat with memory switched on can only NARROW, never widen them.
    expect(resolved.canRecall).toBe(false)
    expect(resolved.recallReason).toBe("agent_policy")
    expect(resolved.canAutoLearn).toBe(false)
    expect(resolved.learnReason).toBe("agent_policy")
    expect(resolved.canUpdate).toBe(false)
  })

  it("lets an explicit session opt-in re-enable operations the Agent leaves open", () => {
    const resolved = resolveAgentMemoryPolicy({
      config: DEFAULT_MEMORY_CONFIG,
      agentPolicy: {
        operations: { recall: true, create: true, update: false, forget: false },
        readableScopes: ["character" as const],
        writableScopes: ["agent" as const],
        autoLearn: true,
      },
      session: { memoryUse: true, memoryLearn: true },
    })
    expect(resolved.canRecall).toBe(true)
    expect(resolved.canAutoLearn).toBe(true)
    expect(resolved.canUpdate).toBe(false)
  })

  it("treats global recall and learning toggles as session-overridable defaults", () => {
    const resolved = resolveAgentMemoryPolicy({
      config: { ...DEFAULT_MEMORY_CONFIG, useMemory: false, learnFromChats: false },
      session: { memoryUse: true, memoryLearn: true },
    })
    expect(resolved.canRecall).toBe(true)
    expect(resolved.canAutoLearn).toBe(true)
  })

  it("lets a session opt-out deny what every higher layer allowed", () => {
    const resolved = resolveAgentMemoryPolicy({
      config: DEFAULT_MEMORY_CONFIG,
      session: { memoryUse: false, memoryLearn: false },
    })
    expect(resolved.canRecall).toBe(false)
    expect(resolved.recallReason).toBe("disabled_for_chat")
    expect(resolved.canAutoLearn).toBe(false)
    expect(resolved.learnReason).toBe("disabled_for_chat")
  })

  it("separates CRUD permissions and scope allowlists", () => {
    const resolved = resolveAgentMemoryPolicy({
      config: DEFAULT_MEMORY_CONFIG,
      agentPolicy: restrictive,
    })
    expect(resolved).toMatchObject({
      canRecall: false,
      canCreate: true,
      canUpdate: false,
      canForget: false,
      canAutoLearn: false,
      readableScopes: ["character"],
      writableScopes: ["agent"],
    })
    expect(scopeAllowedByAgentMemoryPolicy(resolved, "recall", "character")).toBe(false)
    expect(scopeAllowedByAgentMemoryPolicy(resolved, "create", "global")).toBe(false)
    // A session opt-in cannot reopen a hard `recall: false` — the Agent deny
    // is the ceiling the session can only narrow.
    expect(
      scopeAllowedByAgentMemoryPolicy(
        resolveAgentMemoryPolicy({
          config: DEFAULT_MEMORY_CONFIG,
          agentPolicy: restrictive,
          session: { memoryUse: true },
        }),
        "recall",
        "character"
      )
    ).toBe(false)
  })

  it("defaults legacy Agents to all operations and scopes", () => {
    const resolved = resolveAgentMemoryPolicy({ config: DEFAULT_MEMORY_CONFIG })
    expect(resolved.canRecall).toBe(true)
    expect(resolved.canCreate).toBe(true)
    expect(resolved.canUpdate).toBe(true)
    expect(resolved.canForget).toBe(true)
    expect(resolved.readableScopes).toEqual(["global", "workspace", "character", "agent"])
  })

  it("blocks automatic learning in temporary or untrusted external contexts", () => {
    expect(
      resolveAgentMemoryPolicy({
        config: DEFAULT_MEMORY_CONFIG,
        externalContext: ["web-search"],
      }).canAutoLearn
    ).toBe(false)
    expect(
      resolveAgentMemoryPolicy({
        config: { ...DEFAULT_MEMORY_CONFIG, temporary: true },
      }).canAutoLearn
    ).toBe(false)
  })
})
