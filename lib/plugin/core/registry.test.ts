/**
 * Plugin Registry Tests
 */

import { PluginRegistry } from "./registry"
import type { PluginTool, PluginA2UIComponent, A2UITemplateDef } from "@/types/plugin"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import {
  getPluginPointDiagnostics,
  __resetDiagnosticsStoreForTesting,
} from "@/lib/plugin/contracts/diagnostics-store"

describe("PluginRegistry", () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry()
    __resetDiagnosticsStoreForTesting()
  })

  describe("tool registration", () => {
    const createMockTool = (name: string, pluginId: string): PluginTool => ({
      name,
      pluginId,
      definition: {
        name,
        description: `Test tool ${name}`,
        parametersSchema: { type: "object", properties: {} },
      },
      execute: jest.fn(),
    })

    it("should register a tool", () => {
      const tool = createMockTool("test_tool", "test-plugin")

      registry.registerTool("test-plugin", tool)

      expect(registry.getTool("test_tool")).toBeDefined()
      expect(registry.getTool("test_tool")?.name).toBe("test_tool")
    })

    it("should unregister a tool", () => {
      const tool = createMockTool("test_tool", "test-plugin")

      registry.registerTool("test-plugin", tool)
      registry.unregisterTool("test_tool")

      expect(registry.getTool("test_tool")).toBeUndefined()
    })

    it("should get all tools", () => {
      registry.registerTool("plugin-1", createMockTool("tool1", "plugin-1"))
      registry.registerTool("plugin-2", createMockTool("tool2", "plugin-2"))
      registry.registerTool("plugin-1", createMockTool("tool3", "plugin-1"))

      const allTools = registry.getAllTools()

      expect(allTools).toHaveLength(3)
    })

    it("should get tools by plugin", () => {
      registry.registerTool("plugin-1", createMockTool("tool1", "plugin-1"))
      registry.registerTool("plugin-2", createMockTool("tool2", "plugin-2"))
      registry.registerTool("plugin-1", createMockTool("tool3", "plugin-1"))

      const plugin1Tools = registry.getToolsByPlugin("plugin-1")

      expect(plugin1Tools).toHaveLength(2)
      expect(plugin1Tools.map((t) => t.name)).toContain("tool1")
      expect(plugin1Tools.map((t) => t.name)).toContain("tool3")
    })

    it("keeps the first registrant on a cross-plugin name conflict (first-wins) + reports it", () => {
      const tool1 = createMockTool("test_tool", "plugin-1")
      const tool2 = createMockTool("test_tool", "plugin-2")

      registry.registerTool("plugin-1", tool1)
      registry.registerTool("plugin-2", tool2)

      // plugin-1 registered first → it wins; plugin-2's contribution is rejected.
      expect(registry.getTool("test_tool")?.pluginId).toBe("plugin-1")
      // The rejected plugin gets a conflict diagnostic.
      const diagnostics = getPluginPointDiagnostics("plugin-2")
      expect(diagnostics.some((d) => d.code === "plugin.conflict.rejected")).toBe(true)
    })

    it("lets the same plugin refresh its own tool (hot-reload / snapshot restore)", () => {
      const v1 = createMockTool("test_tool", "plugin-1")
      const v2: PluginTool = {
        ...createMockTool("test_tool", "plugin-1"),
        definition: {
          name: "test_tool",
          description: "v2",
          parametersSchema: { type: "object", properties: {} },
        },
      }

      registry.registerTool("plugin-1", v1)
      registry.registerTool("plugin-1", v2)

      // Same plugin → refresh (not a conflict).
      expect(registry.getTool("test_tool")?.definition.description).toBe("v2")
      expect(getPluginPointDiagnostics("plugin-1")).toEqual([])
    })
  })

  describe("component registration", () => {
    const createMockComponent = (type: string): PluginA2UIComponent => ({
      type,
      pluginId: "test-plugin",
      component: () => null,
      metadata: {
        type,
        name: `Test Component ${type}`,
        description: `A test component of type ${type}`,
      },
    })

    it("should register a component", () => {
      const component = createMockComponent("test-component")

      registry.registerComponent("test-plugin", component)

      expect(registry.getComponent("test-component")).toBeDefined()
    })

    it("should unregister a component", () => {
      const component = createMockComponent("test-component")

      registry.registerComponent("test-plugin", component)
      registry.unregisterComponent("test-component")

      expect(registry.getComponent("test-component")).toBeUndefined()
    })

    it("should get all components", () => {
      registry.registerComponent("plugin-1", createMockComponent("comp1"))
      registry.registerComponent("plugin-2", createMockComponent("comp2"))

      const allComponents = registry.getAllComponents()

      expect(allComponents).toHaveLength(2)
    })

    it("should get components by plugin", () => {
      registry.registerComponent("plugin-1", createMockComponent("comp1"))
      registry.registerComponent("plugin-2", createMockComponent("comp2"))
      registry.registerComponent("plugin-1", createMockComponent("comp3"))

      const plugin1Components = registry.getComponentsByPlugin("plugin-1")

      expect(plugin1Components).toHaveLength(2)
    })
  })

  describe("mode registration", () => {
    const createMockMode = (id: string): AgentModeConfig => ({
      id,
      name: `Test Mode ${id}`,
      description: `A test mode ${id}`,
      icon: "test",
      type: "custom",
      tools: [],
    })

    it("should register a mode", () => {
      const mode = createMockMode("test-mode")

      registry.registerMode("test-plugin", mode)

      expect(registry.getMode("test-mode")).toBeDefined()
    })

    it("should unregister a mode", () => {
      const mode = createMockMode("test-mode")

      registry.registerMode("test-plugin", mode)
      registry.unregisterMode("test-mode")

      expect(registry.getMode("test-mode")).toBeUndefined()
    })

    it("should get all modes", () => {
      registry.registerMode("plugin-1", createMockMode("mode1"))
      registry.registerMode("plugin-2", createMockMode("mode2"))

      const allModes = registry.getAllModes()

      expect(allModes).toHaveLength(2)
    })
  })

  describe("template registration", () => {
    const createMockTemplate = (id: string): A2UITemplateDef => ({
      id,
      name: `Test Template ${id}`,
      description: `A test template ${id}`,
      surfaceType: "panel",
      category: "test",
      components: [],
      dataModel: {},
    })

    it("should register a template", () => {
      const template = createMockTemplate("test-template")

      registry.registerTemplate("test-plugin", template)

      // Template key is pluginId:templateId
      expect(registry.getTemplate("test-plugin:test-template")).toBeDefined()
    })

    it("should unregister a template", () => {
      const template = createMockTemplate("test-template")

      registry.registerTemplate("test-plugin", template)
      registry.unregisterTemplate("test-plugin:test-template")

      expect(registry.getTemplate("test-plugin:test-template")).toBeUndefined()
    })

    it("should get templates by category", () => {
      registry.registerTemplate("plugin-1", { ...createMockTemplate("t1"), category: "cat1" })
      registry.registerTemplate("plugin-2", { ...createMockTemplate("t2"), category: "cat2" })
      registry.registerTemplate("plugin-1", { ...createMockTemplate("t3"), category: "cat1" })

      const cat1Templates = registry.getTemplatesByCategory("cat1")

      expect(cat1Templates).toHaveLength(2)
    })
  })

  describe("command registration", () => {
    const createMockCommand = (id: string) => ({
      id,
      name: `/${id}`,
      description: `Test command ${id}`,
      execute: jest.fn(),
    })

    it("should register a command", () => {
      const command = createMockCommand("test-command")

      registry.registerCommand("test-plugin", command)

      expect(registry.getCommand("test-command")).toBeDefined()
    })

    it("should unregister a command", () => {
      const command = createMockCommand("test-command")

      registry.registerCommand("test-plugin", command)
      registry.unregisterCommand("test-command")

      expect(registry.getCommand("test-command")).toBeUndefined()
    })
  })

  describe("bulk unregistration", () => {
    it("should unregister all items from a plugin", () => {
      // Register items from multiple plugins
      registry.registerTool("plugin-1", {
        name: "tool1",
        pluginId: "plugin-1",
        definition: { name: "tool1", description: "", parametersSchema: {} },
        execute: jest.fn(),
      })
      registry.registerTool("plugin-2", {
        name: "tool2",
        pluginId: "plugin-2",
        definition: { name: "tool2", description: "", parametersSchema: {} },
        execute: jest.fn(),
      })
      registry.registerComponent("plugin-1", {
        type: "comp1",
        pluginId: "plugin-1",
        component: () => null,
        metadata: { type: "comp1", name: "Comp1", description: "" },
      })
      registry.registerMode("plugin-1", {
        id: "mode1",
        name: "Mode1",
        description: "",
        icon: "",
        type: "custom",
        tools: [],
      })

      // Unregister all from plugin-1 using individual functions
      registry.unregisterPluginTools("plugin-1")
      registry.unregisterPluginComponents("plugin-1")
      registry.unregisterPluginModes("plugin-1")

      // Check that plugin-1 items are gone
      expect(registry.getTool("tool1")).toBeUndefined()
      expect(registry.getComponent("comp1")).toBeUndefined()
      expect(registry.getMode("mode1")).toBeUndefined()

      // Check that plugin-2 items remain
      expect(registry.getTool("tool2")).toBeDefined()
    })
  })

  describe("clear", () => {
    it("should clear all registrations", () => {
      registry.registerTool("plugin-1", {
        name: "tool1",
        pluginId: "plugin-1",
        definition: { name: "tool1", description: "", parametersSchema: {} },
        execute: jest.fn(),
      })
      registry.registerComponent("plugin-1", {
        type: "comp1",
        pluginId: "plugin-1",
        component: () => null,
        metadata: { type: "comp1", name: "Comp1", description: "" },
      })

      registry.clear()

      expect(registry.getAllTools()).toHaveLength(0)
      expect(registry.getAllComponents()).toHaveLength(0)
      expect(registry.getAllModes()).toHaveLength(0)
      expect(registry.getAllTemplates()).toHaveLength(0)
      expect(registry.getAllCommands()).toHaveLength(0)
    })
  })
})
