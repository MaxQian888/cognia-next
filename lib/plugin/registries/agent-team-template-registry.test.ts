import type { PluginAgentTeamTemplateDef } from "@/types/plugin/plugin-agent-team-template"
import {
  __resetAgentTeamTemplatesForTesting,
  getAgentTeamTemplate,
  getAgentTeamTemplateEntry,
  getTemplateWarnings,
  listAgentTeamTemplateEntries,
  listAgentTeamTemplateIds,
  refreshAllTemplateWarnings,
  registerAgentTeamTemplate,
  unregisterAgentTeamTemplateById,
  unregisterAgentTeamTemplatesByPlugin,
  validateTemplateRequires,
} from "./agent-team-template-registry"
import { __resetSkillsForTesting, registerSkill } from "./skill-registry"
import {
  __resetMcpServerPresetsForTesting,
  registerMcpServerPreset,
} from "./mcp-server-preset-registry"
import {
  __resetNativeAnthropicToolsForTesting,
  registerNativeAnthropicTool,
} from "./native-anthropic-tool-registry"
import { __resetCharacterPacksForTesting, registerCharacterPack } from "./character-pack-registry"
import { __resetSubagentsForTesting, registerSubagent } from "./subagent-registry"

function makeTemplate(
  id: string,
  overrides: Partial<PluginAgentTeamTemplateDef> = {}
): PluginAgentTeamTemplateDef {
  return {
    id,
    name: `Template ${id}`,
    description: `Test template ${id}`,
    category: "general",
    teammates: [{ name: "T", description: "" }],
    ...overrides,
  }
}

