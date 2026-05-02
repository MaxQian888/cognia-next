/**
 * Tests for tools-bridge.ts
 * Plugin Tools Bridge - Connects plugin tools with the agent system
 */

import { z } from "zod"
import { PluginToolsBridge, createPluginToolsBridge } from "./tools-bridge"
import { usePluginStore } from "@/stores/plugin"
import type { PluginRegistry } from "../core/registry"
import type { PluginTool, PluginToolDef } from "@/types/plugin"

// Mock plugin store
jest.mock("@/stores/plugin", () => ({
  usePluginStore: {
    getState: jest.fn(),
  },
}))

const mockedUsePluginStore = usePluginStore as jest.Mocked<typeof usePluginStore>

// Mock registry
const createMockRegistry = (): jest.Mocked<PluginRegistry> =>
  ({
    registerTool: jest.fn(),
    unregisterTool: jest.fn(),
    getTool: jest.fn(),
    getAllTools: jest.fn().mockReturnValue([]),
    getToolsByPlugin: jest.fn().mockReturnValue([]),
  }) as unknown as jest.Mocked<PluginRegistry>

// Mock tool definition
const createMockToolDef = (name: string = "test_tool"): PluginToolDef => ({
  name,
  description: "Test tool description",
  parametersSchema: {
    type: "object",
    properties: {
      param1: { type: "string", description: "First param" },
      param2: { type: "number" },
    },
    required: ["param1"],
  },
})

// Mock plugin tool
const createMockTool = (name: string = "test_tool"): PluginTool => ({
  name,
  pluginId: "test-plugin",
  definition: createMockToolDef(name),
  execute: jest.fn().mockResolvedValue({ success: true }),
})

