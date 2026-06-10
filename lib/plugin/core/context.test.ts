/**
 * Plugin Context Tests
 */

import { createPluginContext, createFullPluginContext, isFullPluginContext } from "./context"
import type { Plugin, PluginManifest } from "@/types/plugin"
import type { PluginManager } from "./manager"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/native/utils"
import { executeAgent } from "@/lib/ai/agent/agent-executor"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { createAgentFromPreset } from "@/lib/ai/agent/external/presets"
import { invokePluginTool } from "@/lib/plugin/core/invoke-plugin-tool"
import { usePluginModalStore } from "@/stores/plugin-runtime/plugin-modal-store"
import {
  initializePluginPermissions,
  revokePluginPermissions,
} from "@/lib/plugin/api/permission-api"
import {
  getBackgroundAgentManager,
  __resetBackgroundAgentManagerForTesting,
} from "@/lib/ai/agent/background-agent-manager"

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

// Sonner toast — `ui.showToast` routes here.
jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), {
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  }),
}))

jest.mock("../contracts/diagnostics-store", () => ({
  recordSilentFailure: jest.fn(),
  recordPluginPointDiagnostic: jest.fn(),
  getPluginPointDiagnostics: jest.fn(() => []),
  getAllPluginPointDiagnostics: jest.fn(() => ({})),
  clearPluginPointDiagnostics: jest.fn(),
  clearAllPluginPointDiagnostics: jest.fn(),
  subscribePluginPointDiagnostics: jest.fn(() => () => {}),
  getPluginPointDiagnosticsRevision: jest.fn(() => 0),
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
jest.mock("@/stores/plugin-runtime", () => ({
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

// Mock the imperative agent-execution entry points (dynamically imported by
// `createAgentAPI`). The background-agent-manager + permission-api stay REAL
// so cancellation registration and permission gating are exercised end-to-end.
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: jest.fn(async () => ({
    text: "agent reply",
    channel: "text",
    toolsAvailable: false,
  })),
}))
jest.mock("@/lib/plugin/core/invoke-plugin-tool", () => ({
  invokePluginTool: jest.fn(async (pluginId: string, toolName: string) => ({
    result: { ok: true, toolName },
    pluginId,
    toolName,
  })),
}))
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: jest.fn(),
}))
jest.mock("@/lib/ai/agent/external/presets", () => ({
  registerPreset: jest.fn(),
  createAgentFromPreset: jest.fn(),
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

    it("should route showNotification failures through recordSilentFailure", async () => {
      const { recordSilentFailure } = jest.requireMock("../contracts/diagnostics-store") as {
        recordSilentFailure: jest.Mock
      }
      recordSilentFailure.mockClear()

      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      const invokeMock = invoke as jest.Mock
      invokeMock.mockRejectedValueOnce(new Error("backend missing"))

      await context.ui.showNotification({ title: "x" })

      expect(recordSilentFailure).toHaveBeenCalledWith(
        plugin.manifest.id,
        expect.objectContaining({
          site: "ui.showNotification",
          message: "Failed to show notification",
        }),
        expect.any(Error)
      )
    })

    it("routes showToast to the matching sonner variant", () => {
      const { toast } = jest.requireMock("sonner") as {
        toast: { success: jest.Mock; error: jest.Mock; warning: jest.Mock; info: jest.Mock }
      }
      const context = createPluginContext(createMockPlugin(), mockManager)

      context.ui.showToast("done", "success")
      context.ui.showToast("boom", "error")
      context.ui.showToast("careful", "warning")
      context.ui.showToast("fyi")

      expect(toast.success).toHaveBeenCalledWith("done")
      expect(toast.error).toHaveBeenCalledWith("boom")
      expect(toast.warning).toHaveBeenCalledWith("careful")
      expect(toast.info).toHaveBeenCalledWith("fyi")
    })

    it("showConfirmDialog pushes a modal entry and resolves when settled", async () => {
      usePluginModalStore.getState().closeAll()

      const context = createPluginContext(createMockPlugin(), mockManager)
      const pending = context.ui.showConfirmDialog({ title: "t", message: "m" })

      const entries = usePluginModalStore.getState().stack
      expect(entries).toHaveLength(1)
      const settle = (entries[0].args as { settle: (v: boolean) => void }).settle
      settle(true)

      await expect(pending).resolves.toBe(true)
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
    beforeEach(() => {
      localStorage.clear()
    })

    it("should have get / set / onChange methods", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      expect(typeof context.settings.get).toBe("function")
      expect(typeof context.settings.set).toBe("function")
      expect(typeof context.settings.onChange).toBe("function")
    })

    it("round-trips a set value through get", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      context.settings.set("theme", "dark")
      expect(context.settings.get<string>("theme")).toBe("dark")
    })

    it("persists across a fresh context instance (reload simulation)", () => {
      const first = createPluginContext(createMockPlugin(), mockManager)
      first.settings.set("count", 7)
      // A new context (e.g. after reload) must read the persisted value.
      const second = createPluginContext(createMockPlugin(), mockManager)
      expect(second.settings.get<number>("count")).toBe(7)
    })

    it("returns undefined for an unknown key", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      expect(context.settings.get("missing")).toBeUndefined()
    })

    it("fires onChange listeners on a real write", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      const handler = jest.fn()
      context.settings.onChange("lang", handler)
      context.settings.set("lang", "zh-CN")
      expect(handler).toHaveBeenCalledWith("zh-CN")
    })

    it("stops firing after the onChange disposer runs", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      const handler = jest.fn()
      const dispose = context.settings.onChange("lang", handler)
      dispose()
      context.settings.set("lang", "en")
      expect(handler).not.toHaveBeenCalled()
    })

    it("isolates settings between two plugin ids", () => {
      const a = createPluginContext(createMockPlugin(), mockManager)
      const bPlugin = createMockPlugin({
        manifest: { ...mockManifest, id: "other-plugin" },
      })
      const b = createPluginContext(bPlugin, mockManager)
      a.settings.set("shared", "from-a")
      expect(b.settings.get("shared")).toBeUndefined()
    })

    it("tolerates corrupt persisted JSON (get returns undefined)", () => {
      localStorage.setItem("cognia-plugin-settings:test-plugin", "{not json")
      const context = createPluginContext(createMockPlugin(), mockManager)
      expect(context.settings.get("anything")).toBeUndefined()
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

    it("routes python.import failures through recordSilentFailure (ADR 0016 T1)", async () => {
      const { recordSilentFailure } = jest.requireMock("../contracts/diagnostics-store") as {
        recordSilentFailure: jest.Mock
      }
      recordSilentFailure.mockClear()

      const hybridManifest = { ...mockManifest, type: "hybrid" as const }
      const plugin = createMockPlugin({ manifest: hybridManifest })
      const context = createPluginContext(plugin, mockManager)
      const invokeMock = invoke as jest.Mock
      invokeMock.mockRejectedValueOnce(new Error("python runtime missing"))

      await expect(context.python!.import("os")).rejects.toThrow("python runtime missing")

      expect(recordSilentFailure).toHaveBeenCalledWith(
        plugin.manifest.id,
        expect.objectContaining({
          site: "python.import",
          message: expect.stringContaining("os"),
        }),
        expect.any(Error)
      )
      // expected flag should be !isTauri() because the Python handler is
      // deferred to ADR 0017 — the gate at scripts/check-silent-failure-flags
      // will flip this to false once that handler ships.
      const ctxArg = recordSilentFailure.mock.calls[0][1] as { expected: boolean }
      expect(ctxArg.expected).toBe(true) // isTauri mock returns false
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

describe("agent imperative API", () => {
  const mockExecuteAgent = executeAgent as jest.MockedFunction<typeof executeAgent>
  const mockGetExternalManager = getExternalAgentManager as jest.MockedFunction<
    typeof getExternalAgentManager
  >
  const mockCreateAgentFromPreset = createAgentFromPreset as jest.MockedFunction<
    typeof createAgentFromPreset
  >

  const PLUGIN_ID = "test-plugin"

  beforeEach(() => {
    jest.clearAllMocks()
    revokePluginPermissions(PLUGIN_ID)
    __resetBackgroundAgentManagerForTesting()
    mockExecuteAgent.mockResolvedValue({
      text: "agent reply",
      channel: "text",
      toolsAvailable: false,
    })
  })

  describe("executeAgent", () => {
    it("returns the run result with a generated agentId", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = (await ctx.agent.executeAgent({ prompt: "hi" })) as {
        text: string
        agentId: string
      }
      expect(result.text).toBe("agent reply")
      expect(typeof result.agentId).toBe("string")
      expect(result.agentId.length).toBeGreaterThan(0)
      // The caller signal is threaded through to the executor.
      expect(mockExecuteAgent).toHaveBeenCalledWith(
        "hi",
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
      )
    })

    it("uses a caller-supplied agentId and de-registers it after completion", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = (await ctx.agent.executeAgent({ prompt: "hi", agentId: "run-1" })) as {
        agentId: string
      }
      expect(result.agentId).toBe("run-1")
      // finishAgent dropped the entry → nothing left to cancel.
      expect(getBackgroundAgentManager().cancelAgent("run-1")).toBe(false)
    })

    it("throws on empty prompt", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.executeAgent({})).rejects.toThrow(/requires config.prompt/)
    })

    it("rejects tool-enabled runs without the agent:control permission", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.executeAgent({ prompt: "hi", toolsEnabled: true })).rejects.toThrow(
        /agent:control/
      )
      expect(mockExecuteAgent).not.toHaveBeenCalled()
    })

    it("allows tool-enabled runs once agent:control is granted", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      mockExecuteAgent.mockResolvedValue({
        text: "tool reply",
        channel: "sidecar",
        toolsAvailable: true,
      })
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = (await ctx.agent.executeAgent({ prompt: "go", toolsEnabled: true })) as {
        channel: string
      }
      expect(result.channel).toBe("sidecar")
      expect(mockExecuteAgent).toHaveBeenCalledWith(
        "go",
        expect.objectContaining({ toolsEnabled: true })
      )
    })

    it("maps legacy systemPrompt/defaultProvider onto the typed run options", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await ctx.agent.executeAgent({ prompt: "hi", systemPrompt: "S", defaultProvider: "openai" })
      expect(mockExecuteAgent).toHaveBeenCalledWith(
        "hi",
        expect.objectContaining({ systemPrompt: "S", defaultProvider: "openai" })
      )
    })
  })

  describe("run / runStreamed", () => {
    it("run() returns a typed result with an agentId", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = await ctx.agent.run("hi")
      expect(result.text).toBe("agent reply")
      expect(typeof result.agentId).toBe("string")
    })

    it("run() rejects tool-enabled runs without agent:control", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.run("hi", { toolsEnabled: true })).rejects.toThrow(/agent:control/)
      expect(mockExecuteAgent).not.toHaveBeenCalled()
    })

    it("runStreamed() yields events and resolves the result", async () => {
      mockExecuteAgent.mockImplementation(async (_p, cfg) => {
        cfg?.onEvent?.({ type: "text-delta", delta: "hi" })
        return { text: "hi", channel: "text", toolsAvailable: false }
      })
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const run = ctx.agent.runStreamed("go")
      const types: string[] = []
      for await (const ev of run) types.push(ev.type)
      expect(types).toEqual(["text-delta", "result"])
      await expect(run.result).resolves.toMatchObject({ text: "hi" })
    })

    it("runStreamed() throws synchronously when tool-enabled lacks agent:control", () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      expect(() => ctx.agent.runStreamed("go", { toolsEnabled: true })).toThrow(/agent:control/)
    })
  })

  describe("invokeTool", () => {
    const mockInvokePluginTool = invokePluginTool as jest.MockedFunction<typeof invokePluginTool>

    it("rejects without the agent:control permission", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.invokeTool("web_fetch", { url: "x" })).rejects.toThrow(/agent:control/)
      expect(mockInvokePluginTool).not.toHaveBeenCalled()
    })

    it("routes to invokePluginTool and unwraps the result once granted", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = await ctx.agent.invokeTool("web_fetch", { url: "x" })
      expect(mockInvokePluginTool).toHaveBeenCalledWith(
        PLUGIN_ID,
        "web_fetch",
        { url: "x" },
        expect.objectContaining({ reason: expect.stringContaining("web_fetch") })
      )
      expect(result).toEqual({ ok: true, toolName: "web_fetch" })
    })

    it("rejects an empty tool name", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.invokeTool("", {})).rejects.toThrow(/tool name/)
    })
  })

  describe("runExternalAgent", () => {
    it("rejects without the agent:dispatch-external permission", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.runExternalAgent("codex", "do it")).rejects.toThrow(
        /agent:dispatch-external/
      )
    })

    it("adds an instance from a preset then executes it", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:dispatch-external"])
      const execute = jest.fn(async () => ({ output: "done" }))
      const addAgent = jest.fn(async () => ({ config: { id: "ext-1" } }))
      mockGetExternalManager.mockReturnValue({
        getAgent: jest.fn(() => undefined),
        addAgent,
        execute,
      } as unknown as ReturnType<typeof getExternalAgentManager>)
      mockCreateAgentFromPreset.mockReturnValue({ id: "ext-1", name: "Codex" } as never)

      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = await ctx.agent.runExternalAgent("codex", "do it")

      expect(mockCreateAgentFromPreset).toHaveBeenCalledWith("codex")
      expect(addAgent).toHaveBeenCalled()
      expect(execute).toHaveBeenCalledWith("ext-1", "do it", undefined)
      expect(result).toEqual({ output: "done" })
    })

    it("executes directly against a live instance id without re-adding", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:dispatch-external"])
      const execute = jest.fn(async () => ({ output: "live" }))
      const addAgent = jest.fn()
      mockGetExternalManager.mockReturnValue({
        getAgent: jest.fn(() => ({ config: { id: "live-1" } })),
        addAgent,
        execute,
      } as unknown as ReturnType<typeof getExternalAgentManager>)

      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await ctx.agent.runExternalAgent("live-1", "ping")

      expect(addAgent).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledWith("live-1", "ping", undefined)
    })

    it("throws when neither a live agent nor a preset matches", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:dispatch-external"])
      mockGetExternalManager.mockReturnValue({
        getAgent: jest.fn(() => undefined),
        addAgent: jest.fn(),
        execute: jest.fn(),
      } as unknown as ReturnType<typeof getExternalAgentManager>)
      mockCreateAgentFromPreset.mockReturnValue(null)

      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.runExternalAgent("unknown", "x")).rejects.toThrow(
        /no live agent or preset/
      )
    })
  })
})
