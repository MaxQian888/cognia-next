import {
  agentTeamCompat,
  dispatchAgentTeam,
  normalizeAgentTeamConfig,
  normalizeAgentTeamTask,
} from "./agent-team-compat"

describe("dispatchAgentTeam", () => {
  it("returns a not-yet-migrated reason", async () => {
    const result = await dispatchAgentTeam({ teamId: "team-1" })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/not yet migrated/i)
  })

  it("accepts optional task and metadata fields", async () => {
    const result = await dispatchAgentTeam({
      teamId: "team-2",
      task: "Run analysis",
      metadata: { author: "qa" },
    })
    expect(result).toEqual({ ok: false, reason: "agent-team runtime not yet migrated" })
  })
})

describe("agentTeamCompat", () => {
  it("dispatch() forwards to dispatchAgentTeam", async () => {
    const result = await agentTeamCompat.dispatch({ teamId: "team-3" })
    expect(result.ok).toBe(false)
  })
})

describe("normalizeAgentTeamConfig", () => {
  it("returns the input value unchanged (identity normalizer)", () => {
    const input = { id: "t1", name: "Team", members: [] }
    expect(normalizeAgentTeamConfig(input)).toBe(input)
  })

  it("preserves primitive inputs", () => {
    expect(normalizeAgentTeamConfig("plain")).toBe("plain")
    expect(normalizeAgentTeamConfig(null)).toBeNull()
  })
})

describe("normalizeAgentTeamTask", () => {
  it("returns the input task unchanged", () => {
    const task = { kind: "task", description: "x" }
    expect(normalizeAgentTeamTask(task)).toBe(task)
  })

  it("returns undefined when given undefined", () => {
    expect(normalizeAgentTeamTask(undefined)).toBeUndefined()
  })
})
