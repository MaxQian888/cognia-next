/**
 * Tests for Extension Points Plugin API
 */

import React from "react"
import {
  createExtensionAPI,
  getExtensionsForPoint,
  getPluginExtensions,
  restorePluginExtensions,
  clearPluginExtensions,
  getPluginExtensionDiagnostics,
  clearAllExtensionDiagnostics,
} from "./extension-api"
import type { ExtensionPoint, ExtensionProps } from "@/types/plugin/plugin-extended"

describe("Extension API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    clearPluginExtensions(testPluginId)
    clearPluginExtensions("other-plugin")
    clearPluginExtensions("plugin-1")
    clearPluginExtensions("plugin-2")
    clearPluginExtensions("plugin-a")
    clearPluginExtensions("plugin-b")
    clearAllExtensionDiagnostics()
  })

  describe("createExtensionAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createExtensionAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.registerExtension).toBe("function")
      expect(typeof api.getExtensions).toBe("function")
      expect(typeof api.hasExtensions).toBe("function")
    })
  })

  describe("registerExtension", () => {
    it("should register an extension at a canonical point", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      const unregister = api.registerExtension("sidebar.left.top", TestComponent)

      expect(typeof unregister).toBe("function")
      expect(api.hasExtensions("sidebar.left.top")).toBe(true)
    })

    it("should map legacy aliases to canonical points and emit diagnostics", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("sidebar:top" as ExtensionPoint, TestComponent)

      expect(api.hasExtensions("sidebar.left.top")).toBe(true)
      expect(getPluginExtensionDiagnostics(testPluginId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "plugin.point.alias",
            canonicalId: "sidebar.left.top",
          }),
        ])
      )
    })

    it("should reject unknown points", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      expect(() => api.registerExtension("unknown-point" as ExtensionPoint, TestComponent)).toThrow(
        /Extension registration blocked/
      )
      expect(getPluginExtensionDiagnostics(testPluginId)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "plugin.point.unknown" })])
      )
    })

    it("should reject registration when permission is required in block mode", () => {
      const api = createExtensionAPI(testPluginId, {
        governanceMode: "block",
        hasPermission: () => false,
      })
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      expect(() => api.registerExtension("chat.header", TestComponent)).toThrow(
        /Extension registration blocked/
      )
      expect(getPluginExtensionDiagnostics(testPluginId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "plugin.point.permission_denied",
            severity: "error",
          }),
        ])
      )
    })

    it("should unregister extension when cleanup is called", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      const unregister = api.registerExtension("sidebar.left.top", TestComponent)
      expect(api.hasExtensions("sidebar.left.top")).toBe(true)

      unregister()
      expect(api.hasExtensions("sidebar.left.top")).toBe(false)
    })

    it("should register with priority option", () => {
      const api = createExtensionAPI(testPluginId)
      const HighPriority: React.ComponentType<ExtensionProps> = () => null
      const LowPriority: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("chat.input.actions", LowPriority, { priority: 1 })
      api.registerExtension("chat.input.actions", HighPriority, { priority: 10 })

      const extensions = api.getExtensions("chat.input.actions")
      expect(extensions.length).toBe(2)
      expect(extensions[0].options.priority).toBe(10)
    })

    it("should register with condition option", () => {
      const api = createExtensionAPI(testPluginId)
      const ConditionalComponent: React.ComponentType<ExtensionProps> = () => null
      let conditionResult = true

      api.registerExtension("toolbar.right", ConditionalComponent, {
        condition: () => conditionResult,
      })

      expect(api.hasExtensions("toolbar.right")).toBe(true)

      conditionResult = false
      expect(api.hasExtensions("toolbar.right")).toBe(false)
    })
  })

  describe("getExtensions", () => {
    it("should return empty array for point with no extensions", () => {
      const api = createExtensionAPI(testPluginId)
      expect(api.getExtensions("sidebar.left.bottom")).toEqual([])
    })

    it("should return all extensions for a point", () => {
      const api = createExtensionAPI(testPluginId)
      const Component1: React.ComponentType<ExtensionProps> = () => null
      const Component2: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("chat.message.actions", Component1)
      api.registerExtension("chat.message.actions", Component2)

      const extensions = api.getExtensions("chat.message.actions")
      expect(extensions.length).toBe(2)
    })

    it("should filter by condition", () => {
      const api = createExtensionAPI(testPluginId)
      const ShowComponent: React.ComponentType<ExtensionProps> = () => null
      const HideComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("settings.plugins", ShowComponent, { condition: () => true })
      api.registerExtension("settings.plugins", HideComponent, { condition: () => false })

      const extensions = api.getExtensions("settings.plugins")
      expect(extensions.length).toBe(1)
    })

    it("should handle condition errors gracefully", () => {
      const api = createExtensionAPI(testPluginId)
      const ErrorComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("chat.header", ErrorComponent, {
        condition: () => {
          throw new Error("Condition error")
        },
      })

      const extensions = api.getExtensions("chat.header")
      expect(extensions.length).toBe(0)
    })
  })

  describe("hasExtensions", () => {
    it("should return false for point with no extensions", () => {
      const api = createExtensionAPI(testPluginId)
      expect(api.hasExtensions("chat.message.footer")).toBe(false)
    })

    it("should return true for point with extensions", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("chat.message.footer", TestComponent)
      expect(api.hasExtensions("chat.message.footer")).toBe(true)
    })
  })

  describe("getExtensionsForPoint", () => {
    it("should return extensions from all plugins", () => {
      const api1 = createExtensionAPI("plugin-1")
      const api2 = createExtensionAPI("plugin-2")
      const Component1: React.ComponentType<ExtensionProps> = () => null
      const Component2: React.ComponentType<ExtensionProps> = () => null

      api1.registerExtension("chat.header", Component1)
      api2.registerExtension("chat.header", Component2)

      const extensions = getExtensionsForPoint("chat.header")
      expect(extensions.length).toBe(2)
    })
  })

  describe("clearPluginExtensions", () => {
    it("should clear all extensions for a specific plugin", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("toolbar.right", TestComponent)
      api.registerExtension("chat.header", TestComponent)

      expect(api.hasExtensions("toolbar.right")).toBe(true)
      expect(api.hasExtensions("chat.header")).toBe(true)

      clearPluginExtensions(testPluginId)

      expect(api.hasExtensions("toolbar.right")).toBe(false)
      expect(api.hasExtensions("chat.header")).toBe(false)
    })

    it("should not affect other plugins", () => {
      const api1 = createExtensionAPI("plugin-a")
      const api2 = createExtensionAPI("plugin-b")
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api1.registerExtension("chat.header", TestComponent)
      api2.registerExtension("chat.header", TestComponent)

      clearPluginExtensions("plugin-a")

      const extensions = getExtensionsForPoint("chat.header")
      expect(extensions.length).toBe(1)
      expect(extensions[0].pluginId).toBe("plugin-b")
    })
  })

  describe("plugin extension snapshot helpers", () => {
    it("returns all extensions for a specific plugin", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("toolbar.right", TestComponent)
      api.registerExtension("chat.header", TestComponent)

      expect(getPluginExtensions(testPluginId)).toHaveLength(2)
    })

    it("restores extension registrations for rollback flows", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("chat.header", TestComponent)
      const snapshot = getPluginExtensions(testPluginId)

      clearPluginExtensions(testPluginId)
      expect(getExtensionsForPoint("chat.header")).toHaveLength(0)

      restorePluginExtensions(testPluginId, snapshot)
      expect(getExtensionsForPoint("chat.header")).toHaveLength(1)
      expect(getPluginExtensions(testPluginId)).toHaveLength(1)
    })
  })
})
