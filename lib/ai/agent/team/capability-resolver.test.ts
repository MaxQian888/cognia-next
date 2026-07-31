import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"
import {
  clampCapabilitiesToRuntime,
  RESOLVED_CAPABILITY_KEYS,
  resolveTeamCapabilities,
  resolveTeammateCapabilities,
} from "./capability-resolver"

function makeTeam(overrides: Partial<AgentTeam["config"]> = {}): Pick<AgentTeam, "config"> {
  return {
    config: {
      ...DEFAULT_TEAM_CONFIG,
      ...overrides,
    },
  }
}

function makeTeammate(
  overrides: Partial<AgentTeammate["config"]> = {}
): Pick<AgentTeammate, "config"> {
  return { config: { ...overrides } }
}

describe("capability-resolver", () => {
  describe("resolveTeammateCapabilities", () => {
    it("returns an empty resolved bundle when team + teammate have no capabilities", () => {
      const out = resolveTeammateCapabilities(makeTeam(), makeTeammate())
      expect(out).toEqual({
        mcpServerIds: [],
        skillIds: [],
        nativeAnthropicToolIds: [],
        characterPackIds: [],
        externalAgentPresetIds: [],
        subagentIds: [],
        a2uiTemplateIds: [],
      })
    })

    it("passes through team defaults when teammate has no overlay", () => {
      const team = makeTeam({
        capabilities: {
          mcpServerIds: ["a", "b"],
          skillIds: ["s"],
        },
      })
      const out = resolveTeammateCapabilities(team, makeTeammate())
      expect(out.mcpServerIds).toEqual(["a", "b"])
      expect(out.skillIds).toEqual(["s"])
      expect(out.nativeAnthropicToolIds).toEqual([])
    })

    it("applies add overlay as union with team default", () => {
      const team = makeTeam({ capabilities: { skillIds: ["s1", "s2"] } })
      const teammate = makeTeammate({ capabilities: { skillIds: { add: ["s3"] } } })
      expect(resolveTeammateCapabilities(team, teammate).skillIds).toEqual(["s1", "s2", "s3"])
    })

    it("applies remove overlay subtractively from team default", () => {
      const team = makeTeam({ capabilities: { skillIds: ["s1", "s2", "s3"] } })
      const teammate = makeTeammate({ capabilities: { skillIds: { remove: ["s2"] } } })
      expect(resolveTeammateCapabilities(team, teammate).skillIds).toEqual(["s1", "s3"])
    })

    it("applies remove then add (remove wins for the same id)", () => {
      const team = makeTeam({ capabilities: { skillIds: ["s1", "s2"] } })
      const teammate = makeTeammate({
        capabilities: { skillIds: { remove: ["s1"], add: ["s3"] } },
      })
      // s1 removed, s2 retained, s3 appended.
      expect(resolveTeammateCapabilities(team, teammate).skillIds).toEqual(["s2", "s3"])
    })

    it("`replace` short-circuits and ignores team default + add/remove", () => {
      const team = makeTeam({ capabilities: { skillIds: ["s1", "s2"] } })
      const teammate = makeTeammate({
        capabilities: {
          skillIds: { replace: ["only-this"], add: ["ignored"], remove: ["s1"] },
        },
      })
      expect(resolveTeammateCapabilities(team, teammate).skillIds).toEqual(["only-this"])
    })

    it("dedupes ids in add lists and team defaults", () => {
      const team = makeTeam({ capabilities: { skillIds: ["s1", "s1", "s2"] } })
      const teammate = makeTeammate({ capabilities: { skillIds: { add: ["s1", "s3", "s3"] } } })
      expect(resolveTeammateCapabilities(team, teammate).skillIds).toEqual(["s1", "s2", "s3"])
    })

    it("merges every capability key independently", () => {
      const team = makeTeam({
        capabilities: {
          mcpServerIds: ["m1"],
          skillIds: ["s1"],
          nativeAnthropicToolIds: ["computer_20251124"],
          characterPackIds: ["pack-a"],
          externalAgentPresetIds: ["claude-code"],
          subagentIds: ["workflow-designer"],
          a2uiTemplateIds: ["a2ui-1"],
        },
      })
      const teammate = makeTeammate({
        capabilities: {
          mcpServerIds: { add: ["m2"] },
          skillIds: { remove: ["s1"] },
          subagentIds: { replace: ["plugin:reviewer"] },
        },
      })
      const out = resolveTeammateCapabilities(team, teammate)
      expect(out.mcpServerIds).toEqual(["m1", "m2"])
      expect(out.skillIds).toEqual([])
      expect(out.nativeAnthropicToolIds).toEqual(["computer_20251124"])
      expect(out.characterPackIds).toEqual(["pack-a"])
      expect(out.externalAgentPresetIds).toEqual(["claude-code"])
      expect(out.subagentIds).toEqual(["plugin:reviewer"])
      expect(out.a2uiTemplateIds).toEqual(["a2ui-1"])
    })

    it("returns a fresh object every call (no shared reference with the empty sentinel)", () => {
      const a = resolveTeammateCapabilities(makeTeam(), makeTeammate())
      const b = resolveTeammateCapabilities(makeTeam(), makeTeammate())
      expect(a).not.toBe(b)
      a.skillIds.push("mutated")
      expect(b.skillIds).toEqual([])
    })

    it("handles overlays whose target key has no team default", () => {
      const teammate = makeTeammate({
        capabilities: { mcpServerIds: { add: ["m1", "m2"] } },
      })
      const out = resolveTeammateCapabilities(makeTeam(), teammate)
      expect(out.mcpServerIds).toEqual(["m1", "m2"])
    })

    it("ignores empty add/remove arrays", () => {
      const team = makeTeam({ capabilities: { skillIds: ["s1"] } })
      const teammate = makeTeammate({
        capabilities: { skillIds: { add: [], remove: [] } },
      })
      expect(resolveTeammateCapabilities(team, teammate).skillIds).toEqual(["s1"])
    })
  })

  describe("resolveTeamCapabilities", () => {
    it("returns an empty bundle when the team has no capabilities", () => {
      expect(resolveTeamCapabilities(makeTeam())).toEqual({
        mcpServerIds: [],
        skillIds: [],
        nativeAnthropicToolIds: [],
        characterPackIds: [],
        externalAgentPresetIds: [],
        subagentIds: [],
        a2uiTemplateIds: [],
      })
    })

    it("dedupes ids in the team's capability bundle", () => {
      const team = makeTeam({
        capabilities: { skillIds: ["s1", "s1", "s2"], mcpServerIds: ["m"] },
      })
      const out = resolveTeamCapabilities(team)
      expect(out.skillIds).toEqual(["s1", "s2"])
      expect(out.mcpServerIds).toEqual(["m"])
    })

    it("exposes all 7 capability keys", () => {
      expect(RESOLVED_CAPABILITY_KEYS).toEqual([
        "mcpServerIds",
        "skillIds",
        "nativeAnthropicToolIds",
        "characterPackIds",
        "externalAgentPresetIds",
        "subagentIds",
        "a2uiTemplateIds",
      ])
    })
  })
})

