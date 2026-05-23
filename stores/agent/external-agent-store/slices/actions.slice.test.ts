/**
 * @jest-environment jsdom
 */
import { useExternalAgentStore } from "../store"

jest.mock("@/lib/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    loggers: {
      agent: { ...child, child: () => child },
    },
  }
})

const reset = () => {
  useExternalAgentStore.getState().reset()
}

describe("useExternalAgentStore CRUD", () => {
  beforeEach(() => {
    reset()
    jest.clearAllMocks()
  })

  it("addAgent stores a new agent and returns its id", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "Claude Code",
      protocol: "acp",
      transport: "stdio",
      process: { command: "npx", args: ["claude-code"] },
    })
    expect(id).toBeTruthy()
    const stored = useExternalAgentStore.getState().getAgent(id)
    expect(stored).toBeDefined()
    expect(stored!.name).toBe("Claude Code")
  })

  it("updateAgent merges patches", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "Original",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    useExternalAgentStore.getState().updateAgent(id, { name: "Renamed" })
    expect(useExternalAgentStore.getState().getAgent(id)!.name).toBe("Renamed")
  })

  it("removeAgent removes the agent and clears active state if matched", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "Doomed",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    useExternalAgentStore.getState().setActiveAgent(id)
    useExternalAgentStore.getState().removeAgent(id)
    expect(useExternalAgentStore.getState().getAgent(id)).toBeUndefined()
    expect(useExternalAgentStore.getState().activeAgentId).toBeNull()
  })

  it("getAllAgents returns the in-store ExternalAgentConfig list", () => {
    useExternalAgentStore.getState().addAgent({
      name: "A",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    useExternalAgentStore.getState().addAgent({
      name: "B",
      protocol: "acp",
      transport: "stdio",
      process: { command: "y" },
    })
    expect(
      useExternalAgentStore
        .getState()
        .getAllAgents()
        .map((a) => a.name)
        .sort()
    ).toEqual(["A", "B"])
  })
})

describe("useExternalAgentStore connection status", () => {
  beforeEach(() => {
    reset()
  })

  it("setConnectionStatus / getConnectionStatus roundtrip", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "S",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    useExternalAgentStore.getState().setConnectionStatus(id, "connected")
    expect(useExternalAgentStore.getState().getConnectionStatus(id)).toBe("connected")
  })

  it("getConnectionStatus defaults to disconnected for unknown ids", () => {
    expect(useExternalAgentStore.getState().getConnectionStatus("nope")).toBe("disconnected")
  })
})

describe("useExternalAgentStore settings toggles", () => {
  beforeEach(() => {
    reset()
  })

  it("setEnabled / setAutoConnectOnStartup / setShowConnectionNotifications mutate flags", () => {
    useExternalAgentStore.getState().setEnabled(false)
    useExternalAgentStore.getState().setAutoConnectOnStartup(true)
    useExternalAgentStore.getState().setShowConnectionNotifications(false)
    expect(useExternalAgentStore.getState().enabled).toBe(false)
    expect(useExternalAgentStore.getState().autoConnectOnStartup).toBe(true)
    expect(useExternalAgentStore.getState().showConnectionNotifications).toBe(false)
  })

  it("setChatFailurePolicy switches between fallback / strict", () => {
    useExternalAgentStore.getState().setChatFailurePolicy("strict")
    expect(useExternalAgentStore.getState().chatFailurePolicy).toBe("strict")
    useExternalAgentStore.getState().setChatFailurePolicy("fallback")
    expect(useExternalAgentStore.getState().chatFailurePolicy).toBe("fallback")
  })
})

