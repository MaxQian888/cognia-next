/**
 * Plugin Context Tests
 */

import { createPluginContext, createFullPluginContext, isFullPluginContext } from "./context"
import type { Plugin, PluginManifest } from "@/types/plugin"
import type { PluginManager } from "./manager"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/native/utils"

// Mock Tauri invoke
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn().mockResolvedValue(null),
}))

// Mock the logger so it routes to console for test assertions
jest.mock("./logger", () => ({
  loggers: {
    manager: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  },
  createPluginSystemLogger: jest.fn(() => ({
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
    debug: (...args: unknown[]) => console.debug(...args),
  })),
}))

// Mock rate limiter
jest.mock("@/lib/plugin/security/rate-limiter", () => ({
  getPluginRateLimiter: () => ({
    check: jest.fn(),
    checkLimit: jest.fn().mockReturnValue(true),
  }),
}))

jest.mock("@/lib/native/utils", () => ({
  isTauri: jest.fn(() => false),
}))

// Mock IPC, message-bus, i18n-loader, debugger
jest.mock("../messaging/ipc", () => ({
  createIPCAPI: jest.fn(() => ({})),
}))
jest.mock("../messaging/message-bus", () => ({
  createEventAPI: jest.fn(() => ({})),
}))
jest.mock("../utils/i18n-loader", () => ({
  getPluginI18nLoader: jest.fn(() => ({
    createPluginAPI: jest.fn(() => ({})),
  })),
}))
jest.mock("../devtools/debugger", () => ({
  getPluginDebugger: jest.fn(() => ({
    startSession: jest.fn(),
    createDebugContext: jest.fn(),
  })),
}))

// Mock plugin store
jest.mock("@/stores/plugin", () => ({
  usePluginStore: {
    getState: () => ({
      emitEvent: jest.fn(),
      registerPluginTool: jest.fn(),
      unregisterPluginTool: jest.fn(),
      registerPluginMode: jest.fn(),
      unregisterPluginMode: jest.fn(),
      registerPluginComponent: jest.fn(),
    }),
  },
}))

// Mock a2ui store
jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: {
    getState: () => ({
      createSurface: jest.fn(),
      deleteSurface: jest.fn(),
      updateComponents: jest.fn(),
      updateDataModel: jest.fn(),
      getSurface: jest.fn(),
    }),
  },
}))

// Mock settings store
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({}),
    subscribe: jest.fn(() => () => {}),
  },
}))

const mockManifest: PluginManifest = {
  id: "test-plugin",
  name: "Test Plugin",
  version: "1.0.0",
  description: "A test plugin",
  type: "frontend",
  capabilities: ["tools"],
  author: { name: "Test" },
  main: "index.ts",
  permissions: ["network:fetch"],
}

const createMockPlugin = (overrides?: Partial<Plugin>): Plugin => ({
  manifest: mockManifest,
  status: "enabled",
  source: "local",
  path: "/plugins/test-plugin",
  config: {},
  ...overrides,
})

const mockManager = {
  getPluginPointGovernanceMode: jest.fn(() => "warn"),
} as unknown as PluginManager

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

