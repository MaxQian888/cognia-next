/**
 * Tests for the plugin capability enumeration API.
 *
 * Overlay registries + the workflow catalog/trigger registry are exercised
 * for real; the manager-backed sources (tools/commands/modes + plugin
 * status) are injected via `__setPluginCapabilityDepsForTesting`.
 */

import type { PluginTool } from "@/types/plugin"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

import {
  __setPluginCapabilityDepsForTesting,
  getPluginCapabilities,
  listPluginCapabilities,
  type PluginCapabilityDeps,
} from "./plugin-capability-registry"
import { registerSkill, __resetSkillsForTesting } from "@/lib/plugin/registries/skill-registry"
import {
  registerMcpServerPreset,
  __resetMcpServerPresetsForTesting,
} from "@/lib/plugin/registries/mcp-server-preset-registry"
import {
  registerWorkflowTemplate,
  __resetWorkflowTemplatesForTesting,
} from "@/lib/plugin/registries/workflow-template-registry"
import {
  registerSubagent,
  __resetSubagentsForTesting,
} from "@/lib/plugin/registries/subagent-registry"
import { addPluginCatalogEntry, __resetPluginCatalogForTesting } from "@/lib/workflow/nodes/catalog"
import { registerPluginTrigger, unregisterPluginTrigger } from "@/lib/workflow/triggers/registry"

const PLUGIN = "plug-cap"

function makeTool(name: string): PluginTool {
  return {
    name,
    pluginId: PLUGIN,
    definition: {
      name,
      description: `does ${name}`,
      parametersSchema: { type: "object", properties: { q: { type: "string" } } },
    },
    execute: async () => ({}),
  }
}

function makeDeps(overrides?: Partial<PluginCapabilityDeps>): PluginCapabilityDeps {
  return {
    getRegistry: () => ({
      getToolsByPlugin: (pluginId: string) => (pluginId === PLUGIN ? [makeTool("scan")] : []),
      getCommandsByPlugin: (pluginId: string) =>
        pluginId === PLUGIN
          ? [
              {
                id: `${PLUGIN}.refresh`,
                name: "Refresh",
                description: "refreshes",
                execute: async () => {},
              },
            ]
          : [],
      getModesByPlugin: (pluginId: string) =>
        pluginId === PLUGIN
          ? [
              {
                id: `${PLUGIN}:focus`,
                type: "custom",
                name: "Focus",
                description: "focus mode",
                icon: "Target",
              } as AgentModeConfig,
            ]
          : [],
    }),
    listPlugins: () => [{ id: PLUGIN, status: "enabled" }],
    ...overrides,
  }
}

afterEach(async () => {
  __setPluginCapabilityDepsForTesting(null)
  __resetSkillsForTesting()
  __resetMcpServerPresetsForTesting()
  __resetWorkflowTemplatesForTesting()
  __resetSubagentsForTesting()
  __resetPluginCatalogForTesting()
  await unregisterPluginTrigger(`${PLUGIN}.trigger.poll`, 1)
})

