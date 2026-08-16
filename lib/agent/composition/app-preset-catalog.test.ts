/** @jest-environment jsdom */

import { appPresetCatalog, appPresetIds, composeAppPresetCatalog } from "./app-preset-catalog"
import { builtInPresetCatalog } from "./preset-catalog"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

function mode(id: string, overrides: Partial<AgentModeConfig> = {}): AgentModeConfig {
  return {
    id,
    type: "custom",
    name: `Mode ${id}`,
    description: `Description for ${id}`,
    icon: "Sparkles",
    ...overrides,
  }
}

describe("composeAppPresetCatalog", () => {
  it("returns exactly the built-in catalog when neither store contributes", () => {
    expect(composeAppPresetCatalog({ customModes: [], pluginModes: [] })).toEqual(
      builtInPresetCatalog()
    )
  })

  it("appends custom then plugin modes after the built-ins", () => {
    const catalog = composeAppPresetCatalog({
      customModes: [mode("my-reviewer")],
      pluginModes: [mode("plugin-writer")],
    })

    const builtInCount = builtInPresetCatalog().length
    expect(catalog).toHaveLength(builtInCount + 2)
    expect(catalog[builtInCount].id).toBe("my-reviewer")
    expect(catalog[builtInCount + 1].id).toBe("plugin-writer")
  })

  it("tags each projection with the source it came from", () => {
    const catalog = composeAppPresetCatalog({
      customModes: [mode("mine")],
      pluginModes: [mode("theirs")],
    })

    expect(catalog.find((p) => p.id === "mine")?.source).toBe("custom")
    expect(catalog.find((p) => p.id === "theirs")?.source).toBe("plugin")
    expect(catalog.find((p) => p.id === "standard")?.source).toBe("builtin")
  })

  it("carries the mode's prompt and tools onto the preset", () => {
    const catalog = composeAppPresetCatalog({
      customModes: [mode("mine", { systemPrompt: "Be terse.", tools: ["Read", "Grep"] })],
      pluginModes: [],
    })
    const preset = catalog.find((p) => p.id === "mine")

    expect(preset?.systemPromptDelta).toBe("Be terse.")
    expect(preset?.defaultToolSet).toEqual(["Read", "Grep"])
    // The composition layer resolves personas through `legacyModeId`, so the
    // projection is useless to the send path without it.
    expect(preset?.legacyModeId).toBe("mine")
  })

  // Radix `SelectItem` requires unique values, and the send path resolves the
  // built-in first regardless — a merged duplicate would describe a mode that
  // never actually runs.
  it("drops a custom mode that collides with a built-in preset id", () => {
    const catalog = composeAppPresetCatalog({
      customModes: [mode("standard", { name: "Impostor" })],
      pluginModes: [],
    })

    expect(catalog.filter((p) => p.id === "standard")).toHaveLength(1)
    expect(catalog.find((p) => p.id === "standard")?.source).toBe("builtin")
  })

  it("drops a plugin mode that collides with a custom mode id", () => {
    const catalog = composeAppPresetCatalog({
      customModes: [mode("shared", { name: "Mine" })],
      pluginModes: [mode("shared", { name: "Theirs" })],
    })

    expect(catalog.filter((p) => p.id === "shared")).toHaveLength(1)
    expect(catalog.find((p) => p.id === "shared")?.source).toBe("custom")
  })

  it("never emits an axis-only legacy id as a preset of its own", () => {
    const ids = composeAppPresetCatalog({ customModes: [], pluginModes: [] }).map((p) => p.id)

    expect(ids).not.toContain("general")
    expect(ids).not.toContain("plan")
    expect(ids).not.toContain("build")
    expect(ids).not.toContain("workflow")
  })
})

describe("appPresetCatalog / appPresetIds", () => {
  afterEach(() => {
    useCustomModeStore.setState({ customModes: {} })
    jest.restoreAllMocks()
  })

  it("reads both stores", () => {
    useCustomModeStore.setState({
      customModes: {
        mine: {
          ...mode("mine"),
          type: "custom",
          isBuiltIn: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      } as never,
    })
    jest.spyOn(usePluginStore.getState(), "getAllModes").mockReturnValue([mode("from-plugin")])

    const ids = appPresetCatalog().map((p) => p.id)
    expect(ids).toContain("mine")
    expect(ids).toContain("from-plugin")
    expect(ids).toContain("standard")
  })

  it("exposes the same ids as a set, which is what the legacy-mode migration needs", () => {
    useCustomModeStore.setState({
      customModes: {
        mine: {
          ...mode("mine"),
          type: "custom",
          isBuiltIn: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      } as never,
    })

    const ids = appPresetIds()
    expect(ids.has("mine")).toBe(true)
    expect(ids.has("standard")).toBe(true)
    expect(ids.has("nope")).toBe(false)
  })
})