describe("useExternalAgentStore Tauri-only guards", () => {
  beforeEach(() => {
    reset()
    jest.clearAllMocks()
  })

  it("spawnAgent throws and never sets isLoading when not in Tauri", async () => {
    await expect(
      useExternalAgentStore
        .getState()
        .spawnAgent({ command: "x", args: [] } as unknown as Parameters<
          typeof useExternalAgentStore.getState extends () => { spawnAgent: infer F } ? F : never
        >[0])
    ).rejects.toThrow(/Tauri/)
    expect(useExternalAgentStore.getState().isLoading).toBe(false)
  })

  it("sendToAgent throws when not in Tauri", async () => {
    await expect(useExternalAgentStore.getState().sendToAgent("id", "msg")).rejects.toThrow(/Tauri/)
  })

  it("getRunningAgentStatus throws when not in Tauri", async () => {
    await expect(useExternalAgentStore.getState().getRunningAgentStatus("id")).rejects.toThrow(
      /Tauri/
    )
  })
})

describe("useExternalAgentStore error handling", () => {
  beforeEach(() => {
    reset()
  })

  it("clearLastError resets the lastError field", () => {
    useExternalAgentStore.setState({ lastError: "boom" })
    useExternalAgentStore.getState().clearLastError()
    expect(useExternalAgentStore.getState().lastError).toBeNull()
  })
})

describe("useExternalAgentStore addAgent extras", () => {
  beforeEach(() => reset())

  it("seeds an initial validity snapshot when one is provided", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "V",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
      validitySnapshot: {
        executable: true,
        checkedAt: new Date(),
        source: "config",
        sessionExtensions: {
          "session/list": { state: "unknown" },
          "session/fork": { state: "unknown" },
          "session/resume": { state: "unknown" },
        },
      },
    } as never)
    expect(useExternalAgentStore.getState().agentValidity[id]).toBeDefined()
  })
})

describe("useExternalAgentStore addAgentFromPreset", () => {
  beforeEach(() => reset())

  it("creates a new stored agent from a known preset id", () => {
    const id = useExternalAgentStore.getState().addAgentFromPreset("claude-code")
    expect(id).toBeTruthy()
    const agent = useExternalAgentStore.getState().getAgent(id!)
    expect(agent).toBeDefined()
    expect(useExternalAgentStore.getState().connectionStatus[id!]).toBe("disconnected")
  })

  it("returns null for an unknown preset id", () => {
    expect(useExternalAgentStore.getState().addAgentFromPreset("does-not-exist")).toBeNull()
  })

  it("normalizes an already-attached validity snapshot", () => {
    const id = useExternalAgentStore.getState().addAgentFromPreset("claude-code", {
      validitySnapshot: {
        executable: true,
        checkedAt: new Date(),
        source: "connect",
        sessionExtensions: {
          "session/list": { state: "supported" },
          "session/fork": { state: "supported" },
          "session/resume": { state: "supported" },
        },
      },
    } as never)
    expect(id).toBeTruthy()
    expect(useExternalAgentStore.getState().agentValidity[id!]).toBeDefined()
  })
})