describe("clampCapabilitiesToRuntime (ADR-0090 Phase 7)", () => {
  const bundle = {
    mcpServerIds: ["gh"],
    skillIds: ["review"],
    nativeAnthropicToolIds: ["computer"],
    characterPackIds: ["pack"],
    externalAgentPresetIds: ["codex"],
    subagentIds: ["explore"],
    a2uiTemplateIds: ["tpl"],
  }

  it("keeps everything when the runtime serves mcp, native subagents and tools", () => {
    expect(
      clampCapabilitiesToRuntime(bundle, ["mcp", "subagents.native", "tools.ordinary"])
    ).toEqual(bundle)
  })

  it("empties exactly the id lists whose backing runtime capability is missing", () => {
    const clamped = clampCapabilitiesToRuntime(bundle, ["tools.ordinary"])
    expect(clamped.mcpServerIds).toEqual([])
    expect(clamped.subagentIds).toEqual([])
    expect(clamped.nativeAnthropicToolIds).toEqual(["computer"])
    expect(clamped.skillIds).toEqual(["review"])
  })

  it("a tools-less runtime also drops skills and native tools; prompt-level bundles pass", () => {
    const clamped = clampCapabilitiesToRuntime(bundle, [])
    expect(clamped.nativeAnthropicToolIds).toEqual([])
    expect(clamped.skillIds).toEqual([])
    // Intersection only removes — prompt-level and runtime-selecting lists stay.
    expect(clamped.characterPackIds).toEqual(["pack"])
    expect(clamped.externalAgentPresetIds).toEqual(["codex"])
    expect(clamped.a2uiTemplateIds).toEqual(["tpl"])
  })
})