describe("PluginToolsBridge", () => {
  let bridge: PluginToolsBridge
  let mockRegistry: jest.Mocked<PluginRegistry>
  let mockStore: {
    plugins: Record<string, { config: Record<string, unknown> }>
    registerPluginTool: jest.Mock
    unregisterPluginTool: jest.Mock
  }

  beforeEach(() => {
    jest.clearAllMocks()

    mockRegistry = createMockRegistry()
    mockStore = {
      plugins: { "test-plugin": { config: { key: "value" } } },
      registerPluginTool: jest.fn(),
      unregisterPluginTool: jest.fn(),
    }

    mockedUsePluginStore.getState.mockReturnValue(mockStore as never)

    bridge = new PluginToolsBridge({ registry: mockRegistry })
  })

  describe("registerTool", () => {
    it("should register tool with registry", () => {
      const tool = createMockTool()

      bridge.registerTool("test-plugin", tool)

      expect(mockRegistry.registerTool).toHaveBeenCalledWith("test-plugin", tool)
    })

    it("should register tool with plugin store", () => {
      const tool = createMockTool()

      bridge.registerTool("test-plugin", tool)

      expect(mockStore.registerPluginTool).toHaveBeenCalledWith("test-plugin", tool)
    })

    it("should validate tool definition", () => {
      const invalidTool = createMockTool()
      invalidTool.definition.name = ""

      expect(() => bridge.registerTool("plugin", invalidTool)).toThrow("valid name")
    })

    it("should reject invalid tool name format", () => {
      const tool = createMockTool("InvalidName")

      expect(() => bridge.registerTool("plugin", tool)).toThrow("Invalid tool name")
    })

    it("should reject tool without description", () => {
      const tool = createMockTool()
      tool.definition.description = ""

      expect(() => bridge.registerTool("plugin", tool)).toThrow("valid description")
    })

    it("should reject tool without parameters schema", () => {
      const tool = createMockTool()
      tool.definition.parametersSchema = null as never

      expect(() => bridge.registerTool("plugin", tool)).toThrow("parametersSchema")
    })
  })

  describe("unregisterTool", () => {
    it("should unregister tool from registry", () => {
      const tool = createMockTool()
      mockRegistry.getTool.mockReturnValue(tool)

      bridge.unregisterTool("test_tool")

      expect(mockRegistry.unregisterTool).toHaveBeenCalledWith("test_tool")
    })

    it("should unregister from plugin store", () => {
      const tool = createMockTool()
      mockRegistry.getTool.mockReturnValue(tool)

      bridge.unregisterTool("test_tool")

      expect(mockStore.unregisterPluginTool).toHaveBeenCalledWith("test-plugin", "test_tool")
    })

    it("should do nothing for unknown tool", () => {
      mockRegistry.getTool.mockReturnValue(undefined)

      bridge.unregisterTool("unknown_tool")

      expect(mockRegistry.unregisterTool).not.toHaveBeenCalled()
    })
  })

  describe("unregisterPluginTools", () => {
    it("should unregister all tools from a plugin", () => {
      const tools = [createMockTool("tool1"), createMockTool("tool2")]
      mockRegistry.getToolsByPlugin.mockReturnValue(tools)
      mockRegistry.getTool.mockImplementation((name) => tools.find((t) => t.name === name))

      bridge.unregisterPluginTools("test-plugin")

      expect(mockRegistry.unregisterTool).toHaveBeenCalledTimes(2)
    })
  })

  describe("convertToAgentTool", () => {
    it("should convert plugin tool to agent tool", () => {
      const tool = createMockTool()

      const agentTool = bridge.convertToAgentTool(tool)

      expect(agentTool.name).toBe("test_tool")
      expect(agentTool.description).toBe("Test tool description")
      expect(agentTool.parameters).toBeDefined()
      expect(typeof agentTool.execute).toBe("function")
    })

    it("should execute tool with context", async () => {
      const executeFn = jest.fn().mockResolvedValue("result")
      const tool = createMockTool()
      tool.execute = executeFn

      const agentTool = bridge.convertToAgentTool(tool)
      await agentTool.execute({ param1: "value" })

      expect(executeFn).toHaveBeenCalledWith(
        { param1: "value" },
        expect.objectContaining({ config: { key: "value" } })
      )
    })

    it("should record successful execution", async () => {
      const tool = createMockTool()
      tool.execute = jest.fn().mockResolvedValue("success")

      const agentTool = bridge.convertToAgentTool(tool)
      await agentTool.execute({})

      const stats = bridge.getToolStats("test_tool")
      expect(stats.totalExecutions).toBe(1)
      expect(stats.successRate).toBe(1)
    })

    it("should record failed execution", async () => {
      const tool = createMockTool()
      tool.execute = jest.fn().mockRejectedValue(new Error("failed"))

      const agentTool = bridge.convertToAgentTool(tool)
      await expect(agentTool.execute({})).rejects.toThrow("failed")

      const stats = bridge.getToolStats("test_tool")
      expect(stats.totalExecutions).toBe(1)
      expect(stats.successRate).toBe(0)
    })

    it("should set requiresApproval from definition", () => {
      const tool = createMockTool()
      tool.definition.requiresApproval = true

      const agentTool = bridge.convertToAgentTool(tool)

      expect(agentTool.requiresApproval).toBe(true)
    })

    it("should default requiresApproval to false", () => {
      const tool = createMockTool()

      const agentTool = bridge.convertToAgentTool(tool)

      expect(agentTool.requiresApproval).toBe(false)
    })
  })

  describe("convertAllToAgentTools", () => {
    it("should convert all registered tools", () => {
      const tools = [createMockTool("tool1"), createMockTool("tool2")]
      mockRegistry.getAllTools.mockReturnValue(tools)

      const agentTools = bridge.convertAllToAgentTools()

      expect(agentTools).toHaveLength(2)
      expect(agentTools[0].name).toBe("tool1")
      expect(agentTools[1].name).toBe("tool2")
    })

    it("should return empty array when no tools", () => {
      mockRegistry.getAllTools.mockReturnValue([])

      const agentTools = bridge.convertAllToAgentTools()

      expect(agentTools).toHaveLength(0)
    })
  })

  describe("getPluginAgentTools", () => {
    it("should convert tools for specific plugin", () => {
      const tools = [createMockTool("plugin_tool")]
      mockRegistry.getToolsByPlugin.mockReturnValue(tools)

      const agentTools = bridge.getPluginAgentTools("my-plugin")

      expect(mockRegistry.getToolsByPlugin).toHaveBeenCalledWith("my-plugin")
      expect(agentTools).toHaveLength(1)
    })
  })

  describe("jsonSchemaToZod", () => {
    // Access private method for testing
    const convertSchema = (bridge: PluginToolsBridge, schema: Record<string, unknown>) => {
      return (
        bridge as unknown as { jsonSchemaToZod: (s: Record<string, unknown>) => z.ZodType }
      ).jsonSchemaToZod(schema)
    }

    it("should convert string type", () => {
      const schema = { type: "string" }
      const zodSchema = convertSchema(bridge, schema)

      expect(zodSchema.safeParse("test").success).toBe(true)
      expect(zodSchema.safeParse(123).success).toBe(false)
    })

    it("should convert string with enum", () => {
      const schema = { type: "string", enum: ["a", "b", "c"] }
      const zodSchema = convertSchema(bridge, schema)

      expect(zodSchema.safeParse("a").success).toBe(true)
      expect(zodSchema.safeParse("d").success).toBe(false)
    })

    it("should convert string with constraints", () => {
      const schema = { type: "string", minLength: 2, maxLength: 5 }
      const zodSchema = convertSchema(bridge, schema)

      expect(zodSchema.safeParse("ab").success).toBe(true)
      expect(zodSchema.safeParse("a").success).toBe(false)
      expect(zodSchema.safeParse("abcdef").success).toBe(false)
    })

    it("should convert number type", () => {
      const schema = { type: "number" }
      const zodSchema = convertSchema(bridge, schema)

      expect(zodSchema.safeParse(42).success).toBe(true)
      expect(zodSchema.safeParse(3.14).success).toBe(true)
      expect(zodSchema.safeParse("42").success).toBe(false)
    })

    it("should convert integer type", () => {
      const schema = { type: "integer" }
      const zodSchema = convertSchema(bridge, schema)

      expect(zodSchema.safeParse(42).success).toBe(true)
      expect(zodSchema.safeParse(3.14).success).toBe(false)
    })

    it("should convert number with constraints", () => {
      const schema = { type: "number", minimum: 0, maximum: 100 }
      const zodSchema = convertSchema(bridge, schema)

      expect(zodSchema.safeParse(50).success).toBe(true)
      expect(zodSchema.safeParse(-1).success).toBe(false)
      expect(zodSchema.safeParse(101).success).toBe(false)
    })

    it("should convert boolean type", () => {
      const schema = { type: "boolean" }
      const zodSchema = convertSchema(bridge, schema)

      expect(zodSchema.safeParse(true).success).toBe(true)
      expect(zodSchema.safeParse(false).success).toBe(true)
      expect(zodSchema.safeParse("true").success).toBe(false)
    })

    it("should convert null type", () => {
      const schema = { type: "null" }
      const zodSchema = convertSchema(bridge, schema)

      expect(zodSchema.safeParse(null).success).toBe(true)
      expect(zodSchema.safeParse(undefined).success).toBe(false)
    })

    it("should convert array type", () => {
      const schema = { type: "array", items: { type: "string" } }
      const zodSchema = convertSchema(bridge, schema)

      expect(zodSchema.safeParse(["a", "b"]).success).toBe(true)
      expect(zodSchema.safeParse([1, 2]).success).toBe(false)
    })

    it("should convert object type", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
      }
      const zodSchema = convertSchema(bridge, schema)

      expect(zodSchema.safeParse({ name: "John" }).success).toBe(true)
      expect(zodSchema.safeParse({ name: "John", age: 30 }).success).toBe(true)
      expect(zodSchema.safeParse({ age: 30 }).success).toBe(false)
    })

    it("should handle unknown type", () => {
      const schema = { type: "unknown" }
      const zodSchema = convertSchema(bridge, schema)

      expect(zodSchema.safeParse("anything").success).toBe(true)
      expect(zodSchema.safeParse(123).success).toBe(true)
    })
  })

  describe("getToolStats", () => {
    it("should return zero stats for unknown tool", () => {
      const stats = bridge.getToolStats("unknown")

      expect(stats).toEqual({
        totalExecutions: 0,
        successRate: 0,
        averageDuration: 0,
      })
    })

    it("should calculate correct statistics", async () => {
      const tool = createMockTool("stats_tool")
      tool.execute = jest
        .fn()
        .mockResolvedValueOnce("success")
        .mockResolvedValueOnce("success")
        .mockRejectedValueOnce(new Error("fail"))

      const agentTool = bridge.convertToAgentTool(tool)

      await agentTool.execute({})
      await agentTool.execute({})
      await agentTool.execute({}).catch(() => {})

      const stats = bridge.getToolStats("stats_tool")

      expect(stats.totalExecutions).toBe(3)
      expect(stats.successRate).toBeCloseTo(2 / 3)
      expect(stats.averageDuration).toBeGreaterThanOrEqual(0)
    })
  })

  describe("getRegisteredToolNames", () => {
    it("should return all tool names", () => {
      const tools = [createMockTool("tool_a"), createMockTool("tool_b")]
      mockRegistry.getAllTools.mockReturnValue(tools)

      const names = bridge.getRegisteredToolNames()

      expect(names).toEqual(["tool_a", "tool_b"])
    })
  })

  describe("getTool", () => {
    it("should return tool from registry", () => {
      const tool = createMockTool()
      mockRegistry.getTool.mockReturnValue(tool)

      expect(bridge.getTool("test_tool")).toBe(tool)
    })

    it("should return undefined for unknown tool", () => {
      mockRegistry.getTool.mockReturnValue(undefined)

      expect(bridge.getTool("unknown")).toBeUndefined()
    })
  })

  describe("toolRequiresApproval", () => {
    it("should return true when tool requires approval", () => {
      const tool = createMockTool()
      tool.definition.requiresApproval = true
      mockRegistry.getTool.mockReturnValue(tool)

      expect(bridge.toolRequiresApproval("test_tool")).toBe(true)
    })

    it("should return false when tool does not require approval", () => {
      const tool = createMockTool()
      tool.definition.requiresApproval = false
      mockRegistry.getTool.mockReturnValue(tool)

      expect(bridge.toolRequiresApproval("test_tool")).toBe(false)
    })

    it("should return false for unknown tool", () => {
      mockRegistry.getTool.mockReturnValue(undefined)

      expect(bridge.toolRequiresApproval("unknown")).toBe(false)
    })
  })

  describe("clearExecutionHistory", () => {
    it("should clear all execution history", async () => {
      const tool = createMockTool()
      const agentTool = bridge.convertToAgentTool(tool)
      await agentTool.execute({})

      expect(bridge.getToolStats("test_tool").totalExecutions).toBe(1)

      bridge.clearExecutionHistory()

      expect(bridge.getToolStats("test_tool").totalExecutions).toBe(0)
    })
  })
})

describe("createPluginToolsBridge", () => {
  it("should create a new PluginToolsBridge instance", () => {
    const mockRegistry = createMockRegistry()
    mockedUsePluginStore.getState.mockReturnValue({ plugins: {} } as never)

    const bridge = createPluginToolsBridge({ registry: mockRegistry })

    expect(bridge).toBeInstanceOf(PluginToolsBridge)
  })
})