describe("createPluginContext", () => {
  beforeEach(() => {
    mockIsTauri.mockReturnValue(false)
    Object.defineProperty(global.navigator, "clipboard", {
      configurable: true,
      value: {
        readText: jest.fn().mockResolvedValue("browser clipboard"),
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    })
  })

  it("should create context with plugin ID", () => {
    const plugin = createMockPlugin()
    const context = createPluginContext(plugin, mockManager)

    expect(context.pluginId).toBe("test-plugin")
  })

  it("should create context with plugin path", () => {
    const plugin = createMockPlugin()
    const context = createPluginContext(plugin, mockManager)

    expect(context.pluginPath).toBe("/plugins/test-plugin")
  })

  it("should create context with config", () => {
    const config = { setting1: "value1", setting2: 42 }
    const plugin = createMockPlugin({ config })
    const context = createPluginContext(plugin, mockManager)

    expect(context.config).toEqual(config)
  })

  describe("logger", () => {
    it("should have debug method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.logger.debug).toBe("function")
    })

    it("should have info method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.logger.info).toBe("function")
    })

    it("should have warn method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.logger.warn).toBe("function")
    })

    it("should have error method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.logger.error).toBe("function")
    })

    it("should log with plugin prefix", () => {
      const consoleSpy = jest.spyOn(console, "info").mockImplementation()
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      context.logger.info("Test message")

      expect(consoleSpy).toHaveBeenCalled()

      consoleSpy.mockRestore()
    })
  })

  describe("storage", () => {
    it("should have get method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.storage.get).toBe("function")
    })

    it("should have set method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.storage.set).toBe("function")
    })

    it("should have delete method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.storage.delete).toBe("function")
    })

    it("should have keys method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.storage.keys).toBe("function")
    })

    it("should have clear method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.storage.clear).toBe("function")
    })
  })

  describe("events", () => {
    it("should have on method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.events.on).toBe("function")
    })

    it("should have off method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.events.off).toBe("function")
    })

    it("should have emit method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.events.emit).toBe("function")
    })

    it("should have once method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.events.once).toBe("function")
    })

    it("should return unsubscribe function from on", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      const unsubscribe = context.events.on("test-event", () => {})
      expect(typeof unsubscribe).toBe("function")
    })
  })

  describe("ui", () => {
    it("should have showNotification method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.ui.showNotification).toBe("function")
    })

    it("should have showToast method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.ui.showToast).toBe("function")
    })

    it("should have showDialog method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.ui.showDialog).toBe("function")
    })

    it("should map legacy message notifications onto the native body payload", async () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      const invokeMock = invoke as jest.Mock

      await context.ui.showNotification({
        title: "Reminder",
        message: "Workspace SDK linked",
        type: "success",
      })

      expect(invokeMock).toHaveBeenCalledWith("plugin_show_notification", {
        title: "Reminder",
        body: "Workspace SDK linked",
        icon: undefined,
      })
    })
  })

  describe("a2ui", () => {
    it("should have createSurface method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.a2ui.createSurface).toBe("function")
    })

    it("should have deleteSurface method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.a2ui.deleteSurface).toBe("function")
    })

    it("should have updateComponents method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.a2ui.updateComponents).toBe("function")
    })

    it("should have registerComponent method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.a2ui.registerComponent).toBe("function")
    })
  })

  describe("agent", () => {
    it("should have registerTool method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.agent.registerTool).toBe("function")
    })

    it("should have unregisterTool method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.agent.unregisterTool).toBe("function")
    })

    it("should have registerMode method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.agent.registerMode).toBe("function")
    })

    it("should have unregisterMode method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.agent.unregisterMode).toBe("function")
    })
  })

  describe("settings", () => {
    it("should have get method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.settings.get).toBe("function")
    })

    it("should have set method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.settings.set).toBe("function")
    })

    it("should have onChange method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.settings.onChange).toBe("function")
    })
  })

  describe("python api", () => {
    it("should not have python api for frontend plugins", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(context.python).toBeUndefined()
    })

    it("should have python api for hybrid plugins", () => {
      const hybridManifest = { ...mockManifest, type: "hybrid" as const }
      const plugin = createMockPlugin({ manifest: hybridManifest })
      const context = createPluginContext(plugin, mockManager)
      expect(context.python).toBeDefined()
      expect(typeof context.python?.call).toBe("function")
      expect(typeof context.python?.eval).toBe("function")
    })

    it("should have python api for python plugins", () => {
      const pythonManifest = { ...mockManifest, type: "python" as const }
      const plugin = createMockPlugin({ manifest: pythonManifest })
      const context = createPluginContext(plugin, mockManager)
      expect(context.python).toBeDefined()
    })
  })

  describe("network api", () => {
    it("should have all HTTP methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.network.get).toBe("function")
      expect(typeof context.network.post).toBe("function")
      expect(typeof context.network.put).toBe("function")
      expect(typeof context.network.delete).toBe("function")
      expect(typeof context.network.patch).toBe("function")
      expect(typeof context.network.fetch).toBe("function")
    })

    it("should have download and upload methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.network.download).toBe("function")
      expect(typeof context.network.upload).toBe("function")
    })
  })

  describe("filesystem api", () => {
    it("should have read methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.fs.readText).toBe("function")
      expect(typeof context.fs.readBinary).toBe("function")
      expect(typeof context.fs.readJson).toBe("function")
      expect(typeof context.fs.readDir).toBe("function")
    })

    it("should have write methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.fs.writeText).toBe("function")
      expect(typeof context.fs.writeBinary).toBe("function")
      expect(typeof context.fs.writeJson).toBe("function")
      expect(typeof context.fs.appendText).toBe("function")
    })

    it("should have file operation methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.fs.exists).toBe("function")
      expect(typeof context.fs.mkdir).toBe("function")
      expect(typeof context.fs.remove).toBe("function")
      expect(typeof context.fs.copy).toBe("function")
      expect(typeof context.fs.move).toBe("function")
      expect(typeof context.fs.stat).toBe("function")
      expect(typeof context.fs.watch).toBe("function")
    })

    it("should have directory getters", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.fs.getDataDir).toBe("function")
      expect(typeof context.fs.getCacheDir).toBe("function")
      expect(typeof context.fs.getTempDir).toBe("function")

      expect(context.fs.getDataDir()).toContain("test-plugin")
      expect(context.fs.getCacheDir()).toContain("test-plugin")
    })
  })

  describe("clipboard api", () => {
    it("should have text methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.clipboard.readText).toBe("function")
      expect(typeof context.clipboard.writeText).toBe("function")
      expect(typeof context.clipboard.hasText).toBe("function")
    })

    it("should have image methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.clipboard.readImage).toBe("function")
      expect(typeof context.clipboard.writeImage).toBe("function")
      expect(typeof context.clipboard.hasImage).toBe("function")
    })

    it("should have clear method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.clipboard.clear).toBe("function")
    })
  })

  describe("shell api", () => {
    it("should have execute method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.shell.execute).toBe("function")
    })

    it("should have spawn method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.shell.spawn).toBe("function")
    })

    it("should have open methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.shell.open).toBe("function")
      expect(typeof context.shell.showInFolder).toBe("function")
    })
  })

  describe("database api", () => {
    it("should have query methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.db.query).toBe("function")
      expect(typeof context.db.execute).toBe("function")
    })

    it("should have transaction method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.db.transaction).toBe("function")
    })

    it("should have table methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.db.createTable).toBe("function")
      expect(typeof context.db.dropTable).toBe("function")
      expect(typeof context.db.tableExists).toBe("function")
    })
  })

  describe("shortcuts api", () => {
    it("should have register methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.shortcuts.register).toBe("function")
      expect(typeof context.shortcuts.registerMany).toBe("function")
    })

    it("should have utility methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.shortcuts.isAvailable).toBe("function")
      expect(typeof context.shortcuts.getRegistered).toBe("function")
    })

    it("should track registered shortcuts", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(context.shortcuts.getRegistered()).toEqual([])
      expect(context.shortcuts.isAvailable("Ctrl+S")).toBe(true)
    })
  })

  describe("context menu api", () => {
    it("should have register methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.contextMenu.register).toBe("function")
      expect(typeof context.contextMenu.registerMany).toBe("function")
    })
  })

  describe("window api", () => {
    it("should have create method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.window.create).toBe("function")
    })

    it("should have getter methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.window.getMain).toBe("function")
      expect(typeof context.window.getAll).toBe("function")
    })

    it("should have focus method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.window.focus).toBe("function")
    })

    it("should return main window", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      const mainWindow = context.window.getMain()
      expect(mainWindow.id).toBe("main")
      expect(mainWindow.title).toBe("Cognia")
    })
  })

  describe("secrets api", () => {
    it("should have store and get methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.secrets.store).toBe("function")
      expect(typeof context.secrets.get).toBe("function")
    })

    it("should have delete and has methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.secrets.delete).toBe("function")
      expect(typeof context.secrets.has).toBe("function")
    })
  })

  describe("browser runtime adapters", () => {
    it("uses browser clipboard APIs when tauri is unavailable", async () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      const invokeMock = invoke as jest.Mock

      await expect(context.clipboard.readText()).resolves.toBe("browser clipboard")

      expect(navigator.clipboard.readText).toHaveBeenCalled()
      expect(invokeMock).not.toHaveBeenCalledWith("plugin_api_invoke", expect.anything())
    })

    it("rejects filesystem reads with NOT_SUPPORTED in browser runtime", async () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      await expect(context.fs.readText("/workspace/file.txt")).rejects.toThrow(
        /requires the Cognia desktop app/i
      )
    })
  })
})

