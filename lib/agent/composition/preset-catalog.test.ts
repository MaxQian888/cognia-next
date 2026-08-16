import {
  AXIS_ONLY_LEGACY_MODE_IDS,
  CODE_PRESET,
  CREATOR_PRESET,
  MINIMAL_PRESET,
  MINIMAL_TOOL_SET,
  NEW_BUILT_IN_PRESETS,
  STANDARD_PRESET,
  builtInDomainPresets,
  builtInPresetCatalog,
  presetFromAgentMode,
  visiblePresets,
} from "./preset-catalog"
import { BUILT_IN_AGENT_MODES } from "@/types/agent/agent-mode"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import { SDK_CORE_TOOL_NAMES } from "@/lib/skills/recording/tool-catalog"

describe("the four new presets", () => {
  it("offers Standard, Minimal, Code and Creator in picker order", () => {
    expect(NEW_BUILT_IN_PRESETS.map((preset) => preset.id)).toEqual([
      "standard",
      "minimal",
      "code",
      "creator",
    ])
  })

  it("pins Minimal to tool names that actually exist", () => {
    // An invented name would make Minimal silently inert rather than restrictive.
    for (const tool of MINIMAL_TOOL_SET) expect(SDK_CORE_TOOL_NAMES).toContain(tool)
    expect(MINIMAL_PRESET.defaultToolSet).toEqual([...MINIMAL_TOOL_SET])
  })

  it("caps Minimal at plan so no selection can make it an editor", () => {
    expect(MINIMAL_PRESET.maxAuthority).toBe("plan")
  })

  it("keeps Creator away from bypassPermissions and behind developer mode", () => {
    expect(CREATOR_PRESET.maxAuthority).toBe("acceptEdits")
    expect(CREATOR_PRESET.visibility).toBe("developer-only")
  })

  it("ships Code as experimental and read-only-capped", () => {
    expect(CODE_PRESET.experimental).toBe(true)
    expect(CODE_PRESET.recommends?.toolPresentation).toBe("code")
    expect(CODE_PRESET.maxAuthority).toBe("default")
  })

  it("leaves Standard uncapped so the host default governs it", () => {
    expect(STANDARD_PRESET.maxAuthority).toBeUndefined()
    expect(STANDARD_PRESET.legacyModeId).toBe("general")
  })
})

describe("builtInDomainPresets", () => {
  it("omits the ids that are axis values rather than personas", () => {
    const ids = builtInDomainPresets().map((preset) => preset.id)
    for (const legacyId of AXIS_ONLY_LEGACY_MODE_IDS) expect(ids).not.toContain(legacyId)
  })

  it("adapts every other built-in mode exactly once", () => {
    const expected = BUILT_IN_AGENT_MODES.filter(
      (mode) => !AXIS_ONLY_LEGACY_MODE_IDS.includes(mode.id)
    ).map((mode) => mode.id)
    expect(builtInDomainPresets().map((preset) => preset.id)).toEqual(expected)
  })

  it("carries each adapted mode's prompt and tools", () => {
    const research = builtInDomainPresets().find((preset) => preset.id === "research")
    const source = BUILT_IN_AGENT_MODES.find((mode) => mode.id === "research")
    expect(research?.systemPromptDelta).toBe(source?.systemPrompt)
    expect(research?.defaultToolSet).toEqual(source?.tools)
    expect(research?.legacyModeId).toBe("research")
  })
})

describe("builtInPresetCatalog", () => {
  it("puts the new presets first and has no duplicate ids", () => {
    const catalog = builtInPresetCatalog()
    expect(catalog.slice(0, 4).map((preset) => preset.id)).toEqual([
      "standard",
      "minimal",
      "code",
      "creator",
    ])
    expect(new Set(catalog.map((preset) => preset.id)).size).toBe(catalog.length)
  })
})

describe("presetFromAgentMode", () => {
  const mode: AgentModeConfig = {
    id: "my-mode",
    type: "custom",
    name: "My mode",
    description: "does things",
    icon: "Star",
    systemPrompt: "be brief",
    tools: ["Read"],
    outputFormat: "markdown",
    previewEnabled: true,
    permissionMode: "acceptEdits",
  }

  it("projects a mode without losing what the composition layer reads", () => {
    expect(presetFromAgentMode(mode, "custom")).toEqual({
      id: "my-mode",
      source: "custom",
      version: "1",
      name: "My mode",
      description: "does things",
      icon: "Star",
      systemPromptDelta: "be brief",
      defaultToolSet: ["Read"],
      recommends: {
        authority: "acceptEdits",
        toolPresentation: "native",
        orchestration: "direct",
      },
      outputFormat: "markdown",
      previewEnabled: true,
      legacyModeId: "my-mode",
    })
  })

  it("copies the tool list rather than aliasing it", () => {
    const preset = presetFromAgentMode(mode, "plugin")
    preset.defaultToolSet?.push("Bash")
    expect(mode.tools).toEqual(["Read"])
  })

  it("leaves authority unrecommended when the mode had no permission mode", () => {
    const { permissionMode: _permissionMode, ...withoutPermission } = mode
    expect(presetFromAgentMode(withoutPermission, "plugin").recommends?.authority).toBeUndefined()
  })

  it("records the source it was adapted from", () => {
    expect(presetFromAgentMode(mode, "plugin").source).toBe("plugin")
  })

  it("leaves an absent tool list absent instead of inventing an empty one", () => {
    // `[]` would read as "this preset offers no tools", which is the opposite
    // of "this preset does not override the host's tools".
    const { tools: _tools, ...withoutTools } = mode
    expect(presetFromAgentMode(withoutTools, "custom").defaultToolSet).toBeUndefined()
  })
})

describe("visiblePresets", () => {
  const catalog = builtInPresetCatalog()

  it("hides Creator until developer mode is on", () => {
    const ids = visiblePresets(catalog, { developerMode: false }).map((preset) => preset.id)
    expect(ids).not.toContain("creator")
    expect(ids).toContain("standard")
  })

  it("shows Creator to developers", () => {
    const ids = visiblePresets(catalog, { developerMode: true }).map((preset) => preset.id)
    expect(ids).toContain("creator")
  })

  it("hides experimental presets unless they are asked for", () => {
    expect(
      visiblePresets(catalog, { developerMode: true }).map((preset) => preset.id)
    ).not.toContain("code")
    expect(
      visiblePresets(catalog, { developerMode: true, includeExperimental: true }).map(
        (preset) => preset.id
      )
    ).toContain("code")
  })

  it("applies both gates independently", () => {
    const ids = visiblePresets(catalog, {
      developerMode: false,
      includeExperimental: true,
    }).map((preset) => preset.id)
    expect(ids).toContain("code")
    expect(ids).not.toContain("creator")
  })
})
