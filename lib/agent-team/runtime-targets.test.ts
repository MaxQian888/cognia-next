import { buildMentionableTargets, findTargetById, targetsToCandidates } from "./runtime-targets"
import { VIRTUAL_AGENT_IDS } from "@/types/agent/agent-team"
import type { AgentTeammate } from "@/types/agent/agent-team"

function makeTeammate(overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: "tm-1",
    teamId: "team-1",
    name: "Alice",
    description: "Frontend dev",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
    ...overrides,
  }
}

describe("buildMentionableTargets", () => {
  it("always emits the two virtual targets first", () => {
    const out = buildMentionableTargets([])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(
      expect.objectContaining({
        kind: "virtual",
        id: VIRTUAL_AGENT_IDS.CLAUDE,
        name: "claude",
        runtime: "claude",
      })
    )
    expect(out[1]).toEqual(
      expect.objectContaining({
        kind: "virtual",
        id: VIRTUAL_AGENT_IDS.CODEX,
        name: "codex",
        runtime: "codex",
      })
    )
  })

  it("appends teammates after virtuals with their configured runtime", () => {
    const tm = makeTeammate({ id: "tm-2", name: "Bob", config: { runtime: "claude-code" } })
    const out = buildMentionableTargets([tm])
    expect(out).toHaveLength(3)
    expect(out[2]).toEqual(
      expect.objectContaining({
        kind: "teammate",
        id: "tm-2",
        name: "Bob",
        runtime: "claude-code",
        nameCollision: false,
      })
    )
  })

  it("falls back to the default runtime when teammate.config.runtime is missing", () => {
    const tm = makeTeammate({ id: "tm-3", name: "Cara", config: {} })
    const out = buildMentionableTargets([tm])
    const teammate = out.find((t) => t.kind === "teammate" && t.id === "tm-3")
    expect(teammate?.runtime).toBe("claude")
  })

  it("flags name collision when a teammate is named like a reserved virtual", () => {
    const tm = makeTeammate({ id: "tm-4", name: "Codex" })
    const out = buildMentionableTargets([tm])
    const teammate = out.find((t) => t.kind === "teammate" && t.id === "tm-4")
    expect(teammate).toBeDefined()
    if (teammate?.kind === "teammate") {
      expect(teammate.nameCollision).toBe(true)
    }
  })

  it("preserves teammate description for the picker", () => {
    const tm = makeTeammate({
      id: "tm-5",
      name: "Sec",
      description: "Security reviewer with focus on auth",
    })
    const out = buildMentionableTargets([tm])
    const teammate = out.find((t) => t.kind === "teammate" && t.id === "tm-5")
    if (teammate?.kind === "teammate") {
      expect(teammate.description).toBe("Security reviewer with focus on auth")
    }
  })
})

describe("targetsToCandidates", () => {
  it("projects to the {id,name} shape used by the parser", () => {
    const targets = buildMentionableTargets([makeTeammate()])
    const candidates = targetsToCandidates(targets)
    expect(candidates).toEqual([
      { id: VIRTUAL_AGENT_IDS.CLAUDE, name: "claude" },
      { id: VIRTUAL_AGENT_IDS.CODEX, name: "codex" },
      { id: "tm-1", name: "Alice" },
    ])
  })
})

describe("findTargetById", () => {
  it("finds a virtual by id", () => {
    const targets = buildMentionableTargets([])
    const found = findTargetById(targets, VIRTUAL_AGENT_IDS.CLAUDE)
    expect(found?.kind).toBe("virtual")
    expect(found?.name).toBe("claude")
  })

  it("finds a teammate by id", () => {
    const targets = buildMentionableTargets([makeTeammate({ id: "abc", name: "Alex" })])
    const found = findTargetById(targets, "abc")
    expect(found?.kind).toBe("teammate")
    expect(found?.name).toBe("Alex")
  })

  it("returns null for unknown id", () => {
    const targets = buildMentionableTargets([])
    expect(findTargetById(targets, "nope")).toBeNull()
  })

  it("returns null for null id", () => {
    const targets = buildMentionableTargets([])
    expect(findTargetById(targets, null)).toBeNull()
  })
})
