/**
 * Comprehensive Tests for Canvas Plugin Manager
 */

import {
  CanvasPluginManager,
  pluginManager,
  type CanvasPlugin,
  type PluginContext,
  type CompletionContext,
} from "./plugin-manager"

describe("CanvasPluginManager", () => {
  let manager: CanvasPluginManager
  let _consoleErrorSpy: jest.SpyInstance

  beforeAll(() => {
    _consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
  })

  afterAll(() => {
    _consoleErrorSpy.mockRestore()
  })

  const createMockPlugin = (id: string, enabled = true): CanvasPlugin => ({
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    description: `Test plugin ${id}`,
    enabled,
  })

  const createMockContext = (): PluginContext => ({
    documentId: "doc1",
    language: "javascript",
    getContent: () => "test content",
    setContent: jest.fn(),
    getSelection: () => "selected text",
    insertText: jest.fn(),
    replaceSelection: jest.fn(),
    showNotification: jest.fn(),
    registerCommand: jest.fn(),
  })

  beforeEach(() => {
    manager = new CanvasPluginManager()
  })

  describe("registerPlugin", () => {
    it("should register a new plugin", () => {
      const plugin = createMockPlugin("test-plugin")
      const result = manager.registerPlugin(plugin)

      expect(result).toBe(true)
      expect(manager.getPlugin("test-plugin")).toBeDefined()
    })

    it("should not register duplicate plugin", () => {
      const plugin = createMockPlugin("test-plugin")
      manager.registerPlugin(plugin)
      const result = manager.registerPlugin(plugin)

      expect(result).toBe(false)
    })

    it("should enable plugin if enabled is true", () => {
      const plugin = createMockPlugin("enabled-plugin", true)
      manager.registerPlugin(plugin)

      const enabledPlugins = manager.getEnabledPlugins()
      expect(enabledPlugins.some((p) => p.id === "enabled-plugin")).toBe(true)
    })

    it("should not enable plugin if enabled is false", () => {
      const plugin = createMockPlugin("disabled-plugin", false)
      manager.registerPlugin(plugin)

      const enabledPlugins = manager.getEnabledPlugins()
      expect(enabledPlugins.some((p) => p.id === "disabled-plugin")).toBe(false)
    })
  })

  describe("unregisterPlugin", () => {
    it("should unregister an existing plugin", () => {
      const plugin = createMockPlugin("to-remove")
      manager.registerPlugin(plugin)

      const result = manager.unregisterPlugin("to-remove")

      expect(result).toBe(true)
      expect(manager.getPlugin("to-remove")).toBeUndefined()
    })

    it("should return false for non-existent plugin", () => {
      const result = manager.unregisterPlugin("non-existent")
      expect(result).toBe(false)
    })

    it("should disable plugin before unregistering", () => {
      const onUnmount = jest.fn()
      const plugin: CanvasPlugin = {
        ...createMockPlugin("unmount-test"),
        onUnmount,
      }

      manager.registerPlugin(plugin)
      manager.setContext(createMockContext())
      manager.unregisterPlugin("unmount-test")

      expect(onUnmount).toHaveBeenCalled()
    })
  })

  describe("enablePlugin", () => {
    it("should enable a registered plugin", () => {
      const plugin = createMockPlugin("to-enable", false)
      manager.registerPlugin(plugin)

      const result = manager.enablePlugin("to-enable")

      expect(result).toBe(true)
      expect(manager.getEnabledPlugins().some((p) => p.id === "to-enable")).toBe(true)
    })

    it("should return false for non-existent plugin", () => {
      const result = manager.enablePlugin("non-existent")
      expect(result).toBe(false)
    })

    it("should call onMount when context is set", () => {
      const onMount = jest.fn()
      const plugin: CanvasPlugin = {
        ...createMockPlugin("mount-test", false),
        onMount,
      }

      manager.registerPlugin(plugin)
      manager.setContext(createMockContext())
      manager.enablePlugin("mount-test")

      expect(onMount).toHaveBeenCalled()
    })
  })

  describe("disablePlugin", () => {
    it("should disable an enabled plugin", () => {
      const plugin = createMockPlugin("to-disable", true)
      manager.registerPlugin(plugin)

      const result = manager.disablePlugin("to-disable")

      expect(result).toBe(true)
      expect(manager.getEnabledPlugins().some((p) => p.id === "to-disable")).toBe(false)
    })

    it("should return false for non-existent plugin", () => {
      const result = manager.disablePlugin("non-existent")
      expect(result).toBe(false)
    })

    it("should call onUnmount", () => {
      const onUnmount = jest.fn()
      const plugin: CanvasPlugin = {
        ...createMockPlugin("unmount-test"),
        onUnmount,
      }

      manager.registerPlugin(plugin)
      manager.disablePlugin("unmount-test")

      expect(onUnmount).toHaveBeenCalled()
    })
  })

  describe("getPlugin", () => {
    it("should return plugin by ID", () => {
      const plugin = createMockPlugin("get-test")
      manager.registerPlugin(plugin)

      const retrieved = manager.getPlugin("get-test")

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe("get-test")
    })

    it("should return undefined for non-existent plugin", () => {
      const result = manager.getPlugin("non-existent")
      expect(result).toBeUndefined()
    })
  })

  describe("getAllPlugins", () => {
    it("should return all registered plugins", () => {
      manager.registerPlugin(createMockPlugin("plugin1"))
      manager.registerPlugin(createMockPlugin("plugin2"))
      manager.registerPlugin(createMockPlugin("plugin3"))

      const plugins = manager.getAllPlugins()

      expect(plugins.length).toBe(3)
    })

    it("should return empty array when no plugins", () => {
      const plugins = manager.getAllPlugins()
      expect(plugins).toEqual([])
    })
  })

  describe("getEnabledPlugins", () => {
    it("should return only enabled plugins", () => {
      manager.registerPlugin(createMockPlugin("enabled1", true))
      manager.registerPlugin(createMockPlugin("enabled2", true))
      manager.registerPlugin(createMockPlugin("disabled1", false))

      const enabled = manager.getEnabledPlugins()

      expect(enabled.length).toBe(2)
      expect(enabled.every((p) => p.enabled)).toBe(true)
    })
  })

  describe("setContext", () => {
    it("should set plugin context", () => {
      const onMount = jest.fn()
      const plugin: CanvasPlugin = {
        ...createMockPlugin("context-test"),
        onMount,
      }

      manager.registerPlugin(plugin)
      manager.setContext(createMockContext())

      expect(onMount).toHaveBeenCalled()
    })

    it("should call onMount for all enabled plugins", () => {
      const onMount1 = jest.fn()
      const onMount2 = jest.fn()

      manager.registerPlugin({ ...createMockPlugin("p1"), onMount: onMount1 })
      manager.registerPlugin({ ...createMockPlugin("p2"), onMount: onMount2 })
      manager.setContext(createMockContext())

      expect(onMount1).toHaveBeenCalled()
      expect(onMount2).toHaveBeenCalled()
    })
  })

  describe("clearContext", () => {
    it("should call onUnmount for all enabled plugins", () => {
      const onUnmount1 = jest.fn()
      const onUnmount2 = jest.fn()

      manager.registerPlugin({ ...createMockPlugin("p1"), onUnmount: onUnmount1 })
      manager.registerPlugin({ ...createMockPlugin("p2"), onUnmount: onUnmount2 })
      manager.setContext(createMockContext())
      manager.clearContext()

      expect(onUnmount1).toHaveBeenCalled()
      expect(onUnmount2).toHaveBeenCalled()
    })

    it("should clear commands", () => {
      manager.setContext(createMockContext())
      manager.clearContext()

      const commands = manager.getCommands()
      expect(commands).toEqual([])
    })
  })

  describe("executeHook", () => {
    it("should execute hook on all enabled plugins", () => {
      const onContentChange1 = jest.fn()
      const onContentChange2 = jest.fn()

      manager.registerPlugin({ ...createMockPlugin("p1"), onContentChange: onContentChange1 })
      manager.registerPlugin({ ...createMockPlugin("p2"), onContentChange: onContentChange2 })

      manager.executeHook("onContentChange", "new content", "javascript")

      expect(onContentChange1).toHaveBeenCalledWith("new content", "javascript")
      expect(onContentChange2).toHaveBeenCalledWith("new content", "javascript")
    })

    it("should not execute hook on disabled plugins", () => {
      const onContentChange = jest.fn()

      manager.registerPlugin({
        ...createMockPlugin("disabled", false),
        onContentChange,
      })

      manager.executeHook("onContentChange", "content", "javascript")

      expect(onContentChange).not.toHaveBeenCalled()
    })

    it("should handle errors gracefully", () => {
      const errorPlugin: CanvasPlugin = {
        ...createMockPlugin("error-plugin"),
        onContentChange: () => {
          throw new Error("Test error")
        },
      }

      manager.registerPlugin(errorPlugin)

      expect(() => manager.executeHook("onContentChange", "content", "js")).not.toThrow()
    })
  })

  describe("collectCompletions", () => {
    it("should collect completions from all plugins", async () => {
      const plugin1: CanvasPlugin = {
        ...createMockPlugin("p1"),
        provideCompletionItems: async () => [
          { label: "item1", kind: "function", insertText: "item1()" },
        ],
      }
      const plugin2: CanvasPlugin = {
        ...createMockPlugin("p2"),
        provideCompletionItems: async () => [
          { label: "item2", kind: "variable", insertText: "item2" },
        ],
      }

      manager.registerPlugin(plugin1)
      manager.registerPlugin(plugin2)

      const context: CompletionContext = {
        word: "test",
        position: { line: 1, column: 5 },
        lineContent: "const test",
        language: "javascript",
      }

      const items = await manager.collectCompletions(context)

      expect(items.length).toBe(2)
      expect(items.some((i) => i.label === "item1")).toBe(true)
      expect(items.some((i) => i.label === "item2")).toBe(true)
    })

    it("should handle plugin errors gracefully", async () => {
      const errorPlugin: CanvasPlugin = {
        ...createMockPlugin("error-plugin"),
        provideCompletionItems: async () => {
          throw new Error("Test error")
        },
      }

      manager.registerPlugin(errorPlugin)

      const context: CompletionContext = {
        word: "test",
        position: { line: 1, column: 1 },
        lineContent: "test",
        language: "javascript",
      }

      await expect(manager.collectCompletions(context)).resolves.toEqual([])
    })
  })

  describe("collectDiagnostics", () => {
    it("should collect diagnostics from all plugins", async () => {
      const plugin: CanvasPlugin = {
        ...createMockPlugin("diag-plugin"),
        provideDiagnostics: async () => [
          {
            message: "Test error",
            severity: "error",
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 },
          },
        ],
      }

      manager.registerPlugin(plugin)

      const diagnostics = await manager.collectDiagnostics("code", "javascript")

      expect(diagnostics.length).toBe(1)
      expect(diagnostics[0].message).toBe("Test error")
    })

    it("should handle plugin errors gracefully", async () => {
      const errorPlugin: CanvasPlugin = {
        ...createMockPlugin("error-plugin"),
        provideDiagnostics: async () => {
          throw new Error("Test error")
        },
      }

      manager.registerPlugin(errorPlugin)

      await expect(manager.collectDiagnostics("code", "js")).resolves.toEqual([])
    })
  })

  describe("collectActions", () => {
    it("should collect actions from all plugins", () => {
      const plugin: CanvasPlugin = {
        ...createMockPlugin("action-plugin"),
        provideActions: () => [
          {
            id: "action1",
            label: "Test Action",
            handler: async () => "result",
          },
        ],
      }

      manager.registerPlugin(plugin)

      const actions = manager.collectActions("code", "selection")

      expect(actions.length).toBe(1)
      expect(actions[0].label).toBe("Test Action")
    })

    it("should handle plugin errors gracefully", () => {
      const errorPlugin: CanvasPlugin = {
        ...createMockPlugin("error-plugin"),
        provideActions: () => {
          throw new Error("Test error")
        },
      }

      manager.registerPlugin(errorPlugin)

      expect(() => manager.collectActions("code", "selection")).not.toThrow()
      expect(manager.collectActions("code", "selection")).toEqual([])
    })
  })

  describe("getCommands", () => {
    it("should return registered commands", () => {
      const context = createMockContext()
      const registerCommand: (cmd: {
        id: string
        label: string
        handler: () => void
      }) => void = () => {}

      context.registerCommand = (cmd) => {
        registerCommand(cmd)
      }

      const plugin: CanvasPlugin = {
        ...createMockPlugin("cmd-plugin"),
        onMount: (ctx) => {
          ctx.registerCommand({
            id: "test-command",
            label: "Test Command",
            handler: () => {},
          })
        },
      }

      manager.registerPlugin(plugin)
      manager.setContext(context)

      const commands = manager.getCommands()
      expect(commands.some((c) => c.id === "test-command")).toBe(true)
    })
  })

  describe("executeCommand", () => {
    it("should execute a registered command", () => {
      const handler = jest.fn()

      const plugin: CanvasPlugin = {
        ...createMockPlugin("cmd-plugin"),
        onMount: (ctx) => {
          ctx.registerCommand({
            id: "exec-test",
            label: "Exec Test",
            handler,
          })
        },
      }

      manager.registerPlugin(plugin)
      manager.setContext(createMockContext())
      manager.executeCommand("exec-test")

      expect(handler).toHaveBeenCalled()
    })

    it("should not throw for non-existent command", () => {
      expect(() => manager.executeCommand("non-existent")).not.toThrow()
    })
  })

  describe("exportPluginList", () => {
    it("should export plugin list as JSON", () => {
      manager.registerPlugin(createMockPlugin("p1", true))
      manager.registerPlugin(createMockPlugin("p2", false))

      const json = manager.exportPluginList()
      const parsed = JSON.parse(json)

      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBe(2)
      expect(parsed[0].id).toBeDefined()
      expect(parsed[0].name).toBeDefined()
      expect(parsed[0].version).toBeDefined()
      expect(typeof parsed[0].enabled).toBe("boolean")
    })
  })

  describe("singleton instance", () => {
    it("should export a singleton instance", () => {
      expect(pluginManager).toBeInstanceOf(CanvasPluginManager)
    })

    it("should have all methods available", () => {
      expect(typeof pluginManager.registerPlugin).toBe("function")
      expect(typeof pluginManager.unregisterPlugin).toBe("function")
      expect(typeof pluginManager.enablePlugin).toBe("function")
      expect(typeof pluginManager.disablePlugin).toBe("function")
      expect(typeof pluginManager.getPlugin).toBe("function")
      expect(typeof pluginManager.getAllPlugins).toBe("function")
      expect(typeof pluginManager.getEnabledPlugins).toBe("function")
      expect(typeof pluginManager.setContext).toBe("function")
      expect(typeof pluginManager.clearContext).toBe("function")
      expect(typeof pluginManager.executeHook).toBe("function")
      expect(typeof pluginManager.collectCompletions).toBe("function")
      expect(typeof pluginManager.collectDiagnostics).toBe("function")
      expect(typeof pluginManager.collectActions).toBe("function")
      expect(typeof pluginManager.getCommands).toBe("function")
      expect(typeof pluginManager.executeCommand).toBe("function")
      expect(typeof pluginManager.exportPluginList).toBe("function")
    })
  })
})
