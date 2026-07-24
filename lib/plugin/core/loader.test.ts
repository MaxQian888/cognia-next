/** @jest-environment jsdom */
/**
 * Tests for loader.ts
 * Plugin Loader
 */

import { PluginLoader } from "./loader"
import type { Plugin, PluginManifest, PluginDefinition } from "@/types/plugin"

jest.mock("./wasm-loader", () => ({
  __esModule: true,
  loadWasmDefinition: jest.fn(),
  unloadWasmPlugin: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("./vscode-loader", () => ({
  __esModule: true,
  loadVscodeDefinition: jest.fn(),
  unloadVscodeExtension: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("../launcher/launchPluginJs", () => {
  const actual = jest.requireActual("../launcher/launchPluginJs")
  return {
    __esModule: true,
    ...actual,
    launchPluginJs: jest.fn(),
  }
})
jest.mock("../contracts/diagnostics-store", () => ({
  recordSilentFailure: jest.fn(),
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wasmLoader = require("./wasm-loader") as {
  loadWasmDefinition: jest.Mock
  unloadWasmPlugin: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscodeLoader = require("./vscode-loader") as {
  loadVscodeDefinition: jest.Mock
  unloadVscodeExtension: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const diagModule = require("../contracts/diagnostics-store") as {
  recordSilentFailure: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const launcherModule = require("../launcher/launchPluginJs") as {
  launchPluginJs: jest.Mock
}

// Mock document for script loading tests
const mockCreateElement = jest.fn()
const mockAppendChild = jest.fn()

// Store original document and fetch
const originalDocument = global.document
const originalFetch = global.fetch

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - mocking document for testing
  global.document = {
    createElement: mockCreateElement,
    head: {
      appendChild: mockAppendChild,
    } as unknown as HTMLHeadElement,
  }
  // Mock fetch to reject immediately so loader falls through to script tag strategy
  global.fetch = jest.fn().mockRejectedValue(new Error("fetch not available in test"))
})

afterAll(() => {
  global.document = originalDocument
  global.fetch = originalFetch
})

describe("PluginLoader", () => {
  let loader: PluginLoader

  beforeEach(() => {
    loader = new PluginLoader()
    jest.clearAllMocks()
    launcherModule.launchPluginJs.mockResolvedValue({
      command: "/opt/node24/bin/node",
      argv: ["--permission", "/plugins/node-plugin/index.js"],
      process: {
        killed: false,
        kill: jest.fn(),
        isRunning: jest.fn().mockResolvedValue(true),
      },
      activation: { calls: [], hooks: {}, exports: {} },
      invokeCallback: jest.fn(),
      deactivate: jest.fn(),
    })
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    loader.clear()
  })

  const createMockManifest = (
    id: string,
    type: "frontend" | "python" | "hybrid" = "frontend"
  ): PluginManifest => ({
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    type,
    main: type !== "python" ? "index.js" : undefined,
    pythonMain: type !== "frontend" ? "main.py" : undefined,
    permissions: [],
    // cognia field removed
    description: "Mock plugin description",
    capabilities: [],
  })

  const createMockPlugin = (
    id: string,
    type: "frontend" | "python" | "hybrid" = "frontend"
  ): Plugin => ({
    manifest: createMockManifest(id, type),
    path: `/plugins/${id}`,
    source: "local",
    status: "installed",
    installedAt: new Date(),
    config: {},
  })

  describe("load", () => {
    it("should return cached definition for already loaded plugin", async () => {
      const plugin = createMockPlugin("cached-plugin")

      // First, manually set up a cached module
      const mockDefinition: PluginDefinition = {
        manifest: plugin.manifest,
        activate: jest.fn(),
      }

      ;(loader as unknown as { loadedModules: Map<string, unknown> }).loadedModules.set(
        "cached-plugin",
        { definition: mockDefinition }
      )

      const result = await loader.load(plugin)

      expect(result).toBe(mockDefinition)
    })

    it("should not duplicate loading for concurrent requests", async () => {
      const plugin = createMockPlugin("concurrent-plugin")

      // First, manually set up a cached module to simulate the loader preventing duplicates
      const mockDefinition: PluginDefinition = {
        manifest: plugin.manifest,
        activate: jest.fn(),
      }

      ;(loader as unknown as { loadedModules: Map<string, unknown> }).loadedModules.set(
        "concurrent-plugin",
        { definition: mockDefinition }
      )

      // Start two concurrent loads - both should return the cached version
      const [result1, result2] = await Promise.all([loader.load(plugin), loader.load(plugin)])

      // Both should return the same cached definition
      expect(result1).toBe(mockDefinition)
      expect(result2).toBe(mockDefinition)
    })

    it("should return the pending load promise for concurrent frontend imports", async () => {
      const plugin = createMockPlugin("pending-frontend")
      let resolveImport!: (exports: Record<string, unknown>) => void
      const frontendImporter = jest.fn(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            resolveImport = resolve
          })
      )
      const concurrentLoader = new PluginLoader({ frontendImporter })

      const first = concurrentLoader.load(plugin)
      const second = concurrentLoader.load(plugin)
      resolveImport({ activate: jest.fn() })

      const [firstDefinition, secondDefinition] = await Promise.all([first, second])

      expect(firstDefinition).toBe(secondDefinition)
      expect(frontendImporter).toHaveBeenCalledTimes(1)
      expect(frontendImporter).toHaveBeenCalledWith(
        "/plugins/pending-frontend/index.js",
        "pending-frontend"
      )
    })

    it("should throw for unknown plugin type", async () => {
      const plugin = createMockPlugin("unknown-type")
      plugin.manifest.type = "unknown" as never

      await expect(loader.load(plugin)).rejects.toThrow("Unknown plugin type")
    })
  })

  describe("loadFrontendModule", () => {
    it("should throw if main entry point is missing", async () => {
      const plugin = createMockPlugin("no-main")
      plugin.manifest.main = undefined

      await expect(loader.load(plugin)).rejects.toThrow("missing 'main' entry point")
    })

    it("rejects a traversing main entry before invoking the importer", async () => {
      const plugin = createMockPlugin("unsafe-main")
      plugin.manifest.main = "..\\outside.js"
      const frontendImporter = jest.fn()
      const unsafeLoader = new PluginLoader({ frontendImporter })

      await expect(unsafeLoader.load(plugin)).rejects.toThrow("plugin-relative path (traversal)")
      expect(frontendImporter).not.toHaveBeenCalled()
    })

    it("loads the browser-specific entrypoint when declared", async () => {
      const plugin = createMockPlugin("browser-entry")
      plugin.manifest.runtimeCompatibility = {
        browser: { availability: "supported", entrypoint: "dist/browser.js" },
      }
      const frontendImporter = jest.fn().mockResolvedValue({ activate: jest.fn() })
      const browserLoader = new PluginLoader({ frontendImporter })

      await browserLoader.load(plugin)

      expect(frontendImporter).toHaveBeenCalledWith(
        "/plugins/browser-entry/dist/browser.js",
        "browser-entry"
      )
    })

    it("launches Node-target JavaScript plugins through the Node permission executor", async () => {
      const plugin = createMockPlugin("node-plugin")
      plugin.manifest.engines = { node: ">=24" }
      plugin.manifest.permissions = [
        "filesystem:read",
        "filesystem:write",
        "network:fetch",
        "shell:execute",
      ]
      plugin.manifest.fileScope = {
        readPaths: ["/plugins/node-plugin"],
        writePaths: ["/plugins/node-plugin/cache"],
      }
      plugin.manifest.networkAccess = { allowedDomains: ["api.example.com", "*"] }
      plugin.manifest.shellCommands = ["git", "*"]

      const definition = await loader.load(plugin)
      await definition.activate({ logger: { info: jest.fn(), warn: jest.fn() } } as never)

      expect(launcherModule.launchPluginJs).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "node-plugin",
          entryPath: "index.js",
          cwd: "/plugins/node-plugin",
          scope: {
            permissions: plugin.manifest.permissions,
            readPaths: ["/plugins/node-plugin"],
            writePaths: ["/plugins/node-plugin/cache"],
            netHosts: ["api.example.com", "*"],
            allowedSubprocesses: ["git", "*"],
          },
        })
      )
    })

    it("forwards the host-neutral invoker to Node-target plugin lifecycle calls", async () => {
      const hostInvoker = jest.fn()
      const nodeLoader = new PluginLoader({ nodeHostInvoker: hostInvoker })
      const plugin = createMockPlugin("node-host-plugin")
      plugin.manifest.engines = { node: ">=26" }

      const definition = await nodeLoader.load(plugin)
      await definition.activate({} as never)

      expect(launcherModule.launchPluginJs).toHaveBeenCalledWith(
        expect.objectContaining({ hostInvoker })
      )
    })

    it("replays Node activation registrations and routes callbacks through the host", async () => {
      const invokeCallback = jest.fn().mockResolvedValue({ ok: true })
      launcherModule.launchPluginJs.mockResolvedValueOnce({
        command: "/opt/node26/bin/node",
        argv: ["--permission"],
        process: { killed: false, kill: jest.fn(), isRunning: jest.fn().mockResolvedValue(true) },
        activation: {
          calls: [
            {
              path: "agent.registerTool",
              args: [
                {
                  name: "node_echo",
                  execute: { $callback: "call.0.args.0.execute" },
                },
              ],
            },
          ],
          hooks: { onCommand: { $callback: "hooks.onCommand" } },
          exports: { createConnector: { $callback: "exports.createConnector" } },
        },
        invokeCallback,
        deactivate: jest.fn(),
      })
      const registerTool = jest.fn()
      const plugin = createMockPlugin("node-plugin")
      plugin.manifest.engines = { node: ">=26.3.1" }
      const definition = await loader.load(plugin)

      const hooks = await definition.activate({ agent: { registerTool } } as never)
      const tool = registerTool.mock.calls[0][0]
      await expect(tool.execute({ message: "hello" })).resolves.toEqual({ ok: true })
      await expect(hooks?.onCommand?.("greet", ["Ada"])).resolves.toEqual({ ok: true })
      const exports = loader.getModuleExports("node-plugin")
      await expect(
        (exports?.createConnector as (config: { id: string }) => Promise<unknown>)({ id: "mail" })
      ).resolves.toEqual({ ok: true })

      expect(invokeCallback).toHaveBeenNthCalledWith(1, "call.0.args.0.execute", [
        { message: "hello" },
      ])
      expect(invokeCallback).toHaveBeenNthCalledWith(2, "hooks.onCommand", ["greet", ["Ada"]])
      expect(invokeCallback).toHaveBeenNthCalledWith(3, "exports.createConnector", [{ id: "mail" }])
    })

    it("kills the Node permission executor process during deactivate", async () => {
      const kill = jest.fn()
      launcherModule.launchPluginJs.mockResolvedValueOnce({
        command: "/opt/node24/bin/node",
        argv: ["--permission", "/plugins/node-plugin/index.js"],
        process: { killed: false, kill, isRunning: jest.fn().mockResolvedValue(true) },
        activation: { calls: [], hooks: {}, exports: {} },
        invokeCallback: jest.fn(),
        deactivate: jest.fn(),
      })
      const plugin = createMockPlugin("node-plugin")
      plugin.manifest.engines = { node: ">=24" }

      const definition = await loader.load(plugin)
      await definition.activate({ logger: { info: jest.fn(), warn: jest.fn() } } as never)
      await definition.deactivate?.()

      expect(kill).toHaveBeenCalledTimes(1)
    })

    it("launches runtimeCompatibility Node plugins with a contained entry path", async () => {
      const plugin = createMockPlugin("node-compat")
      plugin.manifest.runtimeCompatibility = {
        tauri: { availability: "supported", entrypoint: "node" },
      }
      plugin.manifest.main = "dist\\entry.mjs"

      const definition = await loader.load(plugin)
      await definition.activate({ logger: { info: jest.fn(), warn: jest.fn() } } as never)

      expect(launcherModule.launchPluginJs).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "node-compat",
          entryPath: "dist\\entry.mjs",
          cwd: "/plugins/node-compat",
          scope: expect.objectContaining({
            readPaths: [],
            writePaths: [],
            netHosts: [],
            allowedSubprocesses: [],
          }),
        })
      )
    })

    it("does not spawn a second Node executor while the first process is alive", async () => {
      const plugin = createMockPlugin("node-singleton")
      plugin.manifest.engines = { node: ">=24" }

      const definition = await loader.load(plugin)
      await definition.activate({ logger: { info: jest.fn(), warn: jest.fn() } } as never)
      await definition.activate({ logger: { info: jest.fn(), warn: jest.fn() } } as never)

      expect(launcherModule.launchPluginJs).toHaveBeenCalledTimes(1)
    })

    it("lets deactivate no-op before launch and after an already-killed process", async () => {
      const plugin = createMockPlugin("node-killed")
      plugin.manifest.engines = { node: ">=24" }
      const definition = await loader.load(plugin)

      await expect(definition.deactivate?.()).resolves.toBeUndefined()

      const kill = jest.fn()
      launcherModule.launchPluginJs.mockResolvedValueOnce({
        command: "/opt/node24/bin/node",
        argv: ["--permission", "/plugins/node-killed/index.js"],
        process: { killed: true, kill, isRunning: jest.fn().mockResolvedValue(false) },
        activation: { calls: [], hooks: {}, exports: {} },
        invokeCallback: jest.fn(),
        deactivate: jest.fn(),
      })
      await definition.activate({ logger: { info: jest.fn(), warn: jest.fn() } } as never)
      await definition.deactivate?.()

      expect(kill).not.toHaveBeenCalled()
    })
  })

  describe("load native bridge modules", () => {
    it("loads and caches WASM plugins through the WASM loader", async () => {
      const plugin = createMockPlugin("wasm-plugin")
      plugin.manifest.type = "wasm"
      const definition: PluginDefinition = { manifest: plugin.manifest, activate: jest.fn() }
      wasmLoader.loadWasmDefinition.mockResolvedValueOnce(definition)

      const result = await loader.load(plugin)

      expect(result).toBe(definition)
      expect(wasmLoader.loadWasmDefinition).toHaveBeenCalledWith(plugin.manifest, plugin.path)
      expect(loader.getDefinition("wasm-plugin")).toBe(definition)
      expect(loader.getModuleExports("wasm-plugin")).toEqual({ default: definition })
    })

    it("loads and caches VS Code extensions through the VS Code loader", async () => {
      const plugin = createMockPlugin("vscode-plugin")
      plugin.manifest.type = "vscode-extension"
      const definition: PluginDefinition = { manifest: plugin.manifest, activate: jest.fn() }
      vscodeLoader.loadVscodeDefinition.mockResolvedValueOnce(definition)

      const result = await loader.load(plugin)

      expect(result).toBe(definition)
      expect(vscodeLoader.loadVscodeDefinition).toHaveBeenCalledWith(plugin.manifest, plugin.path)
      expect(loader.getDefinition("vscode-plugin")).toBe(definition)
      expect(loader.getModuleExports("vscode-plugin")).toEqual({ default: definition })
    })
  })

  describe("loadPythonModule", () => {
    it("leaves Python subprocess ownership to PluginManager in the headless brain", async () => {
      jest.useRealTimers()
      jest.resetModules()
      const invoke = jest.fn()
      const updatePlugin = jest.fn()
      jest.doMock("@/lib/platform/detect", () => ({
        ...jest.requireActual("@/lib/platform/detect"),
        detectPlatform: () => "headless",
        isHeadlessHost: () => true,
        isTauri: () => false,
      }))
      jest.doMock("@tauri-apps/api/core", () => ({ invoke }))
      jest.doMock("@/lib/db/plugins", () => ({
        getPlugin: jest.fn(),
        updatePlugin,
      }))

      const { PluginLoader: FreshLoader } = await import("./loader")
      const fresh = new FreshLoader()
      const definition = await fresh.load(createMockPlugin("python-headless", "python"))
      const logger = { info: jest.fn(), warn: jest.fn() }

      await expect(definition.activate({ logger } as never)).resolves.toEqual({})
      await expect(definition.deactivate?.()).resolves.toBeUndefined()
      expect(invoke).not.toHaveBeenCalled()
      expect(logger.warn).not.toHaveBeenCalled()
      expect(updatePlugin).not.toHaveBeenCalled()

      jest.dontMock("@/lib/platform/detect")
      jest.dontMock("@tauri-apps/api/core")
      jest.dontMock("@/lib/db/plugins")
      jest.useFakeTimers()
    })

    it("should return minimal definition for Python plugins", async () => {
      const plugin = createMockPlugin("python-plugin", "python")

      const result = await loader.load(plugin)

      expect(result.manifest).toBe(plugin.manifest)
      expect(typeof result.activate).toBe("function")
      expect(typeof result.deactivate).toBe("function")
    })

    it("should log activation message", async () => {
      const plugin = createMockPlugin("python-log", "python")
      const definition = await loader.load(plugin)

      const mockContext = {
        logger: { info: jest.fn(), warn: jest.fn() },
      }

      await definition.activate(mockContext as never)

      // The stub fallback warns (not infos) so Python plugins land in the
      // degraded UI surface — the assertion was previously on .info.
      expect(mockContext.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Python plugin"))
    })

    it("delegates Python activation, hook dispatch, and deactivation through Tauri IPC", async () => {
      jest.useRealTimers()
      jest.resetModules()
      const invoke = jest.fn(async (cmd: string) => {
        if (cmd === "plugin_activate_python") {
          return {
            tools: [{ name: "native-tool", description: "Native tool" }],
            hooks: ["onLoad"],
          }
        }
        return undefined
      })
      jest.doMock("@/lib/platform/detect", () => ({
        ...jest.requireActual("@/lib/platform/detect"),
        detectPlatform: () => "tauri",
        isTauri: () => true,
      }))
      jest.doMock("@tauri-apps/api/core", () => ({ invoke }))

      const { PluginLoader: FreshLoader } = await import("./loader")
      const fresh = new FreshLoader()
      const plugin = createMockPlugin("python-native", "python")
      const definition = await fresh.load(plugin)
      const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }

      const hooks = await definition.activate({ logger } as never)
      await hooks?.onLoad?.()
      await definition.deactivate?.()

      expect(invoke).toHaveBeenNthCalledWith(1, "plugin_load_python", {
        pluginId: "python-native",
        manifestJson: JSON.stringify(plugin.manifest),
        pluginPath: "/plugins/python-native",
      })
      expect(invoke).toHaveBeenCalledWith("plugin_activate_python", {
        pluginId: "python-native",
        config: JSON.stringify({}),
      })
      expect(invoke).toHaveBeenCalledWith("plugin_dispatch_python_hook", {
        pluginId: "python-native",
        hookName: "onLoad",
        argsJson: JSON.stringify([]),
      })
      expect(invoke).toHaveBeenCalledWith("plugin_deactivate_python", {
        pluginId: "python-native",
      })
      expect(logger.debug).toHaveBeenCalledWith("Registering Python tool: native-tool")
      jest.dontMock("@/lib/platform/detect")
      jest.dontMock("@tauri-apps/api/core")
      jest.useFakeTimers()
    })

    it("stamps a python-runtime-unavailable warning on the row via persistPythonStubWarning", async () => {
      jest.useRealTimers()
      jest.resetModules()
      const updatePlugin = jest.fn().mockResolvedValue(undefined)
      const getPlugin = jest.fn().mockResolvedValue({
        id: "python-warn",
        manifest: { id: "python-warn" },
      })
      jest.doMock("@/lib/db/plugins", () => ({ getPlugin, updatePlugin }))

      const { PluginLoader: FreshLoader } = await import("./loader")
      const fresh = new FreshLoader() as unknown as {
        persistPythonStubWarning: (id: string) => Promise<void>
      }

      await fresh.persistPythonStubWarning("python-warn")

      expect(getPlugin).toHaveBeenCalledWith("python-warn")
      expect(updatePlugin).toHaveBeenCalledWith(
        "python-warn",
        expect.objectContaining({
          manifest: expect.objectContaining({
            _cogniaWarnings: ["python-runtime-unavailable"],
          }),
        })
      )
      jest.useFakeTimers()
    })

    it("does not duplicate the warning when persistPythonStubWarning runs twice", async () => {
      jest.useRealTimers()
      jest.resetModules()
      const updatePlugin = jest.fn().mockResolvedValue(undefined)
      const getPlugin = jest.fn().mockResolvedValue({
        id: "python-twice",
        manifest: { id: "python-twice", _cogniaWarnings: ["python-runtime-unavailable"] },
      })
      jest.doMock("@/lib/db/plugins", () => ({ getPlugin, updatePlugin }))

      const { PluginLoader: FreshLoader } = await import("./loader")
      const fresh = new FreshLoader() as unknown as {
        persistPythonStubWarning: (id: string) => Promise<void>
      }

      await fresh.persistPythonStubWarning("python-twice")

      expect(updatePlugin).not.toHaveBeenCalled()
      jest.useFakeTimers()
    })

    it("swallows db errors during warning persistence", async () => {
      jest.useRealTimers()
      jest.resetModules()
      const getPlugin = jest.fn().mockRejectedValue(new Error("db down"))
      const updatePlugin = jest.fn()
      jest.doMock("@/lib/db/plugins", () => ({ getPlugin, updatePlugin }))

      const { PluginLoader: FreshLoader } = await import("./loader")
      const fresh = new FreshLoader() as unknown as {
        persistPythonStubWarning: (id: string) => Promise<void>
      }

      // Should not throw.
      await expect(fresh.persistPythonStubWarning("python-broken")).resolves.toBeUndefined()
      expect(updatePlugin).not.toHaveBeenCalled()
      jest.useFakeTimers()
    })
  })

  describe("loadHybridModule", () => {
    it("should load frontend part if main exists", async () => {
      const plugin = createMockPlugin("hybrid-plugin", "hybrid")
      plugin.manifest.main = "index.js"

      // Mock fetch to return valid CJS module code so the loader can evaluate it
      const mockActivate = "function() {}"
      ;(global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () =>
          `module.exports = { activate: ${mockActivate}, manifest: { id: 'hybrid-plugin' } };`,
      })

      jest.useRealTimers()
      const definition = await loader.load(plugin)

      expect(definition).toBeDefined()
      expect(typeof definition.activate).toBe("function")
      jest.useFakeTimers()
    })

    it("should return combined definition", async () => {
      const plugin = createMockPlugin("hybrid-no-main", "hybrid")
      plugin.manifest.main = undefined

      const definition = await loader.load(plugin)

      expect(definition.manifest).toBe(plugin.manifest)
      expect(typeof definition.activate).toBe("function")
    })
  })

  describe("unload", () => {
    it("should remove loaded module", async () => {
      const pluginId = "to-unload"

      ;(loader as unknown as { loadedModules: Map<string, unknown> }).loadedModules.set(pluginId, {
        definition: {},
        exports: {},
      })

      expect(loader.isLoaded(pluginId)).toBe(true)

      await loader.unload(pluginId)

      expect(loader.isLoaded(pluginId)).toBe(false)
    })

    it("should cancel pending loading promises", async () => {
      const pluginId = "pending"

      // Manually add loading promise
      ;(
        loader as unknown as { loadingPromises: Map<string, Promise<unknown>> }
      ).loadingPromises.set(pluginId, Promise.resolve())

      await loader.unload(pluginId)

      expect(
        (
          loader as unknown as { loadingPromises: Map<string, Promise<unknown>> }
        ).loadingPromises.has(pluginId)
      ).toBe(false)
    })

    describe("with real timers for dynamic imports", () => {
      beforeEach(() => {
        jest.useRealTimers()
        diagModule.recordSilentFailure.mockReset()
        wasmLoader.unloadWasmPlugin.mockReset().mockResolvedValue(undefined)
        vscodeLoader.unloadVscodeExtension.mockReset().mockResolvedValue(undefined)
      })

      it("routes wasm unload failure through recordSilentFailure", async () => {
        wasmLoader.unloadWasmPlugin.mockImplementationOnce(() =>
          Promise.reject(new Error("wasm boom"))
        )
        const pluginId = "wasm-broken"
        ;(loader as unknown as { loadedModules: Map<string, unknown> }).loadedModules.set(
          pluginId,
          {
            definition: { manifest: { type: "wasm" } },
            exports: {},
          }
        )
        await loader.unload(pluginId)
        expect(wasmLoader.unloadWasmPlugin).toHaveBeenCalledWith(pluginId)
        expect(diagModule.recordSilentFailure).toHaveBeenCalledWith(
          pluginId,
          expect.objectContaining({ site: "loader.unloadWasmPlugin", expected: false }),
          expect.any(Error)
        )
        expect(loader.getDirtyTeardown(pluginId)).toEqual(
          expect.objectContaining({
            reason: "error",
            manifestType: "wasm",
            message: "wasm boom",
          })
        )
      })

      it("routes vscode unload failure through recordSilentFailure", async () => {
        vscodeLoader.unloadVscodeExtension.mockImplementationOnce(() =>
          Promise.reject(new Error("vscode boom"))
        )
        const pluginId = "vscode-broken"
        ;(loader as unknown as { loadedModules: Map<string, unknown> }).loadedModules.set(
          pluginId,
          {
            definition: { manifest: { type: "vscode-extension" } },
            exports: {},
          }
        )
        await loader.unload(pluginId)
        expect(vscodeLoader.unloadVscodeExtension).toHaveBeenCalledWith(pluginId)
        expect(diagModule.recordSilentFailure).toHaveBeenCalledWith(
          pluginId,
          expect.objectContaining({ site: "loader.unloadVscodeExtension", expected: false }),
          expect.any(Error)
        )
        expect(loader.getDirtyTeardown(pluginId)).toEqual(
          expect.objectContaining({
            reason: "error",
            manifestType: "vscode-extension",
            message: "vscode boom",
          })
        )
      })
    })

    describe("teardown timeout (chaos)", () => {
      it("abandons a hung WASM teardown after the configured timeout and marks dirty", async () => {
        jest.useFakeTimers()
        diagModule.recordSilentFailure.mockReset()
        wasmLoader.unloadWasmPlugin.mockReset()
        // Never-resolving teardown
        wasmLoader.unloadWasmPlugin.mockImplementation(() => new Promise<void>(() => {}))

        // Tiny budget so the test finishes quickly
        const fastLoader = new PluginLoader({ teardownTimeoutMs: 30 })
        const pluginId = "wasm-hung"
        ;(fastLoader as unknown as { loadedModules: Map<string, unknown> }).loadedModules.set(
          pluginId,
          { definition: { manifest: { type: "wasm" } }, exports: {} }
        )

        const unloading = fastLoader.unload(pluginId)
        await jest.advanceTimersByTimeAsync(30)
        await unloading

        expect(wasmLoader.unloadWasmPlugin).toHaveBeenCalledWith(pluginId)
        expect(diagModule.recordSilentFailure).toHaveBeenCalledWith(
          pluginId,
          expect.objectContaining({
            site: "loader.unloadWasmPlugin",
            message: expect.stringContaining("exceeded 30ms"),
          }),
          expect.any(Error)
        )
        expect(fastLoader.isLoaded(pluginId)).toBe(false)
        const dirty = fastLoader.getDirtyTeardown(pluginId)
        expect(dirty).toEqual(expect.objectContaining({ reason: "timeout", manifestType: "wasm" }))
        expect(fastLoader.clearDirtyTeardown(pluginId)).toBe(true)
        expect(fastLoader.getDirtyTeardown(pluginId)).toBeNull()
      })

      it("does not mark dirty when teardown resolves cleanly", async () => {
        jest.useRealTimers()
        wasmLoader.unloadWasmPlugin.mockReset().mockResolvedValue(undefined)
        const pluginId = "wasm-clean"
        ;(loader as unknown as { loadedModules: Map<string, unknown> }).loadedModules.set(
          pluginId,
          { definition: { manifest: { type: "wasm" } }, exports: {} }
        )
        await loader.unload(pluginId)
        expect(loader.getDirtyTeardown(pluginId)).toBeNull()
      })
    })
  })

  describe("isLoaded", () => {
    it("should return true for loaded plugins", () => {
      ;(loader as unknown as { loadedModules: Map<string, unknown> }).loadedModules.set(
        "loaded",
        {}
      )

      expect(loader.isLoaded("loaded")).toBe(true)
    })

    it("should return false for not loaded plugins", () => {
      expect(loader.isLoaded("not-loaded")).toBe(false)
    })
  })

  describe("getModuleExports", () => {
    it("should return exports for loaded module", () => {
      ;(loader as unknown as { loadedModules: Map<string, unknown> }).loadedModules.set(
        "with-exports",
        { definition: {}, exports }
      )

      expect(loader.getModuleExports("with-exports")).toBe(exports)
    })

    it("should return undefined for unknown module", () => {
      expect(loader.getModuleExports("unknown")).toBeUndefined()
    })
  })

  describe("importEntry and restoreModule", () => {
    it("imports secondary entries through the fetch/eval loader", async () => {
      ;(global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: async () => "module.exports = { value: 42 }",
      })

      await expect(loader.importEntry("/plugins/demo/secondary.js")).resolves.toEqual({ value: 42 })
    })

    it("reads installed Tauri entries through the no-follow host command", async () => {
      jest.useRealTimers()
      jest.resetModules()
      const invoke = jest.fn().mockResolvedValue("module.exports = { value: 7 }")
      jest.doMock("@/lib/platform/detect", () => ({ isTauri: () => true }))
      jest.doMock("@tauri-apps/api/core", () => ({ invoke }))

      const { PluginLoader: FreshLoader } = await import("./loader")
      const fresh = new FreshLoader()
      await expect(
        fresh.importEntry("/plugins/demo/dist/secondary.js", "demo", "/plugins/demo")
      ).resolves.toEqual({ value: 7 })
      expect(invoke).toHaveBeenCalledWith("plugin_read_entry", {
        pluginId: "demo",
        pluginPath: "/plugins/demo",
        entry: "dist/secondary.js",
      })

      jest.dontMock("@/lib/platform/detect")
      jest.dontMock("@tauri-apps/api/core")
      jest.useFakeTimers()
    })

    it("rejects secondary entries outside the plugin root", async () => {
      await expect(
        loader.importEntry("/plugins/outside.js", "demo", "/plugins/demo")
      ).rejects.toThrow(/outside the declared root/i)
    })

    it("restores module definitions and exports", () => {
      const definition: PluginDefinition = {
        manifest: createMockManifest("restored"),
        activate: jest.fn(),
      }
      const moduleExports = { default: definition, named: "value" }

      loader.restoreModule("restored", definition, moduleExports)

      expect(loader.getDefinition("restored")).toBe(definition)
      expect(loader.getModuleExports("restored")).toBe(moduleExports)
    })
  })

  describe("clear", () => {
    it("should clear all loaded modules", () => {
      ;(loader as unknown as { loadedModules: Map<string, unknown> }).loadedModules.set("m1", {})
      ;(loader as unknown as { loadedModules: Map<string, unknown> }).loadedModules.set("m2", {})

      loader.clear()

      expect(loader.isLoaded("m1")).toBe(false)
      expect(loader.isLoaded("m2")).toBe(false)
    })

    it("should clear all loading promises", () => {
      ;(
        loader as unknown as { loadingPromises: Map<string, Promise<unknown>> }
      ).loadingPromises.set("p1", Promise.resolve())

      loader.clear()

      expect(
        (loader as unknown as { loadingPromises: Map<string, Promise<unknown>> }).loadingPromises
          .size
      ).toBe(0)
    })
  })

  describe("extractDefinition", () => {
    const mockManifest = createMockManifest("test")

    it("should extract default export", () => {
      const moduleExports = {
        default: {
          manifest: mockManifest,
          activate: jest.fn(),
        },
      }

      const extractDefinition = (
        loader as unknown as {
          extractDefinition: (exports: unknown, manifest: PluginManifest) => PluginDefinition
        }
      ).extractDefinition.bind(loader)

      const result = extractDefinition(moduleExports, mockManifest)

      expect(result).toBe(moduleExports.default)
    })

    it("should extract named plugin export", () => {
      const moduleExports = {
        plugin: {
          manifest: mockManifest,
          activate: jest.fn(),
        },
      }

      const extractDefinition = (
        loader as unknown as {
          extractDefinition: (exports: unknown, manifest: PluginManifest) => PluginDefinition
        }
      ).extractDefinition.bind(loader)

      const result = extractDefinition(moduleExports, mockManifest)

      expect(result).toBe(moduleExports.plugin)
    })

    it("should create definition from activate function", () => {
      const activateFn = jest.fn()
      const deactivateFn = jest.fn()
      const moduleExports = {
        activate: activateFn,
        deactivate: deactivateFn,
      }

      const extractDefinition = (
        loader as unknown as {
          extractDefinition: (exports: unknown, manifest: PluginManifest) => PluginDefinition
        }
      ).extractDefinition.bind(loader)

      const result = extractDefinition(moduleExports, mockManifest)

      expect(result.manifest).toBe(mockManifest)
      expect(result.activate).toBe(activateFn)
      expect(result.deactivate).toBe(deactivateFn)
    })

    it("should throw for invalid exports", () => {
      const moduleExports = { invalid: "data" }

      const extractDefinition = (
        loader as unknown as {
          extractDefinition: (exports: unknown, manifest: PluginManifest) => PluginDefinition
        }
      ).extractDefinition.bind(loader)

      expect(() => extractDefinition(moduleExports, mockManifest)).toThrow(
        "does not export a valid plugin definition"
      )
    })
  })

  describe("isPluginDefinition", () => {
    const isPluginDefinition = (obj: unknown): boolean => {
      if (typeof obj !== "object" || obj === null) return false
      const def = obj as Record<string, unknown>
      return typeof def.activate === "function" || typeof def.manifest === "object"
    }

    it("should return true for object with activate function", () => {
      expect(isPluginDefinition({ activate: jest.fn() })).toBe(true)
    })

    it("should return true for object with manifest", () => {
      expect(isPluginDefinition({ manifest: {} })).toBe(true)
    })

    it("should return false for null", () => {
      expect(isPluginDefinition(null)).toBe(false)
    })

    it("should return false for non-object", () => {
      expect(isPluginDefinition("string")).toBe(false)
    })

    it("should return false for object without activate or manifest", () => {
      expect(isPluginDefinition({ other: "value" })).toBe(false)
    })
  })
})
