/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

const builtIn = [
  {
    id: "default",
    type: "built-in",
    name: "Default",
    systemPrompt: "do default",
    tools: ["search"],
    outputFormat: "text",
  },
  {
    id: "plan",
    type: "built-in",
    name: "Plan",
    systemPrompt: "plan first",
    tools: ["search", "edit"],
    outputFormat: "markdown",
  },
]

jest.mock("@/types/agent/agent-mode", () => ({
  BUILT_IN_AGENT_MODES: [
    {
      id: "default",
      type: "built-in",
      name: "Default",
      systemPrompt: "do default",
      tools: ["search"],
      outputFormat: "text",
    },
    {
      id: "plan",
      type: "built-in",
      name: "Plan",
      systemPrompt: "plan first",
      tools: ["search", "edit"],
      outputFormat: "markdown",
    },
  ],
}))

const customModes: Record<string, unknown> = {}
const createMode = jest.fn()
const updateMode = jest.fn()
const deleteMode = jest.fn()
const duplicateMode = jest.fn()
const recordModeUsage = jest.fn()

jest.mock("@/stores/agent/custom-mode-store", () => ({
  useCustomModeStore: <T>(
    selector: (s: {
      customModes: typeof customModes
      createMode: typeof createMode
      updateMode: typeof updateMode
      deleteMode: typeof deleteMode
      duplicateMode: typeof duplicateMode
      recordModeUsage: typeof recordModeUsage
    }) => T
  ): T =>
    selector({
      customModes,
      createMode,
      updateMode,
      deleteMode,
      duplicateMode,
      recordModeUsage,
    }),
}))

const pluginModes: Array<{
  id: string
  type: string
  name: string
  systemPrompt?: string
  tools?: string[]
  outputFormat?: string
}> = []

jest.mock("@/stores/plugin/plugin-store", () => ({
  usePluginStore: <T>(selector: (s: { getAllModes: () => typeof pluginModes }) => T): T =>
    selector({ getAllModes: () => pluginModes }),
}))

import { useAgentMode } from "./use-agent-mode"

beforeEach(() => {
  for (const k of Object.keys(customModes)) delete customModes[k]
  pluginModes.length = 0
  createMode.mockReset()
  updateMode.mockReset()
  deleteMode.mockReset()
  duplicateMode.mockReset()
  recordModeUsage.mockReset()
})

describe("useAgentMode", () => {
  it("returns built-in + custom + plugin modes by default", () => {
    customModes["c1"] = {
      id: "c1",
      type: "custom",
      name: "Custom",
      systemPrompt: "be clever",
      tools: ["x"],
      outputFormat: "code",
    }
    pluginModes.push({
      id: "p1",
      type: "plugin",
      name: "Plugin",
      systemPrompt: "plug in",
      tools: ["y"],
      outputFormat: "html",
    })
    const { result } = renderHook(() => useAgentMode())
    expect(result.current.allModes.map((m) => m.id)).toEqual(["default", "plan", "c1", "p1"])
    expect(result.current.builtInModes).toHaveLength(2)
    expect(result.current.customModes.map((m) => m.id)).toEqual(["c1"])
    expect(result.current.pluginModes.map((m) => m.id)).toEqual(["p1"])
  })

  it("respects include* options", () => {
    customModes["c1"] = { id: "c1", type: "custom", name: "C" }
    pluginModes.push({ id: "p1", type: "plugin", name: "P" })
    const { result } = renderHook(() =>
      useAgentMode({ includeBuiltIn: false, includeCustom: true, includePlugin: false })
    )
    expect(result.current.builtInModes).toEqual([])
    expect(result.current.allModes.map((m) => m.id)).toEqual(["c1"])
  })

  it("getModeById walks built-in → custom → plugin", () => {
    customModes["c1"] = { id: "c1", type: "custom", name: "C" }
    pluginModes.push({ id: "p1", type: "plugin", name: "P" })
    const { result } = renderHook(() => useAgentMode())
    expect(result.current.getModeById("default")?.id).toBe("default")
    expect(result.current.getModeById("c1")?.id).toBe("c1")
    expect(result.current.getModeById("p1")?.id).toBe("p1")
    expect(result.current.getModeById("nope")).toBeUndefined()
  })

  it("getModesByType returns the right slice (and empty for unknown)", () => {
    customModes["c1"] = { id: "c1", type: "custom", name: "C" }
    pluginModes.push({ id: "p1", type: "plugin", name: "P" })
    const { result } = renderHook(() => useAgentMode())
    expect(result.current.getModesByType("built-in")).toEqual(builtIn)
    expect(result.current.getModesByType("custom").map((m) => m.id)).toEqual(["c1"])
    expect(result.current.getModesByType("plugin").map((m) => m.id)).toEqual(["p1"])
    // @ts-expect-error – exercising the default branch
    expect(result.current.getModesByType("other")).toEqual([])
  })

  it("type guards distinguish each mode source", () => {
    customModes["c1"] = { id: "c1", type: "custom", name: "C" }
    pluginModes.push({ id: "p1", type: "plugin", name: "P" })
    const { result } = renderHook(() => useAgentMode())
    expect(result.current.isBuiltInMode("default")).toBe(true)
    expect(result.current.isBuiltInMode("c1")).toBe(false)
    expect(result.current.isCustomMode("c1")).toBe(true)
    expect(result.current.isCustomMode("default")).toBe(false)
    expect(result.current.isPluginMode("p1")).toBe(true)
    expect(result.current.isPluginMode("c1")).toBe(false)
  })

  it("recordUsage only forwards for custom modes", () => {
    customModes["c1"] = { id: "c1", type: "custom", name: "C" }
    const { result } = renderHook(() => useAgentMode())
    result.current.recordUsage("default")
    expect(recordModeUsage).not.toHaveBeenCalled()
    result.current.recordUsage("c1")
    expect(recordModeUsage).toHaveBeenCalledWith("c1")
  })

  it("config helpers fall back when the mode is missing or has no value", () => {
    const { result } = renderHook(() => useAgentMode())
    expect(result.current.getModeSystemPrompt("default")).toBe("do default")
    expect(result.current.getModeSystemPrompt("missing")).toBe("")
    expect(result.current.getModeTools("default")).toEqual(["search"])
    expect(result.current.getModeTools("missing")).toEqual([])
    expect(result.current.getModeOutputFormat("plan")).toBe("markdown")
    expect(result.current.getModeOutputFormat("missing")).toBe("text")
  })

  it("CRUD passthroughs are wired to the store actions", () => {
    const { result } = renderHook(() => useAgentMode())
    expect(result.current.createCustomMode).toBe(createMode)
    expect(result.current.updateCustomMode).toBe(updateMode)
    expect(result.current.deleteCustomMode).toBe(deleteMode)
    expect(result.current.duplicateCustomMode).toBe(duplicateMode)
  })
})