describe("useExternalAgentStore validity / lastRun / benchmarks", () => {
  beforeEach(() => reset())

  function buildSnapshot(): import("@/types/agent/external-agent").ExternalAgentValiditySnapshot {
    return {
      executable: true,
      checkedAt: new Date(),
      source: "config",
      sessionExtensions: {
        "session/list": { state: "unknown" },
        "session/fork": { state: "unknown" },
        "session/resume": { state: "unknown" },
      },
    } as never
  }

  it("setAgentValidity / getAgentValidity roundtrip", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "S",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    useExternalAgentStore.getState().setAgentValidity(id, buildSnapshot())
    const got = useExternalAgentStore.getState().getAgentValidity(id)
    expect(got).toBeDefined()
  })

  it("setAgentValidity falls back to acp protocol when agent has been removed", () => {
    useExternalAgentStore.getState().setAgentValidity("missing", buildSnapshot())
    expect(useExternalAgentStore.getState().agentValidity["missing"]).toBeDefined()
  })

  it("setLastRunSnapshot / getLastRunSnapshot accepts Date and string timestamps", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "L",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    useExternalAgentStore.getState().setLastRunSnapshot(id, {
      timestamp: new Date(),
      success: true,
    } as never)
    expect(useExternalAgentStore.getState().getLastRunSnapshot(id)?.timestamp).toBeInstanceOf(Date)

    useExternalAgentStore.getState().setLastRunSnapshot(id, {
      timestamp: "2024-01-01T00:00:00.000Z",
      success: false,
    } as never)
    expect(useExternalAgentStore.getState().getLastRunSnapshot(id)?.timestamp).toBeInstanceOf(Date)
  })

  it("setLastRunSnapshot tolerates an invalid date string", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "L2",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    useExternalAgentStore.getState().setLastRunSnapshot(id, {
      timestamp: "not-a-date",
      success: false,
    } as never)
    expect(useExternalAgentStore.getState().getLastRunSnapshot(id)?.timestamp).toBeInstanceOf(Date)
  })

  it("setBenchmarkCapabilities throws when entries are invalid", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "B",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    expect(() =>
      useExternalAgentStore.getState().setBenchmarkCapabilities(id, [
        {
          id: "x",
          title: "x",
          referenceBehavior: "",
          cogniaBehavior: "",
          adaptationTarget: "",
          gapGrade: "minor",
          status: "validated",
          owner: "",
          evidence: [],
          updatedAt: new Date(),
        } as never,
      ])
    ).toThrow(/no executable evidence/)
  })

  it("setBenchmarkCapabilities accepts a valid entry list", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "B2",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    useExternalAgentStore.getState().setBenchmarkCapabilities(id, [
      {
        id: "ok",
        title: "ok",
        referenceBehavior: "",
        cogniaBehavior: "",
        adaptationTarget: "",
        gapGrade: "minor",
        status: "in-progress",
        owner: "",
        evidence: [],
        updatedAt: new Date(),
      } as never,
    ])
    expect(useExternalAgentStore.getState().getBenchmarkCapabilities(id)).toHaveLength(1)
  })

  it("upsertBenchmarkCapability inserts and replaces by id", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "B3",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    const entry = {
      id: "u",
      title: "u",
      referenceBehavior: "",
      cogniaBehavior: "",
      adaptationTarget: "",
      gapGrade: "minor",
      status: "in-progress",
      owner: "",
      evidence: [],
      updatedAt: new Date(),
    }
    useExternalAgentStore.getState().upsertBenchmarkCapability(id, entry as never)
    expect(useExternalAgentStore.getState().getBenchmarkCapabilities(id)).toHaveLength(
      1 + 4 // 1 inserted + 4 baseline (when entry id != baseline id we still keep baseline)
    )
    // Replace by same id
    useExternalAgentStore
      .getState()
      .upsertBenchmarkCapability(id, { ...entry, title: "renamed" } as never)
    expect(
      useExternalAgentStore
        .getState()
        .getBenchmarkCapabilities(id)
        .find((e) => e.id === "u")?.title
    ).toBe("renamed")
  })

  it("upsertBenchmarkCapability throws on invalid entry", () => {
    expect(() =>
      useExternalAgentStore.getState().upsertBenchmarkCapability("x", {
        id: "bad",
        title: "",
        referenceBehavior: "",
        cogniaBehavior: "",
        adaptationTarget: "",
        gapGrade: "minor",
        status: "validated",
        owner: "",
        evidence: [],
        updatedAt: new Date(),
      } as never)
    ).toThrow(/no executable evidence/)
  })

  it("upsertBenchmarkCapability seeds entries map for unknown agents", () => {
    const entry = {
      id: "fresh",
      title: "fresh",
      referenceBehavior: "",
      cogniaBehavior: "",
      adaptationTarget: "",
      gapGrade: "minor",
      status: "in-progress",
      owner: "",
      evidence: [],
      updatedAt: new Date(),
    }
    useExternalAgentStore.getState().upsertBenchmarkCapability("ghost", entry as never)
    expect(useExternalAgentStore.getState().getBenchmarkCapabilities("ghost")).toHaveLength(1)
  })

  it("normalizeBenchmarkEntry handles deviations with string updatedAt", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "BD",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    useExternalAgentStore.getState().setBenchmarkCapabilities(id, [
      {
        id: "dev",
        title: "dev",
        referenceBehavior: "",
        cogniaBehavior: "",
        adaptationTarget: "",
        gapGrade: "minor",
        status: "intentional-deviation",
        owner: "",
        evidence: [
          { id: "ev", kind: "test", summary: "", reference: "", recordedAt: "2024-01-01" },
        ],
        deviation: {
          rationale: "r",
          tradeOff: "t",
          userImpact: "u",
          review: { reviewedBy: "x", reviewedAt: "2024-01-01" },
        },
        updatedAt: "2024-01-01",
      } as never,
    ])
    const entry = useExternalAgentStore
      .getState()
      .getBenchmarkCapabilities(id)
      .find((e) => e.id === "dev")
    expect(entry?.updatedAt).toBeInstanceOf(Date)
    expect(entry?.deviation?.review.reviewedAt).toBeInstanceOf(Date)
  })
})

