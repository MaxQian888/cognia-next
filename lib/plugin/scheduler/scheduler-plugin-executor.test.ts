/**
 * Scheduler Plugin Executor Tests
 */

import {
  registerPluginTaskHandler,
  unregisterPluginTaskHandler,
  getPluginTaskHandler,
  hasPluginTaskHandler,
  getPluginTaskHandlerNames,
  clearPluginTaskHandlers,
} from "./scheduler-plugin-executor"

describe("Scheduler Plugin Executor", () => {
  beforeEach(() => {
    clearPluginTaskHandlers()
  })

  afterEach(() => {
    clearPluginTaskHandlers()
  })

  describe("registerPluginTaskHandler", () => {
    it("should register a handler", () => {
      const handler = jest.fn().mockResolvedValue({ success: true })

      registerPluginTaskHandler("test-plugin:my-handler", handler)

      expect(hasPluginTaskHandler("test-plugin:my-handler")).toBe(true)
    })

    it("should allow retrieving the registered handler", () => {
      const handler = jest.fn().mockResolvedValue({ success: true })

      registerPluginTaskHandler("test-plugin:my-handler", handler)

      const retrieved = getPluginTaskHandler("test-plugin:my-handler")
      expect(retrieved).toBe(handler)
    })
  })

  describe("unregisterPluginTaskHandler", () => {
    it("should unregister a handler", () => {
      const handler = jest.fn().mockResolvedValue({ success: true })

      registerPluginTaskHandler("test-plugin:my-handler", handler)
      expect(hasPluginTaskHandler("test-plugin:my-handler")).toBe(true)

      unregisterPluginTaskHandler("test-plugin:my-handler")
      expect(hasPluginTaskHandler("test-plugin:my-handler")).toBe(false)
    })

    it("should not throw when unregistering non-existent handler", () => {
      expect(() => {
        unregisterPluginTaskHandler("non-existent")
      }).not.toThrow()
    })
  })

  describe("getPluginTaskHandler", () => {
    it("should return undefined for non-existent handler", () => {
      expect(getPluginTaskHandler("non-existent")).toBeUndefined()
    })
  })

  describe("hasPluginTaskHandler", () => {
    it("should return false for non-existent handler", () => {
      expect(hasPluginTaskHandler("non-existent")).toBe(false)
    })

    it("should return true for existing handler", () => {
      const handler = jest.fn().mockResolvedValue({ success: true })
      registerPluginTaskHandler("test-plugin:my-handler", handler)

      expect(hasPluginTaskHandler("test-plugin:my-handler")).toBe(true)
    })
  })

  describe("getPluginTaskHandlerNames", () => {
    it("should return empty array when no handlers registered", () => {
      expect(getPluginTaskHandlerNames()).toEqual([])
    })

    it("should return all registered handler names", () => {
      const handler1 = jest.fn().mockResolvedValue({ success: true })
      const handler2 = jest.fn().mockResolvedValue({ success: true })

      registerPluginTaskHandler("plugin-a:handler-1", handler1)
      registerPluginTaskHandler("plugin-b:handler-2", handler2)

      const names = getPluginTaskHandlerNames()
      expect(names).toContain("plugin-a:handler-1")
      expect(names).toContain("plugin-b:handler-2")
      expect(names.length).toBe(2)
    })
  })

  describe("clearPluginTaskHandlers", () => {
    it("should clear all handlers", () => {
      const handler1 = jest.fn().mockResolvedValue({ success: true })
      const handler2 = jest.fn().mockResolvedValue({ success: true })

      registerPluginTaskHandler("plugin-a:handler-1", handler1)
      registerPluginTaskHandler("plugin-b:handler-2", handler2)

      expect(getPluginTaskHandlerNames().length).toBe(2)

      clearPluginTaskHandlers()

      expect(getPluginTaskHandlerNames().length).toBe(0)
    })
  })
})