describe("createFullPluginContext", () => {
  it("should create context with base APIs", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(context.pluginId).toBe("test-plugin")
    expect(context.logger).toBeDefined()
    expect(context.storage).toBeDefined()
  })

  it("should create context with feature APIs", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(context.session).toBeDefined()
    expect(context.project).toBeDefined()
    expect(context.vector).toBeDefined()
    expect(context.theme).toBeDefined()
    expect(context.export).toBeDefined()
    expect(context.i18n).toBeDefined()
    expect(context.canvas).toBeDefined()
    expect(context.artifact).toBeDefined()
    expect(context.media).toBeDefined()
    expect(context.notifications).toBeDefined()
    expect(context.ai).toBeDefined()
    expect(context.extensions).toBeDefined()
    expect(context.permissions).toBeDefined()
  })

  it("should have session API methods", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(typeof context.session.getCurrentSession).toBe("function")
    expect(typeof context.session.createSession).toBe("function")
    expect(typeof context.session.listSessions).toBe("function")
  })

  it("should have project API methods", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(typeof context.project.getCurrentProject).toBe("function")
    expect(typeof context.project.createProject).toBe("function")
    expect(typeof context.project.listProjects).toBe("function")
  })

  it("should have vector API methods", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(typeof context.vector.search).toBe("function")
    expect(typeof context.vector.addDocuments).toBe("function")
  })

  it("should have notifications API methods", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(typeof context.notifications.create).toBe("function")
    expect(typeof context.notifications.dismiss).toBe("function")
  })

  it("should have permissions API methods", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(typeof context.permissions.hasPermission).toBe("function")
  })
})

describe("isFullPluginContext", () => {
  it("should return true for full context", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(isFullPluginContext(context)).toBe(true)
  })

  it("should return false for base context", () => {
    const plugin = createMockPlugin()
    const context = createPluginContext(plugin, mockManager)

    expect(isFullPluginContext(context)).toBe(false)
  })
})
