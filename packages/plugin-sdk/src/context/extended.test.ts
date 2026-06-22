import type { PluginAgentAPI, PluginContext, PluginDefinition, PluginManifest } from "./extended"
import type {
  PluginMcpServerPresetDef,
  PluginNativeAnthropicToolDef,
  PluginSkillDef,
} from "./extended"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The extended-context module is type-only — there is no runtime export to
 * assert against. This test compiles a representative shape from each
 * re-exported type, giving us a tripwire if the upstream definitions move
 * or change name in a way the SDK contract would not cover.
 */
describe("plugin-sdk: context/extended", () => {
  it("mirrors the main context barrel while preserving legacy agent-registration definitions", () => {
    const barrelSource = readFileSync(
      join(process.cwd(), "packages/plugin-sdk/src/context/extended.ts"),
      "utf8"
    )

    expect(barrelSource).toMatch(/export\s+type\s+\*\s+from\s+["']\.\/index["']/)
    for (const legacyType of [
      "PluginDefinition",
      "PluginManifest",
      "PluginMcpServerPresetDef",
      "PluginNativeAnthropicToolDef",
      "PluginSkillDef",
    ]) {
      expect(barrelSource).toContain(legacyType)
    }
  })

  it("re-exports types compatible with concrete plugin definitions", () => {
    const tool: PluginNativeAnthropicToolDef = {
      id: "x",
      name: "x",
      type: "bash_20250124",
      executeIpc: { invoke: "x" },
    }
    const skill: PluginSkillDef = {
      id: "s",
      name: "s",
      description: "test skill",
      source: { kind: "inline", markdown: "# heading" },
    }
    const preset: PluginMcpServerPresetDef = {
      id: "p",
      name: "p",
      description: "test preset",
      transport: "stdio",
      config: { command: "echo", args: ["hi"] },
    }

    const manifest: PluginManifest = {
      id: "test",
      name: "test",
      version: "0.0.0",
      description: "test",
      type: "frontend",
      capabilities: ["native-anthropic-tool"],
      main: "src/index.ts",
      nativeAnthropicTools: [tool],
    } as PluginManifest

    const def: PluginDefinition = {
      manifest,
      activate: async (ctx: PluginContext) => {
        const agent: PluginAgentAPI | undefined = ctx.agent
        agent?.registerNativeAnthropicTool(tool)
        agent?.registerSkill(skill)
        agent?.registerMcpServerPreset(preset)
      },
    }

    expect(def.manifest.id).toBe("test")
  })
})