describe("getPluginCapabilities", () => {
  it("aggregates manager-backed buckets (tools/commands/modes)", async () => {
    __setPluginCapabilityDepsForTesting(makeDeps())

    const caps = await getPluginCapabilities(PLUGIN)

    expect(caps.pluginId).toBe(PLUGIN)
    expect(caps.enabled).toBe(true)
    expect(caps.tools).toEqual([
      {
        kind: "tool",
        id: "scan",
        label: "scan",
        description: "does scan",
        argsSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ])
    expect(caps.commands).toEqual([
      { kind: "command", id: `${PLUGIN}.refresh`, label: "Refresh", description: "refreshes" },
    ])
    expect(caps.modes).toEqual([
      { kind: "mode", id: `${PLUGIN}:focus`, label: "Focus", description: "focus mode" },
    ])
  })

  it("aggregates overlay-registry buckets filtered by pluginId", async () => {
    __setPluginCapabilityDepsForTesting(makeDeps())
    registerSkill(
      `${PLUGIN}:skill-a`,
      {
        id: "skill-a",
        name: "Skill A",
        description: "a skill",
        source: { type: "inline", content: "x" },
        scope: "global",
      } as never,
      { pluginId: PLUGIN }
    )
    registerSkill(
      "other:skill-b",
      {
        id: "skill-b",
        name: "Skill B",
        description: "not ours",
        source: { type: "inline", content: "x" },
        scope: "global",
      } as never,
      { pluginId: "other" }
    )
    registerMcpServerPreset(
      `${PLUGIN}:preset-a`,
      { id: "preset-a", name: "Preset A", transport: "stdio", config: {} } as never,
      { pluginId: PLUGIN }
    )
    registerWorkflowTemplate(
      `${PLUGIN}:tpl-a`,
      { id: "tpl-a", name: "Template A", description: "tpl", category: "demo", nodes: [] } as never,
      { pluginId: PLUGIN }
    )
    registerSubagent(
      `${PLUGIN}:sub-a`,
      { id: "sub-a", name: "Sub A", description: "sub", prompt: "p" } as never,
      { pluginId: PLUGIN }
    )

    const caps = await getPluginCapabilities(PLUGIN)

    expect(caps.skills).toEqual([
      { kind: "skill", id: `${PLUGIN}:skill-a`, label: "Skill A", description: "a skill" },
    ])
    expect(caps.mcpPresets).toEqual([
      { kind: "mcp-preset", id: `${PLUGIN}:preset-a`, label: "Preset A", description: undefined },
    ])
    expect(caps.workflowTemplates).toEqual([
      { kind: "workflow-template", id: `${PLUGIN}:tpl-a`, label: "Template A", description: "tpl" },
    ])
    expect(caps.subagents).toEqual([
      { kind: "subagent", id: `${PLUGIN}:sub-a`, label: "Sub A", description: "sub" },
    ])
  })

  it("aggregates workflow node catalog + trigger registry entries", async () => {
    __setPluginCapabilityDepsForTesting(makeDeps())
    addPluginCatalogEntry({
      kind: `${PLUGIN}.save` as never,
      category: "plugin",
      label: "Save rows",
      description: "saves",
      iconName: "Save",
      keywords: [],
      pluginId: PLUGIN,
      paramsSchema: { type: "object" },
    })
    registerPluginTrigger({
      kind: `${PLUGIN}.trigger.poll`,
      typeVersion: 1,
      pluginId: PLUGIN,
      def: {
        kind: "trigger.poll",
        typeVersion: 1,
        label: "Poll",
        description: "polls",
        iconName: "Clock",
        paramsSchema: {},
        start: async () => ({ stop: async () => {} }),
      },
      instances: new Map(),
    })

    const caps = await getPluginCapabilities(PLUGIN)

    expect(caps.workflowNodes).toEqual([
      {
        kind: "workflow-node",
        id: `${PLUGIN}.save`,
        label: "Save rows",
        description: "saves",
        argsSchema: { type: "object" },
      },
    ])
    expect(caps.workflowTriggers).toEqual([
      {
        kind: "workflow-trigger",
        id: `${PLUGIN}.trigger.poll`,
        label: "Poll",
        description: "polls",
      },
    ])
  })

  it("returns empty buckets and enabled=false for an unknown plugin", async () => {
    __setPluginCapabilityDepsForTesting(makeDeps())

    const caps = await getPluginCapabilities("ghost")

    expect(caps.enabled).toBe(false)
    expect(caps.tools).toEqual([])
    expect(caps.skills).toEqual([])
    expect(caps.workflowNodes).toEqual([])
  })

  it("falls back to the dynamic-import default deps when no override is set", async () => {
    // No override: the real manager singleton is uninitialised in jsdom —
    // manager-backed buckets degrade to empty, plugin store is empty.
    __setPluginCapabilityDepsForTesting(null)

    const caps = await getPluginCapabilities("anyone")

    expect(caps.enabled).toBe(false)
    expect(caps.tools).toEqual([])
    expect(caps.commands).toEqual([])
  })

  it("degrades manager-backed buckets to empty when the registry throws", async () => {
    __setPluginCapabilityDepsForTesting(
      makeDeps({
        getRegistry: () => {
          throw new Error("manager not initialised")
        },
      })
    )
    registerSkill(
      `${PLUGIN}:skill-a`,
      {
        id: "skill-a",
        name: "Skill A",
        description: "a skill",
        source: { type: "inline", content: "x" },
        scope: "global",
      } as never,
      { pluginId: PLUGIN }
    )

    const caps = await getPluginCapabilities(PLUGIN)

    expect(caps.tools).toEqual([])
    // Overlay registries still resolve.
    expect(caps.skills).toHaveLength(1)
  })
})

describe("listPluginCapabilities", () => {
  it("returns one bucket per known plugin, unioning store + registry pluginIds", async () => {
    __setPluginCapabilityDepsForTesting(makeDeps())
    // A plugin known ONLY through an overlay registration (not the store).
    registerSkill(
      "registry-only:skill",
      {
        id: "skill",
        name: "Orphan skill",
        description: "registered before store hydration",
        source: { type: "inline", content: "x" },
        scope: "global",
      } as never,
      { pluginId: "registry-only" }
    )

    const all = await listPluginCapabilities()
    const ids = all.map((c) => c.pluginId)

    expect(ids).toEqual([PLUGIN, "registry-only"])
    expect(all.find((c) => c.pluginId === "registry-only")?.skills).toHaveLength(1)
    expect(all.find((c) => c.pluginId === "registry-only")?.enabled).toBe(false)
  })
})