describe("useExternalAgentStore delegation rules", () => {
  beforeEach(() => reset())

  it("addDelegationRule sorts by priority descending", () => {
    const lo = useExternalAgentStore.getState().addDelegationRule({
      name: "low",
      condition: "always",
      matcher: "",
      targetAgentId: "x",
      priority: 1,
      enabled: true,
    })
    const hi = useExternalAgentStore.getState().addDelegationRule({
      name: "high",
      condition: "always",
      matcher: "",
      targetAgentId: "x",
      priority: 99,
      enabled: true,
    })
    const ids = useExternalAgentStore.getState().delegationRules.map((r) => r.id)
    expect(ids).toEqual([hi, lo])
  })

  it("updateDelegationRule patches the rule and re-sorts", () => {
    const a = useExternalAgentStore.getState().addDelegationRule({
      name: "a",
      condition: "always",
      matcher: "",
      targetAgentId: "x",
      priority: 1,
      enabled: true,
    })
    const b = useExternalAgentStore.getState().addDelegationRule({
      name: "b",
      condition: "always",
      matcher: "",
      targetAgentId: "x",
      priority: 2,
      enabled: true,
    })
    useExternalAgentStore.getState().updateDelegationRule(a, { priority: 99 })
    const order = useExternalAgentStore.getState().delegationRules.map((r) => r.id)
    expect(order).toEqual([a, b])
  })

  it("removeDelegationRule drops by id", () => {
    const id = useExternalAgentStore.getState().addDelegationRule({
      name: "d",
      condition: "always",
      matcher: "",
      targetAgentId: "x",
      priority: 1,
      enabled: true,
    })
    useExternalAgentStore.getState().removeDelegationRule(id)
    expect(useExternalAgentStore.getState().delegationRules).toEqual([])
  })

  it("reorderDelegationRules rebases priorities to the new order, dropping unknown ids", () => {
    const a = useExternalAgentStore.getState().addDelegationRule({
      name: "a",
      condition: "always",
      matcher: "",
      targetAgentId: "x",
      priority: 1,
      enabled: true,
    })
    const b = useExternalAgentStore.getState().addDelegationRule({
      name: "b",
      condition: "always",
      matcher: "",
      targetAgentId: "x",
      priority: 2,
      enabled: true,
    })
    useExternalAgentStore.getState().reorderDelegationRules([a, "ghost", b])
    const order = useExternalAgentStore.getState().delegationRules.map((r) => r.id)
    expect(order).toEqual([a, b])
  })
})

