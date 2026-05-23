/**
 * Plugin Agent Integration Tests
 */

import {
  PluginAgentBridge,
  getPluginAgentBridge,
  mergeWithBuiltinTools,
  mergeWithBuiltinModes,
  type PluginAgentTool,
} from "./agent-integration"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

// Mock the plugin store
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: jest.fn(),
  },
}))

// Mock analytics
jest.mock("../utils/analytics", () => ({
  trackPluginEvent: jest.fn().mockResolvedValue(undefined),
}))

const mockUsePluginStore = usePluginStore as jest.Mocked<typeof usePluginStore>

describe("PluginAgentBridge", () => {
  let bridge: PluginAgentBridge

  beforeEach(() => {
    bridge = new PluginAgentBridge()
    jest.clearAllMocks()
  })

  describe("getPluginTools", () => {
    it("should return empty array when no plugins", () => {
      mockUsePluginStore.getState.mockReturnValue({
        plugins: {},
      } as ReturnType<typeof usePluginStore.getState>)

      const tools = bridge.getPluginTools()
      expect(tools).toEqual([])
    })

    it("should return tools from enabled plugins", () => {
      mockUsePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            manifest: { id: "test-plugin", name: "Test Plugin" },
            status: "enabled",
            tools: [
              {
                name: "test_tool",
                pluginId: "test-plugin",
                definition: {
                  name: "test_tool",
                  description: "A test tool",
                  parametersSchema: { type: "object" },
                },
                execute: jest.fn(),
              },
            ],
          },
        },
      } as unknown as ReturnType<typeof usePluginStore.getState>)

      const tools = bridge.getPluginTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe("test_tool")
      expect(tools[0].pluginId).toBe("test-plugin")
    })

    it("should not return tools from disabled plugins", () => {
      mockUsePluginStore.getState.mockReturnValue({
        plugins: {
          "disabled-plugin": {
            manifest: { id: "disabled-plugin", name: "Disabled Plugin" },
            status: "disabled",
            tools: [
              {
                name: "disabled_tool",
                pluginId: "disabled-plugin",
                definition: {
                  name: "disabled_tool",
                  description: "Disabled",
                  parametersSchema: {},
                },
                execute: jest.fn(),
              },
            ],
          },
        },
      } as unknown as ReturnType<typeof usePluginStore.getState>)

      const tools = bridge.getPluginTools()
      expect(tools).toEqual([])
    })
  })

  describe("getPluginModes", () => {
    it("should return empty array when no plugins", () => {
      mockUsePluginStore.getState.mockReturnValue({
        plugins: {},
      } as ReturnType<typeof usePluginStore.getState>)

      const modes = bridge.getPluginModes()
      expect(modes).toEqual([])
    })

    it("should return modes from enabled plugins", () => {
      mockUsePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            manifest: { id: "test-plugin", name: "Test Plugin" },
            status: "enabled",
            modes: [
              {
                id: "test-mode",
                name: "Test Mode",
                description: "A test mode",
                icon: "test",
              },
            ],
          },
        },
      } as unknown as ReturnType<typeof usePluginStore.getState>)

      const modes = bridge.getPluginModes()
      expect(modes).toHaveLength(1)
      expect(modes[0].id).toBe("test-mode")
      expect(modes[0].pluginId).toBe("test-plugin")
      expect(modes[0].isPluginMode).toBe(true)
    })
  })

  describe("getTool", () => {
    beforeEach(() => {
      mockUsePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            manifest: { id: "test-plugin" },
            status: "enabled",
            tools: [
              {
                name: "find_tool",
                pluginId: "test-plugin",
                definition: { name: "find_tool", description: "Find me", parametersSchema: {} },
                execute: jest.fn(),
              },
            ],
          },
        },
      } as unknown as ReturnType<typeof usePluginStore.getState>)
    })

    it("should find tool by name", () => {
      const tool = bridge.getTool("find_tool")
      expect(tool).toBeDefined()
      expect(tool?.name).toBe("find_tool")
    })

    it("should return undefined for unknown tool", () => {
      const tool = bridge.getTool("unknown_tool")
      expect(tool).toBeUndefined()
    })
  })

  describe("getMode", () => {
    beforeEach(() => {
      mockUsePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            manifest: { id: "test-plugin", name: "Test" },
            status: "enabled",
            modes: [{ id: "find-mode", name: "Find Mode", description: "Find me", icon: "search" }],
          },
        },
      } as unknown as ReturnType<typeof usePluginStore.getState>)
    })

    it("should find mode by id", () => {
      const mode = bridge.getMode("find-mode")
      expect(mode).toBeDefined()
      expect(mode?.id).toBe("find-mode")
    })

    it("should return undefined for unknown mode", () => {
      const mode = bridge.getMode("unknown-mode")
      expect(mode).toBeUndefined()
    })
  })

  describe("executeTool", () => {
    it("should return error for unknown tool", async () => {
      mockUsePluginStore.getState.mockReturnValue({
        plugins: {},
      } as ReturnType<typeof usePluginStore.getState>)

      const result = await bridge.executeTool("unknown", {})
      expect(result.success).toBe(false)
      expect(result.error).toContain("not found")
    })

    it("should execute tool and return result", async () => {
      const mockExecute = jest.fn().mockResolvedValue({ data: "result" })

      mockUsePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            manifest: { id: "test-plugin" },
            status: "enabled",
            config: {},
            tools: [
              {
                name: "exec_tool",
                pluginId: "test-plugin",
                definition: { name: "exec_tool", description: "Execute", parametersSchema: {} },
                execute: mockExecute,
              },
            ],
          },
        },
      } as unknown as ReturnType<typeof usePluginStore.getState>)

      const result = await bridge.executeTool("exec_tool", { param: "value" })
      expect(result.success).toBe(true)
      expect(result.result).toEqual({ data: "result" })
    })

    it("should handle tool execution errors", async () => {
      const mockExecute = jest.fn().mockRejectedValue(new Error("Execution failed"))

      mockUsePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            manifest: { id: "test-plugin" },
            status: "enabled",
            config: {},
            tools: [
              {
                name: "failing_tool",
                pluginId: "test-plugin",
                definition: { name: "failing_tool", description: "Fails", parametersSchema: {} },
                execute: mockExecute,
              },
            ],
          },
        },
      } as unknown as ReturnType<typeof usePluginStore.getState>)

      const result = await bridge.executeTool("failing_tool", {})
      expect(result.success).toBe(false)
      expect(result.error).toBe("Execution failed")
    })
  })

  describe("getToolsForMode", () => {
    beforeEach(() => {
      mockUsePluginStore.getState.mockReturnValue({
        plugins: {
          "test-plugin": {
            manifest: { id: "test-plugin", name: "Test" },
            status: "enabled",
            tools: [
              {
                name: "tool_a",
                pluginId: "test-plugin",
                definition: { name: "tool_a", description: "Tool A", parametersSchema: {} },
                execute: jest.fn(),
              },
              {
                name: "tool_b",
                pluginId: "test-plugin",
                definition: { name: "tool_b", description: "Tool B", parametersSchema: {} },
                execute: jest.fn(),
              },
            ],
            modes: [
              {
                id: "specific-mode",
                name: "Specific Mode",
                description: "Uses specific tools",
                icon: "tool",
                tools: ["tool_a"],
              },
            ],
          },
        },
      } as unknown as ReturnType<typeof usePluginStore.getState>)
    })

    it("should return tools specified by mode", () => {
      const tools = bridge.getToolsForMode("specific-mode")
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe("tool_a")
    })

    it("should return empty array for unknown mode", () => {
      const tools = bridge.getToolsForMode("unknown-mode")
      expect(tools).toEqual([])
    })
  })
})

