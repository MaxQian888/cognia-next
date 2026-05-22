import { presetStateToTeammateConfig, teammateToPresetState } from "./teammate-preset-adapter"
import { emptyEditorState } from "@/components/settings/presets/preset-editor-state"
import type { AgentTeam, AgentTeammate, TeammateConfig } from "@/types/agent/agent-team"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"

function makeTeammate(
  overrides: Partial<AgentTeammate> = {},
  configOverrides: Partial<TeammateConfig> = {}
): Pick<AgentTeammate, "name" | "description" | "config"> {
  return {
    name: overrides.name ?? "Reviewer",
    description: overrides.description ?? "Reviews code",
    config: { ...configOverrides },
  }
}

function makeTeam(capabilities?: AgentTeam["config"]["capabilities"]): Pick<AgentTeam, "config"> {
  return {
    config: {
      ...DEFAULT_TEAM_CONFIG,
      capabilities,
    },
  }
}

describe("teammate-preset-adapter", () => {
  describe("teammateToPresetState", () => {
    it("populates identity fields from teammate name + description", () => {
      const state = teammateToPresetState(
        makeTeammate({ name: "Alice", description: "Lead reviewer" })
      )
      expect(state.name).toBe("Alice")
      expect(state.description).toBe("Lead reviewer")
    })

    it("maps systemPrompt → content and model → model", () => {
      const state = teammateToPresetState(
        makeTeammate(undefined, { systemPrompt: "be helpful", model: "sonnet" })
      )
      expect(state.content).toBe("be helpful")
      expect(state.model).toBe("sonnet")
    })

    it("splits TeammateConfig.tools into allow / deny by `!` prefix", () => {
      const state = teammateToPresetState(
        makeTeammate(undefined, { tools: ["Read", "Grep", "!Bash", "!Edit"] })
      )
      expect(state.allowedTools).toEqual(["Read", "Grep"])
      expect(state.disallowedTools).toEqual(["Bash", "Edit"])
    })

    it("falls back to team-default lists when teammate has no overlay", () => {
      const team = makeTeam({
        skillIds: ["s1", "s2"],
        mcpServerIds: ["m1"],
      })
      const state = teammateToPresetState(makeTeammate(), team)
      expect(state.skillIds).toEqual(["s1", "s2"])
      expect(state.mcpServerIds).toEqual(["m1"])
    })

    it("merges add/remove overlay against team default", () => {
      const team = makeTeam({ skillIds: ["s1", "s2", "s3"] })
      const teammate = makeTeammate(undefined, {
        capabilities: { skillIds: { add: ["s4"], remove: ["s2"] } },
      })
      const state = teammateToPresetState(teammate, team)
      expect(state.skillIds).toEqual(["s1", "s3", "s4"])
    })

    it("`replace` overlay short-circuits the team default", () => {
      const team = makeTeam({ skillIds: ["s1", "s2"] })
      const teammate = makeTeammate(undefined, {
        capabilities: { skillIds: { replace: ["custom"] } },
      })
      const state = teammateToPresetState(teammate, team)
      expect(state.skillIds).toEqual(["custom"])
    })

    it("picks the first id for single-valued character / external preset fields", () => {
      const teammate = makeTeammate(undefined, {
        capabilities: {
          characterPackIds: { replace: ["pack-a"] },
          externalAgentPresetIds: { replace: ["claude-code"] },
        },
      })
      const state = teammateToPresetState(teammate)
      expect(state.characterPackId).toBe("pack-a")
      expect(state.externalAgentPresetId).toBe("claude-code")
    })

    it("returns the base empty editor state when teammate config is minimal", () => {
      const state = teammateToPresetState(makeTeammate())
      expect(state.allowedTools).toEqual([])
      expect(state.skillIds).toEqual([])
      expect(state.content).toBe("")
    })
  })

  describe("presetStateToTeammateConfig", () => {
    it("clears capabilities overlay when state lists match team default", () => {
      const team = makeTeam({ skillIds: ["s1", "s2"] })
      const state = { ...emptyEditorState(), skillIds: ["s1", "s2"] }
      const out = presetStateToTeammateConfig(state, {}, team)
      expect(out.capabilities).toBeUndefined()
    })

    it("computes minimal add/remove overlay against the team default", () => {
      const team = makeTeam({ skillIds: ["s1", "s2", "s3"] })
      const state = { ...emptyEditorState(), skillIds: ["s1", "s3", "s4"] }
      const out = presetStateToTeammateConfig(state, {}, team)
      expect(out.capabilities?.skillIds).toEqual({
        add: ["s4"],
        remove: ["s2"],
      })
    })

    it("re-encodes deny tools as `!`-prefixed entries", () => {
      const state = {
        ...emptyEditorState(),
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
      }
      const out = presetStateToTeammateConfig(state, {})
      expect(out.tools).toEqual(["Read", "!Bash"])
    })

    it("trims systemPrompt + model and stores undefined when empty", () => {
      const state = {
        ...emptyEditorState(),
        content: "  ",
        model: "  ",
      }
      const out = presetStateToTeammateConfig(state, {})
      expect(out.systemPrompt).toBeUndefined()
      expect(out.model).toBeUndefined()
    })

    it("preserves previous fields not covered by the editor (specialization / runtime)", () => {
      const state = emptyEditorState()
      const out = presetStateToTeammateConfig(state, {
        specialization: "security",
        runtime: "codex",
        temperature: 0.4,
      })
      expect(out.specialization).toBe("security")
      expect(out.runtime).toBe("codex")
      expect(out.temperature).toBe(0.4)
    })

    it("round-trips overlay → flat list → overlay against the same team default", () => {
      const team = makeTeam({ skillIds: ["s1", "s2"] })
      const original: TeammateConfig = {
        capabilities: { skillIds: { add: ["s3"], remove: ["s1"] } },
      }
      const teammate = makeTeammate(undefined, original)
      const state = teammateToPresetState(teammate, team)
      const out = presetStateToTeammateConfig(state, original, team)
      expect(out.capabilities?.skillIds).toEqual({ add: ["s3"], remove: ["s1"] })
    })
  })
})