describe("useExternalAgentStore default permission mode and bulk ops", () => {
  beforeEach(() => reset())

  it("setDefaultPermissionMode toggles the global default", () => {
    useExternalAgentStore.getState().setDefaultPermissionMode("plan")
    expect(useExternalAgentStore.getState().defaultPermissionMode).toBe("plan")
  })

  it("importAgents accepts ExternalAgentConfig list and seeds defaults", () => {
    const now = new Date()
    useExternalAgentStore.getState().importAgents([
      {
        id: "imp-1",
        name: "I1",
        description: "",
        protocol: "acp",
        transport: "stdio",
        enabled: true,
        process: { command: "x" },
        defaultPermissionMode: "default",
        tags: [],
        timeout: 30000,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      } as never,
      {
        id: "imp-2",
        name: "I2",
        description: "",
        protocol: "acp",
        transport: "stdio",
        enabled: true,
        process: { command: "y" },
        defaultPermissionMode: "default",
        tags: [],
        timeout: 30000,
        metadata: {},
        createdAt: now,
        updatedAt: now,
        validitySnapshot: {
          executable: true,
          checkedAt: now,
          source: "config",
          sessionExtensions: {
            "session/list": { state: "unknown" },
            "session/fork": { state: "unknown" },
            "session/resume": { state: "unknown" },
          },
        },
      } as never,
    ])
    expect(useExternalAgentStore.getState().agents["imp-1"]).toBeDefined()
    expect(useExternalAgentStore.getState().agents["imp-2"]).toBeDefined()
    expect(useExternalAgentStore.getState().connectionStatus["imp-1"]).toBe("disconnected")
    expect(useExternalAgentStore.getState().agentValidity["imp-2"]).toBeDefined()
  })

  it("importAgents handles missing createdAt / updatedAt gracefully", () => {
    useExternalAgentStore.getState().importAgents([
      {
        id: "imp-3",
        name: "I3",
        description: "",
        protocol: "acp",
        transport: "stdio",
        enabled: true,
        process: { command: "z" },
        defaultPermissionMode: "default",
        tags: [],
        timeout: 30000,
        metadata: {},
      } as never,
    ])
    expect(typeof useExternalAgentStore.getState().agents["imp-3"]?.createdAt).toBe("string")
  })

  it("exportAgents mirrors getAllAgents", () => {
    useExternalAgentStore.getState().addAgent({
      name: "X",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    expect(useExternalAgentStore.getState().exportAgents()).toHaveLength(1)
  })

  it("clearAllAgents resets the agent maps and active state", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "X",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    useExternalAgentStore.getState().setActiveAgent(id)
    useExternalAgentStore.getState().clearAllAgents()
    expect(useExternalAgentStore.getState().agents).toEqual({})
    expect(useExternalAgentStore.getState().activeAgentId).toBeNull()
  })
})

describe("useExternalAgentStore updateAgent branch coverage", () => {
  beforeEach(() => reset())

  it("merges updates.process / updates.network on top of the stored config", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "U",
      protocol: "acp",
      transport: "stdio",
      process: { command: "old", args: ["a"] },
      network: { endpoint: "http://old" } as never,
    } as never)
    useExternalAgentStore.getState().updateAgent(id, {
      process: { command: "new" } as never,
      network: { endpoint: "http://new" } as never,
    } as never)
    const stored = useExternalAgentStore.getState().agents[id]
    expect(stored.process?.command).toBe("new")
    expect(stored.process?.args).toEqual(["a"])
    expect(stored.network?.endpoint).toBe("http://new")
  })

  it("merges updates.retryConfig on top of the stored config", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "U2",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
      retryConfig: { maxRetries: 1, retryDelay: 100 } as never,
    } as never)
    useExternalAgentStore.getState().updateAgent(id, {
      retryConfig: { maxRetries: 5 } as never,
    } as never)
    const stored = useExternalAgentStore.getState().agents[id]
    expect(stored.retryConfig?.maxRetries).toBe(5)
    expect(stored.retryConfig?.retryDelay).toBe(100)
  })

  it("normalizes updates.validitySnapshot when provided", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "U3",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
    })
    useExternalAgentStore.getState().updateAgent(id, {
      validitySnapshot: {
        executable: true,
        checkedAt: new Date(),
        source: "config",
        sessionExtensions: {
          "session/list": { state: "unknown" },
          "session/fork": { state: "unknown" },
          "session/resume": { state: "unknown" },
        },
      } as never,
    } as never)
    const stored = useExternalAgentStore.getState().agents[id]
    expect(stored.validitySnapshot).toBeDefined()
    expect(stored.validitySnapshot?.executable).toBe(true)
  })

  it("merges updates.metadata on top of stored metadata", () => {
    const id = useExternalAgentStore.getState().addAgent({
      name: "U4",
      protocol: "acp",
      transport: "stdio",
      process: { command: "x" },
      metadata: { foo: "old" } as never,
    } as never)
    useExternalAgentStore.getState().updateAgent(id, {
      metadata: { bar: "new" } as never,
    } as never)
    const stored = useExternalAgentStore.getState().agents[id]
    expect(stored.metadata?.foo).toBe("old")
    expect((stored.metadata as Record<string, unknown>)?.bar).toBe("new")
  })

  it("is a no-op for unknown agent ids", () => {
    const before = useExternalAgentStore.getState().agents
    useExternalAgentStore.getState().updateAgent("ghost", { name: "x" })
    expect(useExternalAgentStore.getState().agents).toEqual(before)
  })
})

