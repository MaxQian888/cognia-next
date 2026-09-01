import { normalizeAgentTeamConfig, normalizeAgentTeamTask } from "./agent-team-compat"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { configureAgentTeamRuntime, __resetAgentTeamRuntimeForTesting } from "./agent-team"
import { __resetInflightForTesting } from "./agent-team-runtime"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

function makeTeam(overrides: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: "t1",
    name: "T",
    description: "",
    task: "do",
    status: "idle",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 1,
      executionMode: "coordinated",
      displayMode: "compact",
    },
    leadId: "lead-1",
    teammateIds: ["lead-1", "tm-1"],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(),
    ...overrides,
  }
}

function makeTeammate(id: string, role: AgentTeammate["role"] = "teammate"): AgentTeammate {
  return {
    id,
    teamId: "t1",
    name: id,
    description: "",
    role,
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
  }
}

beforeEach(() => {
  useAgentTeamStore.getState().reset()
  __resetAgentTeamRuntimeForTesting()
  __resetInflightForTesting()
})

describe("normalizeAgentTeamConfig", () => {
  it("returns primitive inputs unchanged", () => {
    expect(normalizeAgentTeamConfig("plain")).toBe("plain")
    expect(normalizeAgentTeamConfig(null)).toBeNull()
    expect(normalizeAgentTeamConfig(undefined)).toBeUndefined()
    expect(normalizeAgentTeamConfig(42)).toBe(42)
  })

  it("returns the input by reference when nothing was dirty", () => {
    const input = { name: "Clean", description: "OK" }
    expect(normalizeAgentTeamConfig(input)).toBe(input)
  })

  it("trims string fields when present", () => {
    const out = normalizeAgentTeamConfig({ name: "  Padded  ", description: " ok " })
    expect(out.name).toBe("Padded")
    expect(out.description).toBe("ok")
  })

  it("clamps top-level numeric fields when present (partial-config shape)", () => {
    const out = normalizeAgentTeamConfig({
      maxTeammates: 0,
      maxConcurrentTeammates: -3,
      tokenBudget: -10,
    })
    expect(out.maxTeammates).toBe(1)
    expect(out.maxConcurrentTeammates).toBe(1)
    expect(out.tokenBudget).toBe(0)
  })

  it("clamps nested config.* numeric fields when given a full AgentTeam", () => {
    const out = normalizeAgentTeamConfig({
      name: "T",
      config: {
        maxTeammates: 0,
        maxConcurrentTeammates: 0,
        tokenBudget: -5,
        executionMode: "coordinated",
        displayMode: "compact",
      },
    })
    const cfg = (out as { config: Record<string, unknown> }).config
    expect(cfg.maxTeammates).toBe(1)
    expect(cfg.maxConcurrentTeammates).toBe(1)
    expect(cfg.tokenBudget).toBe(0)
  })

  it("does not mutate the original input", () => {
    const input: { name: string; config?: { maxTeammates: number } } = {
      name: "  raw  ",
      config: { maxTeammates: 0 },
    }
    const out = normalizeAgentTeamConfig(input)
    expect(input.name).toBe("  raw  ")
    expect(input.config?.maxTeammates).toBe(0)
    // The output is a different object once dirty.
    expect(out).not.toBe(input)
  })

  it("preserves the additive workspaceIsolation field untouched", () => {
    const iso = { enabled: true, reconcile: "select", selectStrategy: "judge" }
    const input = { name: "Clean", workspaceIsolation: iso }
    // Nothing dirty → returned by reference, isolation block intact.
    expect(normalizeAgentTeamConfig(input)).toBe(input)
    const trimmed = normalizeAgentTeamConfig({ name: "  T  ", workspaceIsolation: iso })
    expect(trimmed.workspaceIsolation).toEqual(iso)
  })
})

describe("normalizeAgentTeamTask", () => {
  it("returns primitive inputs unchanged", () => {
    expect(normalizeAgentTeamTask("x")).toBe("x")
    expect(normalizeAgentTeamTask(null)).toBeNull()
    expect(normalizeAgentTeamTask(undefined)).toBeUndefined()
  })

  it("returns the input by reference when nothing was dirty", () => {
    const t = { title: "Clean", description: "OK" }
    expect(normalizeAgentTeamTask(t)).toBe(t)
  })

  it("trims string fields", () => {
    const out = normalizeAgentTeamTask({
      title: "  trim me  ",
      description: " no edge whitespace ",
      expectedOutput: " yep ",
    })
    expect(out.title).toBe("trim me")
    expect(out.description).toBe("no edge whitespace")
    expect(out.expectedOutput).toBe("yep")
  })

  it("clamps negative order and retryCount to zero", () => {
    const out = normalizeAgentTeamTask({ order: -3, retryCount: -1 })
    expect(out.order).toBe(0)
    expect(out.retryCount).toBe(0)
  })
})