describe("agent-team-template-registry", () => {
  beforeEach(() => {
    __resetAgentTeamTemplatesForTesting()
    __resetSkillsForTesting()
    __resetMcpServerPresetsForTesting()
    __resetNativeAnthropicToolsForTesting()
    __resetCharacterPacksForTesting()
    __resetSubagentsForTesting()
  })

  describe("CRUD", () => {
    it("registers a template and retrieves it via get / getEntry / list", () => {
      const tpl = makeTemplate("pr-review")
      const previous = registerAgentTeamTemplate("pr-review", tpl, { pluginId: "p1" })
      expect(previous).toBeUndefined()

      expect(getAgentTeamTemplate("pr-review")).toBe(tpl)
      expect(getAgentTeamTemplateEntry("pr-review")).toEqual({
        entry: tpl,
        pluginId: "p1",
      })
      expect(listAgentTeamTemplateIds()).toEqual(["pr-review"])
      expect(listAgentTeamTemplateEntries()).toEqual([
        { id: "pr-review", entry: tpl, pluginId: "p1" },
      ])
    })

    it("unregisterByPlugin drops every template from the given pluginId", () => {
      registerAgentTeamTemplate("a", makeTemplate("a"), { pluginId: "plug" })
      registerAgentTeamTemplate("b", makeTemplate("b"), { pluginId: "plug" })

      const removed = unregisterAgentTeamTemplatesByPlugin("plug")
      expect(removed).toBe(2)
      expect(getAgentTeamTemplate("a")).toBeUndefined()
      expect(getAgentTeamTemplate("b")).toBeUndefined()
    })

    it("unregisterByPlugin clears warnings for removed templates", () => {
      registerAgentTeamTemplate("a", makeTemplate("a", { requires: { skillIds: ["missing"] } }), {
        pluginId: "plug",
      })
      expect(getTemplateWarnings("a")).toHaveLength(1)
      unregisterAgentTeamTemplatesByPlugin("plug")
      expect(getTemplateWarnings("a")).toEqual([])
    })

    it("unregisterById removes only the matching entry and its warnings", () => {
      registerAgentTeamTemplate("a", makeTemplate("a", { requires: { skillIds: ["x"] } }))
      registerAgentTeamTemplate("b", makeTemplate("b"))

      expect(unregisterAgentTeamTemplateById("a")).toBe(true)
      expect(getAgentTeamTemplate("a")).toBeUndefined()
      expect(getTemplateWarnings("a")).toEqual([])
      expect(getAgentTeamTemplate("b")).toBeDefined()
      expect(unregisterAgentTeamTemplateById("a")).toBe(false)
    })
  })

  describe("validateTemplateRequires", () => {
    it("returns ok when there is no requires block", () => {
      const tpl = makeTemplate("clean")
      expect(validateTemplateRequires(tpl)).toEqual({ warnings: [], ok: true })
    })

    it("flags every missing dependency category", () => {
      const tpl = makeTemplate("missing", {
        requires: {
          mcpServerPresetIds: ["m1"],
          skillIds: ["s1"],
          characterPackIds: ["c1"],
          nativeAnthropicToolIds: ["n1"],
          externalAgentPresetIds: ["nonsense"],
          subagentIds: ["plugin:missing"],
        },
      })
      const result = validateTemplateRequires(tpl)
      expect(result.ok).toBe(false)
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          { code: "missing-mcp-preset", missingId: "m1" },
          { code: "missing-skill", missingId: "s1" },
          { code: "missing-character-pack", missingId: "c1" },
          { code: "missing-native-tool", missingId: "n1" },
          { code: "missing-external-agent-preset", missingId: "nonsense" },
          { code: "missing-subagent", missingId: "plugin:missing" },
        ])
      )
    })

    it("recognises built-in subagent ids as present without overlay registration", () => {
      const tpl = makeTemplate("builtin", {
        requires: { subagentIds: ["workflow-designer", "workflow-debugger"] },
      })
      expect(validateTemplateRequires(tpl).warnings).toEqual([])
    })

    it("recognises plugin-namespaced subagent ids when the overlay entry is present", () => {
      registerSubagent(
        "reviewer",
        {
          id: "reviewer",
          name: "R",
          description: "",
          prompt: "",
        },
        { pluginId: "myPlugin" }
      )
      const tpl = makeTemplate("ns", { requires: { subagentIds: ["myPlugin:reviewer"] } })
      expect(validateTemplateRequires(tpl).warnings).toEqual([])
    })

    it("recognises every other cross-registry dependency when present", () => {
      registerSkill("skill-a", {
        id: "skill-a",
        name: "S",
        description: "",
        source: { kind: "inline", markdown: "" },
      })
      registerMcpServerPreset("mcp-a", {
        id: "mcp-a",
        name: "M",
        description: "",
        transport: "stdio",
        config: { command: "x", args: [] },
      })
      registerNativeAnthropicTool("computer_20251124", {
        id: "computer_20251124",
        name: "computer",
        type: "computer_20251124",
        executeIpc: { invoke: "plugin_computer_execute" },
      })
      registerCharacterPack("pack-a", {
        id: "pack-a",
        name: "P",
        description: "",
        version: "1.0.0",
        characters: [
          {
            localId: "alice",
            name: "Alice",
            avatarColor: "oklch(0.7 0.1 200)",
            systemPrompt: "Hi.",
          },
        ],
      })

      const tpl = makeTemplate("full", {
        requires: {
          skillIds: ["skill-a"],
          mcpServerPresetIds: ["mcp-a"],
          nativeAnthropicToolIds: ["computer_20251124"],
          characterPackIds: ["pack-a"],
          externalAgentPresetIds: ["claude-code"],
        },
      })
      expect(validateTemplateRequires(tpl)).toEqual({ warnings: [], ok: true })
    })
  })

  describe("warnings lifecycle", () => {
    it("stores warnings on register and clears them when the dependency arrives", () => {
      registerAgentTeamTemplate(
        "needs-skill",
        makeTemplate("needs-skill", { requires: { skillIds: ["s1"] } })
      )
      expect(getTemplateWarnings("needs-skill")).toEqual([
        { code: "missing-skill", missingId: "s1" },
      ])

      registerSkill("s1", {
        id: "s1",
        name: "S",
        description: "",
        source: { kind: "inline", markdown: "" },
      })
      refreshAllTemplateWarnings()
      expect(getTemplateWarnings("needs-skill")).toEqual([])
    })

    it("returns an empty array for clean templates (no null checks needed)", () => {
      registerAgentTeamTemplate("clean", makeTemplate("clean"))
      expect(getTemplateWarnings("clean")).toEqual([])
    })
  })

  it("__resetAgentTeamTemplatesForTesting clears everything", () => {
    registerAgentTeamTemplate("a", makeTemplate("a", { requires: { skillIds: ["x"] } }), {
      pluginId: "p1",
    })
    __resetAgentTeamTemplatesForTesting()
    expect(listAgentTeamTemplateIds()).toEqual([])
    expect(getTemplateWarnings("a")).toEqual([])
  })
})