describe("useExternalAgentStore Tauri-only no-op guards", () => {
  beforeEach(() => reset())

  it("killRunningAgent silently no-ops when not in Tauri", async () => {
    await useExternalAgentStore.getState().killRunningAgent("any")
    expect(useExternalAgentStore.getState().lastError).toBeNull()
  })

  it("refreshRunningAgents no-ops outside Tauri", async () => {
    await useExternalAgentStore.getState().refreshRunningAgents()
    expect(useExternalAgentStore.getState().runningAgentIds).toEqual([])
  })

  it("killAllRunningAgents no-ops outside Tauri", async () => {
    await useExternalAgentStore.getState().killAllRunningAgents()
  })

  it("createTerminal throws", async () => {
    await expect(useExternalAgentStore.getState().createTerminal("s", "ls")).rejects.toThrow(
      /Tauri/
    )
  })

  it("writeToTerminal / getTerminalOutput / waitForTerminalExit throw", async () => {
    await expect(useExternalAgentStore.getState().writeToTerminal("t", "x")).rejects.toThrow(
      /Tauri/
    )
    await expect(useExternalAgentStore.getState().getTerminalOutput("t")).rejects.toThrow(/Tauri/)
    await expect(useExternalAgentStore.getState().waitForTerminalExit("t")).rejects.toThrow(/Tauri/)
  })

  it("killTerminal / releaseTerminal silently no-op", async () => {
    await useExternalAgentStore.getState().killTerminal("t")
    await useExternalAgentStore.getState().releaseTerminal("t")
  })

  it("getSessionTerminals returns empty list", async () => {
    expect(await useExternalAgentStore.getState().getSessionTerminals("any")).toEqual([])
  })

  it("killSessionTerminals no-ops", async () => {
    await useExternalAgentStore.getState().killSessionTerminals("any")
  })

  it("isTerminalRunning returns false", async () => {
    expect(await useExternalAgentStore.getState().isTerminalRunning("t")).toBe(false)
  })

  it("getTerminalInfo throws", async () => {
    await expect(useExternalAgentStore.getState().getTerminalInfo("t")).rejects.toThrow(/Tauri/)
  })

  it("refreshTerminals no-ops", async () => {
    await useExternalAgentStore.getState().refreshTerminals()
    expect(useExternalAgentStore.getState().terminalIds).toEqual([])
  })
})
