import {
  buildRouteTargets,
  findTargetByHandle,
  routeHandleSlug,
  type MentionTarget,
} from "./runtime-targets"
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

const squad = (id: string, name: string, teammates: AgentTeammate[]) => ({
  team: { id, name },
  teammates,
})

function teammates(targets: MentionTarget[]) {
  return targets.filter(
    (t): t is Extract<MentionTarget, { kind: "teammate" }> => t.kind === "teammate"
  )
}

describe("routeHandleSlug", () => {
  it("lowercases and dashes separators", () => {
    expect(routeHandleSlug("  Code Reviewer ")).toBe("code-reviewer")
  })

  it("keeps non-Latin letters so CJK names stay addressable", () => {
    expect(routeHandleSlug("研究员")).toBe("研究员")
  })

  it("collapses to empty for a name with no letters or digits", () => {
    expect(routeHandleSlug("!!!")).toBe("")
  })
})

describe("buildRouteTargets", () => {
  it("always emits the two virtual targets first, with their reserved handles", () => {
    const out = buildRouteTargets({ squads: [] })
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(
      expect.objectContaining({
        kind: "virtual",
        id: VIRTUAL_AGENT_IDS.CLAUDE,
        handle: "claude",
        runtime: "claude",
      })
    )
    expect(out[1]).toEqual(
      expect.objectContaining({
        kind: "virtual",
        id: VIRTUAL_AGENT_IDS.CODEX,
        handle: "codex",
        runtime: "codex",
      })
    )
  })

  it("lists members after the virtuals with their Squad and configured runtime", () => {
    const bob = makeTeammate({ id: "tm-2", name: "Bob", config: { runtime: "claude-code" } })
    const out = buildRouteTargets({ squads: [squad("s1", "Platform", [bob])] })
    expect(out).toHaveLength(3)
    expect(out[2]).toEqual(
      expect.objectContaining({
        kind: "teammate",
        id: "tm-2",
        name: "Bob",
        handle: "bob",
        squadId: "s1",
        squadName: "Platform",
        runtime: "claude-code",
        nameCollision: false,
      })
    )
  })

  it("falls back to the default runtime when the teammate names none", () => {
    const out = buildRouteTargets({
      squads: [squad("s1", "S", [makeTeammate({ id: "tm-3", name: "Cara" })])],
    })
    expect(teammates(out)[0].runtime).toBe("claude")
  })

  it("a member named like a reserved runtime gets a Squad-qualified handle", () => {
    const out = buildRouteTargets({
      squads: [squad("s1", "Build Crew", [makeTeammate({ id: "tm-4", name: "Codex" })])],
    })
    const [member] = teammates(out)
    expect(member.handle).toBe("build-crew-codex")
    expect(member.nameCollision).toBe(true)
    // The reserved handle still resolves to the virtual runtime.
    expect(findTargetByHandle(out, "codex")?.kind).toBe("virtual")
  })

  it("a member never shadows a subagent handle", () => {
    const out = buildRouteTargets({
      squads: [squad("s1", "Ops", [makeTeammate({ id: "tm-5", name: "Reviewer" })])],
      reservedHandles: ["Reviewer"],
    })
    expect(teammates(out)[0].handle).toBe("ops-reviewer")
  })

  it("two members with the same name BOTH take qualified handles", () => {
    const out = buildRouteTargets({
      squads: [
        squad("s1", "Alpha", [makeTeammate({ id: "a", name: "Critic" })]),
        squad("s2", "Beta", [makeTeammate({ id: "b", name: "Critic" })]),
      ],
    })
    expect(teammates(out).map((t) => t.handle)).toEqual(["alpha-critic", "beta-critic"])
  })

  it("uses the teammate id when even the qualified handle collides", () => {
    const out = buildRouteTargets({
      squads: [
        squad("s1", "Same", [makeTeammate({ id: "x1", name: "Critic" })]),
        squad("s2", "Same", [makeTeammate({ id: "x2", name: "Critic" })]),
      ],
    })
    expect(teammates(out).map((t) => t.handle)).toEqual(["x1", "x2"])
  })

  it("uses the teammate id for a name with no usable characters", () => {
    const out = buildRouteTargets({
      squads: [squad("s1", "!!!", [makeTeammate({ id: "tm-9", name: "???" })])],
    })
    expect(teammates(out)[0].handle).toBe("tm-9")
  })

  it("keeps every handle unique across the whole list", () => {
    const out = buildRouteTargets({
      squads: [
        squad("s1", "A", [
          makeTeammate({ id: "1", name: "Claude" }),
          makeTeammate({ id: "2", name: "a claude" }),
        ]),
      ],
    })
    const handles = out.map((t) => t.handle)
    expect(new Set(handles).size).toBe(handles.length)
  })
})

describe("findTargetByHandle", () => {
  const targets = buildRouteTargets({
    squads: [squad("s1", "S", [makeTeammate({ id: "abc", name: "Alex" })])],
  })

  it("matches case-insensitively", () => {
    expect(findTargetByHandle(targets, "ALEX")?.id).toBe("abc")
    expect(findTargetByHandle(targets, "Claude")?.id).toBe(VIRTUAL_AGENT_IDS.CLAUDE)
  })

  it("returns null for an unknown or empty handle", () => {
    expect(findTargetByHandle(targets, "nope")).toBeNull()
    expect(findTargetByHandle(targets, null)).toBeNull()
  })
})