describe("getPluginAgentBridge", () => {
  it("should return singleton instance", () => {
    const bridge1 = getPluginAgentBridge()
    const bridge2 = getPluginAgentBridge()
    expect(bridge1).toBe(bridge2)
  })
})

describe("mergeWithBuiltinTools", () => {
  const builtinTools = [
    { name: "web_search", description: "Search the web", parameters: {} },
    { name: "calculator", description: "Calculate", parameters: {} },
  ]

  const pluginTools: PluginAgentTool[] = [
    {
      name: "plugin_tool",
      pluginId: "test",
      description: "Plugin tool",
      parametersSchema: {},
      execute: jest.fn(),
      enabled: true,
    },
  ]

  it("should merge builtin and plugin tools", () => {
    const merged = mergeWithBuiltinTools(builtinTools, pluginTools)
    expect(merged).toHaveLength(3)
  })

  it("should mark source correctly", () => {
    const merged = mergeWithBuiltinTools(builtinTools, pluginTools)

    const builtin = merged.find((t) => t.name === "web_search")
    expect(builtin?.source).toBe("builtin")

    const plugin = merged.find((t) => t.name === "plugin_tool")
    expect(plugin?.source).toBe("plugin")
  })

  it("should prefer plugin tools when names conflict", () => {
    const conflictingPluginTools: PluginAgentTool[] = [
      {
        name: "web_search",
        pluginId: "override",
        description: "Override search",
        parametersSchema: {},
        execute: jest.fn(),
        enabled: true,
      },
    ]

    const merged = mergeWithBuiltinTools(builtinTools, conflictingPluginTools)
    const searchTools = merged.filter((t) => t.name === "web_search")
    expect(searchTools).toHaveLength(1)
  })
})

describe("mergeWithBuiltinModes", () => {
  const builtinModes: AgentModeConfig[] = [
    {
      id: "general",
      name: "General",
      description: "General mode",
      icon: "bot",
      type: "general",
      tools: [],
    },
  ]

  it("should merge builtin and plugin modes", () => {
    const pluginModes = [
      {
        id: "plugin-mode",
        name: "Plugin Mode",
        description: "From plugin",
        icon: "plugin",
        type: "custom" as const,
        tools: [],
        pluginId: "test",
        pluginName: "Test",
        isPluginMode: true as const,
      },
    ]

    const merged = mergeWithBuiltinModes(builtinModes, pluginModes)
    expect(merged).toHaveLength(2)
  })

  it("should mark source correctly", () => {
    const pluginModes = [
      {
        id: "plugin-mode",
        name: "Plugin Mode",
        description: "From plugin",
        icon: "plugin",
        type: "custom" as const,
        tools: [],
        pluginId: "test",
        pluginName: "Test",
        isPluginMode: true as const,
      },
    ]

    const merged = mergeWithBuiltinModes(builtinModes, pluginModes)

    const builtin = merged.find((m) => m.id === "general")
    expect(builtin?.source).toBe("builtin")

    const plugin = merged.find((m) => m.id === "plugin-mode")
    expect(plugin?.source).toBe("plugin")
  })
})
