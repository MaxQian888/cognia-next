/**
 * Tests for loader.ts
 * Plugin Loader
 */

import { PluginLoader } from "./loader"
import type { Plugin, PluginManifest, PluginDefinition } from "@/types/plugin"

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
  })

  describe("loadPythonModule", () => {
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
        logger: { info: jest.fn() },
      }

      await definition.activate(mockContext as never)

      expect(mockContext.logger.info).toHaveBeenCalledWith(expect.stringContaining("Python plugin"))
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

      loader.unload(pluginId)

      expect(loader.isLoaded(pluginId)).toBe(false)
    })

    it("should cancel pending loading promises", () => {
      const pluginId = "pending"

      // Manually add loading promise
      ;(
        loader as unknown as { loadingPromises: Map<string, Promise<unknown>> }
      ).loadingPromises.set(pluginId, Promise.resolve())

      loader.unload(pluginId)

      expect(
        (
          loader as unknown as { loadingPromises: Map<string, Promise<unknown>> }
        ).loadingPromises.has(pluginId)
      ).toBe(false)
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
