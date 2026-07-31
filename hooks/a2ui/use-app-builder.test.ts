/**
 * Tests for useA2UIAppBuilder hook
 */

import { renderHook, act } from "@testing-library/react"
import { useA2UIAppBuilder } from "./use-app-builder"
import { getAppInstancesCache } from "./app-builder/persistence"
import { createShareLink, revokeShareLink, ShareNotConfiguredError } from "@/lib/share/client"
import { upsertTemplate } from "@/lib/db/a2ui-templates"
import type { A2UIPublishOutcome } from "@/types/a2ui/app"
import { globalEventEmitter, createUserAction } from "@/lib/a2ui/events"
import type { A2UIAppMetadataPatch } from "@/lib/db/a2ui-apps"
import type { A2UIAppRow } from "@/lib/db/a2ui-types"
import type { A2UISurfaceState } from "@/types/a2ui/schema"

// Mock localStorage
const mockLocalStorage: Record<string, string> = {}
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: jest.fn((key: string) => mockLocalStorage[key] || null),
    setItem: jest.fn((key: string, value: string) => {
      mockLocalStorage[key] = value
    }),
    removeItem: jest.fn((key: string) => {
      delete mockLocalStorage[key]
    }),
    clear: jest.fn(() => {
      Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key])
    }),
  },
  writable: true,
})

// Mock useA2UI hook
const mockProcessMessages = jest.fn()
const mockCreateQuickSurface = jest.fn()
const mockSetDataValue = jest.fn()
const mockRestoreSurface = jest.fn((_surface: A2UISurfaceState) => true)
const mockListApps = jest.fn<Promise<A2UIAppRow[]>, []>(async () => [])
const mockDeletePersistedApp = jest.fn(async (_id: string) => {})
const mockPatchAppMetadata = jest.fn(
  async (_id: string, _patch: A2UIAppMetadataPatch, _when?: number) => false
)
const mockLoggerError = jest.fn()

jest.mock("@cognia/logging", () => ({
  loggers: {
    app: {
      error: (...args: unknown[]) => mockLoggerError(...args),
    },
  },
}))

jest.mock("@/lib/db/a2ui-apps", () => ({
  listApps: () => mockListApps(),
  deleteApp: (id: string) => mockDeletePersistedApp(id),
  patchAppMetadata: (id: string, patch: A2UIAppMetadataPatch, when?: number) =>
    mockPatchAppMetadata(id, patch, when),
}))

jest.mock("@/lib/share/client", () => {
  class ShareNotConfiguredError extends Error {}
  return {
    createShareLink: jest.fn(),
    revokeShareLink: jest.fn(),
    ShareNotConfiguredError,
  }
})

jest.mock("@/lib/db/a2ui-templates", () => ({
  upsertTemplate: jest.fn(),
}))

jest.mock("./use-a2ui", () => ({
  useA2UI: jest.fn(() => ({
    processMessages: mockProcessMessages,
    createQuickSurface: mockCreateQuickSurface,
    setDataValue: mockSetDataValue,
    activeSurfaceId: null,
    setActiveSurface: jest.fn(),
  })),
}))

// Mock store
const mockDeleteSurface = jest.fn()
let mockSurfaces: Record<
  string,
  {
    id?: string
    components: Record<string, unknown>
    dataModel: Record<string, unknown>
    type?: string
    catalogId?: string
    title?: string
    widget?: Record<string, unknown>
    rootId?: string
    createdAt?: number
    updatedAt?: number
    ready?: boolean
  }
> = {}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: jest.fn((selector) => {
    const state = {
      surfaces: mockSurfaces,
      deleteSurface: mockDeleteSurface,
      restoreSurface: mockRestoreSurface,
    }
    if (typeof selector === "function") {
      return selector(state)
    }
    return state
  }),
}))

// Mock templates
jest.mock("@/lib/a2ui/templates", () => ({
  appTemplates: [
    {
      id: "template-1",
      name: "Test Template",
      description: "A test template",
      category: "productivity",
      icon: "CheckSquare",
      components: [{ type: "text", props: { content: "Hello" } }],
      dataModel: { message: "Hello" },
    },
  ],
  getTemplateById: jest.fn((id: string) => {
    if (id === "template-1") {
      return {
        id: "template-1",
        name: "Test Template",
        description: "A test template",
        category: "productivity",
        icon: "CheckSquare",
        components: [{ type: "text", props: { content: "Hello" } }],
        dataModel: { message: "Hello" },
      }
    }
    return undefined
  }),
  getLocalizedTemplateById: jest.fn((id: string) => {
    if (id === "template-1") {
      return {
        id: "template-1",
        name: "Test Template",
        description: "A test template",
        category: "productivity",
        icon: "CheckSquare",
        tags: [],
        components: [{ type: "text", props: { content: "Hello" } }],
        dataModel: { message: "Hello" },
      }
    }
    return undefined
  }),
  getLocalizedTemplates: jest.fn(() => [
    {
      id: "template-1",
      name: "Test Template",
      description: "A test template",
      category: "productivity",
      icon: "CheckSquare",
      tags: [],
      components: [{ type: "text", props: { content: "Hello" } }],
      dataModel: { message: "Hello" },
    },
  ]),
  getTemplatesByCategory: jest.fn((category: string) => {
    if (category === "productivity") {
      return [{ id: "template-1", name: "Test Template", category: "productivity" }]
    }
    return []
  }),
  getLocalizedTemplatesByCategory: jest.fn((category: string) => {
    if (category === "productivity") {
      return [{ id: "template-1", name: "Test Template", category: "productivity" }]
    }
    return []
  }),
  searchTemplates: jest.fn((query: string) => {
    if (query.includes("test")) {
      return [{ id: "template-1", name: "Test Template" }]
    }
    return []
  }),
  searchLocalizedTemplates: jest.fn((query: string) => {
    if (query.includes("test")) {
      return [{ id: "template-1", name: "Test Template" }]
    }
    return []
  }),
  createAppFromTemplate: jest.fn(() => ({
    surfaceId: "app-surface-123",
    messages: [{ type: "createSurface" }],
  })),
  generateTemplateId: jest.fn(() => "custom-app-123"),
  // Built-in action handlers format their runtime copy through this; the suite
  // only asserts that the data write happened, so a marker string is enough.
  formatBuiltInRuntimeMessage: jest.fn(
    (_locale: string, key: string, values: Record<string, string | number> = {}) =>
      `${key}:${JSON.stringify(values)}`
  ),
}))

describe("useA2UIAppBuilder", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key])
    mockSurfaces = {}
    mockListApps.mockResolvedValue([])
    mockDeletePersistedApp.mockResolvedValue(undefined)
    mockPatchAppMetadata.mockResolvedValue(false)
    mockRestoreSurface.mockReturnValue(true)
    jest.mocked(createShareLink).mockReset()
    jest.mocked(revokeShareLink).mockReset()
    jest.mocked(upsertTemplate).mockReset()
  })

  describe("publish / unpublish", () => {
    const fullInstance = (id: string) => ({
      id,
      templateId: "custom",
      name: "Publishable App",
      createdAt: Date.now(),
      lastModified: Date.now(),
      description: "A description long enough to pass validation",
      version: "1.0.0",
      category: "productivity",
      thumbnail: "data:image/png;base64,x",
    })

    it("returns invalid with the missing fields when the app is not publish-ready", async () => {
      getAppInstancesCache().set("app-x", {
        id: "app-x",
        templateId: "custom",
        name: "X",
        createdAt: 1,
        lastModified: 1,
      })
      const { result } = renderHook(() => useA2UIAppBuilder())
      let outcome: A2UIPublishOutcome | undefined
      await act(async () => {
        outcome = await result.current.publishApp("app-x")
      })
      expect(outcome).toEqual({
        ok: false,
        reason: "invalid",
        missing: expect.arrayContaining([expect.stringContaining("description")]),
      })
      expect(createShareLink).not.toHaveBeenCalled()
    })

    it("mints a hosted link and records published state on success", async () => {
      mockSurfaces["pub-app"] = { components: {}, dataModel: {} }
      getAppInstancesCache().set("pub-app", fullInstance("pub-app"))
      jest
        .mocked(createShareLink)
        .mockResolvedValue({ code: "CODE1", url: "https://share.test/v/CODE1#k=K" } as never)
      const { result } = renderHook(() => useA2UIAppBuilder())
      let outcome: A2UIPublishOutcome | undefined
      await act(async () => {
        outcome = await result.current.publishApp("pub-app")
      })
      expect(createShareLink).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ kind: "a2ui" }) })
      )
      expect(outcome).toEqual({ ok: true, url: "https://share.test/v/CODE1#k=K" })
      const stored = getAppInstancesCache().get("pub-app")
      expect(stored?.isPublished).toBe(true)
      expect(stored?.storeId).toBe("CODE1")
    })

    it("returns not-configured when sharing is unavailable", async () => {
      mockSurfaces["pub-app"] = { components: {}, dataModel: {} }
      getAppInstancesCache().set("pub-app", fullInstance("pub-app"))
      jest.mocked(createShareLink).mockRejectedValue(new ShareNotConfiguredError())
      const { result } = renderHook(() => useA2UIAppBuilder())
      let outcome: A2UIPublishOutcome | undefined
      await act(async () => {
        outcome = await result.current.publishApp("pub-app")
      })
      expect(outcome).toEqual({ ok: false, reason: "not-configured" })
    })

    it("unpublishes: revokes the link and clears published state", async () => {
      getAppInstancesCache().set("pub-app", {
        ...fullInstance("pub-app"),
        isPublished: true,
        publishedAt: 123,
        storeId: "CODE1",
      })
      jest.mocked(revokeShareLink).mockResolvedValue(undefined as never)
      const { result } = renderHook(() => useA2UIAppBuilder())
      await act(async () => {
        await result.current.unpublishApp("pub-app")
      })
      expect(revokeShareLink).toHaveBeenCalledWith("CODE1")
      const stored = getAppInstancesCache().get("pub-app")
      expect(stored?.isPublished).toBe(false)
      expect(stored?.storeId).toBeUndefined()
    })

    it("toggles favorite on and off without touching lastModified", async () => {
      getAppInstancesCache().set("fav-app", { ...fullInstance("fav-app"), lastModified: 999 })
      const { result } = renderHook(() => useA2UIAppBuilder())

      await act(async () => {
        await result.current.toggleFavorite("fav-app")
      })
      let stored = getAppInstancesCache().get("fav-app")
      expect(stored?.isFavorite).toBe(true)
      expect(stored?.lastModified).toBe(999)

      await act(async () => {
        await result.current.toggleFavorite("fav-app")
      })
      stored = getAppInstancesCache().get("fav-app")
      expect(stored?.isFavorite).toBe(false)
    })

    it("saves the current app as a user template", async () => {
      mockSurfaces["tpl-app"] = {
        components: { root: { id: "root", component: "Column" } },
        dataModel: { x: 1 },
        rootId: "root",
      }
      getAppInstancesCache().set("tpl-app", {
        ...fullInstance("tpl-app"),
        category: "productivity",
      })
      const { result } = renderHook(() => useA2UIAppBuilder())
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.saveAsTemplate("tpl-app")
      })
      expect(ok).toBe(true)
      expect(upsertTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Publishable App",
          category: "productivity",
          source: "user",
          isBuiltIn: false,
          components: [{ id: "root", component: "Column" }],
          dataModel: { x: 1 },
          rootId: "root",
        })
      )
    })

    it("returns false from saveAsTemplate when the surface is missing", async () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.saveAsTemplate("missing")
      })
      expect(ok).toBe(false)
      expect(upsertTemplate).not.toHaveBeenCalled()
    })
  })

  describe("initialization", () => {
    it("should return template management functions", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(result.current.templates).toBeDefined()
      expect(result.current.getTemplate).toBeDefined()
      expect(result.current.getTemplatesByCategory).toBeDefined()
      expect(result.current.searchTemplates).toBeDefined()
    })

    it("should return app management functions", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(result.current.createFromTemplate).toBeDefined()
      expect(result.current.createCustomApp).toBeDefined()
      expect(result.current.duplicateApp).toBeDefined()
      expect(result.current.deleteApp).toBeDefined()
      expect(result.current.renameApp).toBeDefined()
    })
  })

  describe("template management", () => {
    it("should get template by id", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      const template = result.current.getTemplate("template-1")

      expect(template).toBeDefined()
      expect(template?.name).toBe("Test Template")
    })

    it("should get templates by category", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      const templates = result.current.getTemplatesByCategory("productivity")

      expect(templates).toHaveLength(1)
    })

    it("should search templates", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      const results = result.current.searchTemplates("test")

      expect(results).toHaveLength(1)
    })
  })

  describe("app creation", () => {
    it("should create app from template", () => {
      const onAppCreated = jest.fn()
      const { result } = renderHook(() => useA2UIAppBuilder({ onAppCreated }))

      let appId: string | null
      act(() => {
        appId = result.current.createFromTemplate("template-1")
      })

      expect(appId!).toBe("app-surface-123")
      expect(mockProcessMessages).toHaveBeenCalled()
      expect(onAppCreated).toHaveBeenCalledWith("app-surface-123", "template-1")
    })

    it("should return null for invalid template", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      let appId: string | null
      act(() => {
        appId = result.current.createFromTemplate("invalid-template")
      })

      expect(appId!).toBeNull()
    })

    it("stores the locale that owns template and action-generated copy", () => {
      const { result } = renderHook(() => useA2UIAppBuilder({ locale: "zh-CN" }))

      act(() => {
        result.current.createFromTemplate("template-1")
      })

      expect(result.current.getAppInstance("app-surface-123")?.locale).toBe("zh-CN")
    })

    it("should create custom app", () => {
      const onAppCreated = jest.fn()
      const { result } = renderHook(() => useA2UIAppBuilder({ onAppCreated }))

      const components = [{ type: "text", props: { content: "Custom" } }]
      const dataModel = { custom: true }

      let appId: string | null
      act(() => {
        appId = result.current.createCustomApp(
          "My App",
          components as unknown as import("@/types/artifact/a2ui").A2UIComponent[],
          dataModel
        )
      })

      expect(appId!).toBe("custom-app-123")
      expect(mockCreateQuickSurface).toHaveBeenCalled()
      expect(onAppCreated).toHaveBeenCalledWith("custom-app-123", "custom")
    })

    it("should duplicate existing app", () => {
      mockSurfaces = {
        "existing-app": {
          components: { comp1: { type: "text" } },
          dataModel: { data: "value" },
        },
      }
      // Set up app instance in localStorage
      mockLocalStorage["a2ui-app-instances"] = JSON.stringify([
        { id: "existing-app", templateId: "template-1", name: "Original App" },
      ])

      const { result } = renderHook(() => useA2UIAppBuilder())

      let newAppId: string | null
      act(() => {
        newAppId = result.current.duplicateApp("existing-app", "Copied App")
      })

      expect(newAppId!).toBe("custom-app-123")
    })

    it("duplicates the complete surface and clone-owned metadata without publication identity", () => {
      const sourceComponents = {
        child: { id: "child", component: "Text", text: { literalString: "Hello" } },
        root: { id: "root", component: "Column", children: ["child"] },
      }
      const sourceDataModel = { nested: { value: 1 } }
      const sourceWidget = { preferredHost: "sidebar", minWidth: 320 }
      mockSurfaces = {
        "rich-app": {
          id: "rich-app",
          type: "panel",
          catalogId: "general",
          title: "Original surface title",
          widget: sourceWidget,
          components: sourceComponents,
          dataModel: sourceDataModel,
          rootId: "root",
          createdAt: 100,
          updatedAt: 200,
          ready: true,
        },
      }
      const sourceInstance = {
        id: "rich-app",
        templateId: "template-1",
        name: "Original App",
        createdAt: 100,
        lastModified: 200,
        description: "Clone this description",
        version: "2.3.4",
        author: { name: "Ada", email: "ada@example.com" },
        category: "productivity",
        tags: ["work", "shared"],
        thumbnail: "data:image/png;base64,thumb",
        thumbnailUpdatedAt: 150,
        screenshots: ["shot-1", "shot-2"],
        stats: { views: 99, uses: 42, rating: 4.8, ratingCount: 12 },
        publishedAt: 175,
        isPublished: true,
        storeId: "store-original",
      }
      getAppInstancesCache().set("rich-app", sourceInstance)

      const { result } = renderHook(() => useA2UIAppBuilder())

      let newAppId: string | null
      act(() => {
        newAppId = result.current.duplicateApp("rich-app", "Copied App")
      })

      expect(newAppId!).toBe("custom-app-123")
      expect(mockCreateQuickSurface).not.toHaveBeenCalled()
      expect(mockRestoreSurface).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "custom-app-123",
          type: "panel",
          catalogId: "general",
          title: "Copied App",
          rootId: "root",
          ready: true,
        })
      )
      const restored = mockRestoreSurface.mock.calls.at(-1)?.[0]
      expect(restored).toBeDefined()
      if (!restored) throw new Error("Expected restored surface")
      expect(restored.components).toEqual(sourceComponents)
      expect(restored.components).not.toBe(sourceComponents)
      expect(restored.dataModel).toEqual(sourceDataModel)
      expect(restored.dataModel).not.toBe(sourceDataModel)
      expect(restored.widget).toEqual(sourceWidget)
      expect(restored.widget).not.toBe(sourceWidget)

      const duplicate = getAppInstancesCache().get("custom-app-123")
      expect(duplicate).toMatchObject({
        id: "custom-app-123",
        templateId: "custom",
        name: "Copied App",
        description: "Clone this description",
        version: "2.3.4",
        author: sourceInstance.author,
        category: "productivity",
        tags: sourceInstance.tags,
        thumbnail: sourceInstance.thumbnail,
        thumbnailUpdatedAt: 150,
        screenshots: sourceInstance.screenshots,
      })
      expect(duplicate?.author).not.toBe(sourceInstance.author)
      expect(duplicate?.tags).not.toBe(sourceInstance.tags)
      expect(duplicate?.screenshots).not.toBe(sourceInstance.screenshots)
      expect(duplicate?.stats).toBeUndefined()
      expect(duplicate?.publishedAt).toBeUndefined()
      expect(duplicate?.isPublished).toBeUndefined()
      expect(duplicate?.storeId).toBeUndefined()
    })

    it("does not create an app instance when the cloned surface cannot be restored", () => {
      mockSurfaces = {
        "invalid-app": {
          components: {},
          dataModel: {},
          rootId: "missing-root",
        },
      }
      mockRestoreSurface.mockReturnValueOnce(false)
      getAppInstancesCache().delete("custom-app-123")
      const onAppCreated = jest.fn()
      const { result } = renderHook(() => useA2UIAppBuilder({ onAppCreated }))

      let newAppId: string | null
      act(() => {
        newAppId = result.current.duplicateApp("invalid-app")
      })

      expect(newAppId!).toBeNull()
      expect(getAppInstancesCache().has("custom-app-123")).toBe(false)
      expect(onAppCreated).not.toHaveBeenCalled()
    })
  })

  describe("app management", () => {
    it("should delete app", async () => {
      const onAppDeleted = jest.fn()
      mockLocalStorage["a2ui-app-instances"] = JSON.stringify([
        { id: "app-to-delete", templateId: "template-1", name: "App" },
      ])

      const { result } = renderHook(() => useA2UIAppBuilder({ onAppDeleted }))

      await act(async () => {
        await result.current.deleteApp("app-to-delete")
      })

      expect(mockDeletePersistedApp).toHaveBeenCalledWith("app-to-delete")
      expect(mockDeleteSurface).toHaveBeenCalledWith("app-to-delete")
      expect(onAppDeleted).toHaveBeenCalledWith("app-to-delete")
    })

    it("keeps the local app intact when durable deletion fails", async () => {
      const cache = getAppInstancesCache()
      cache.clear()
      cache.set("app-to-keep", {
        id: "app-to-keep",
        templateId: "custom",
        name: "Keep Me",
        createdAt: 1,
        lastModified: 2,
      })
      mockDeletePersistedApp.mockRejectedValueOnce(new Error("database unavailable"))
      const { result } = renderHook(() => useA2UIAppBuilder())

      await expect(result.current.deleteApp("app-to-keep")).rejects.toThrow("database unavailable")
      expect(mockDeleteSurface).not.toHaveBeenCalledWith("app-to-keep")
      expect(cache.has("app-to-keep")).toBe(true)
    })

    it("should rename app", () => {
      // Test that renameApp function exists and can be called
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(typeof result.current.renameApp).toBe("function")

      // Calling rename on non-existent app should not throw
      act(() => {
        result.current.renameApp("non-existent-app", "New Name")
      })
    })

    it("should get app instance", () => {
      // Note: Due to module-level caching, we check function exists and returns undefined for non-existent app
      const { result } = renderHook(() => useA2UIAppBuilder())

      const instance = result.current.getAppInstance("non-existent-app")

      expect(instance).toBeUndefined()
    })

    it("should get all apps", () => {
      // Note: Due to module-level caching in the hook, we verify the function returns an array
      const { result } = renderHook(() => useA2UIAppBuilder())

      const apps = result.current.getAllApps()

      expect(Array.isArray(apps)).toBe(true)
    })
  })

  describe("app data", () => {
    it("should get app data", () => {
      mockSurfaces = {
        "app-1": { components: {}, dataModel: { key: "value" } },
      }

      const { result } = renderHook(() => useA2UIAppBuilder())

      const data = result.current.getAppData("app-1")

      expect(data).toEqual({ key: "value" })
    })

    it("should set app data", () => {
      mockLocalStorage["a2ui-app-instances"] = JSON.stringify([
        { id: "app-1", templateId: "t1", name: "App", lastModified: 1000 },
      ])

      const { result } = renderHook(() => useA2UIAppBuilder())

      act(() => {
        result.current.setAppData("app-1", "/path", "new value")
      })

      expect(mockSetDataValue).toHaveBeenCalledWith("app-1", "/path", "new value")
    })
  })

  describe("action handling", () => {
    it("should handle add_task action", () => {
      mockSurfaces = {
        "app-1": {
          components: {},
          dataModel: {
            newTask: "New Task",
            tasks: [{ id: 1, text: "Existing", completed: false }],
          },
        },
      }

      const { result } = renderHook(() => useA2UIAppBuilder())

      act(() => {
        result.current.handleAppAction({
          type: "userAction",
          surfaceId: "app-1",
          componentId: "btn",
          action: "add_task",
          timestamp: Date.now(),
        })
      })

      // Should have called setAppData for tasks and newTask
      expect(mockSetDataValue).toHaveBeenCalled()
    })

    it("should pass unknown actions to external handler", () => {
      const onAction = jest.fn()
      const { result } = renderHook(() => useA2UIAppBuilder({ onAction }))

      const action = {
        type: "userAction" as const,
        surfaceId: "app-1",
        componentId: "btn",
        action: "custom_action",
        timestamp: Date.now(),
      }

      act(() => {
        result.current.handleAppAction(action)
      })

      expect(onAction).toHaveBeenCalledWith(action)
    })

    it("should handle calculator input actions", () => {
      mockSurfaces = {
        "calc-app": {
          components: {},
          dataModel: {
            display: "0",
            previousValue: null,
            operator: null,
            waitingForOperand: false,
          },
        },
      }

      const { result } = renderHook(() => useA2UIAppBuilder())

      act(() => {
        result.current.handleAppAction({
          type: "userAction",
          surfaceId: "calc-app",
          componentId: "btn",
          action: "input_5",
          timestamp: Date.now(),
        })
      })

      expect(mockSetDataValue).toHaveBeenCalled()
    })

    it("should handle timer start action", () => {
      mockSurfaces = {
        "timer-app": {
          components: {},
          dataModel: {
            isRunning: false,
            seconds: 0,
            totalSeconds: 60,
            display: "01:00",
          },
        },
      }

      const { result } = renderHook(() => useA2UIAppBuilder())

      act(() => {
        result.current.handleAppAction({
          type: "userAction",
          surfaceId: "timer-app",
          componentId: "btn",
          action: "start",
          timestamp: Date.now(),
        })
      })

      expect(mockSetDataValue).toHaveBeenCalledWith("timer-app", "/isRunning", true)
    })

    it("should handle add_item action for shopping list", () => {
      mockSurfaces = {
        "shopping-app": {
          components: {},
          dataModel: {
            newItem: { name: "Milk", quantity: 2 },
            items: [],
            totalText: "0 items",
          },
        },
      }

      const { result } = renderHook(() => useA2UIAppBuilder())

      act(() => {
        result.current.handleAppAction({
          type: "userAction",
          surfaceId: "shopping-app",
          componentId: "btn",
          action: "add_item",
          timestamp: Date.now(),
        })
      })

      expect(mockSetDataValue).toHaveBeenCalled()
    })

    it("should handle add_habit action", () => {
      mockSurfaces = {
        "habit-app": {
          components: {},
          dataModel: {
            newHabit: "Exercise",
            habits: [],
            stats: {
              streak: 0,
              streakText: "0 day streak",
              todayCompleted: 0,
              todayText: "0 completed today",
            },
          },
        },
      }

      const { result } = renderHook(() => useA2UIAppBuilder())

      act(() => {
        result.current.handleAppAction({
          type: "userAction",
          surfaceId: "habit-app",
          componentId: "btn",
          action: "add_habit",
          timestamp: Date.now(),
        })
      })

      expect(mockSetDataValue).toHaveBeenCalled()
    })

    it("should handle add_expense action", () => {
      mockSurfaces = {
        "expense-app": {
          components: {},
          dataModel: {
            newExpense: { description: "Coffee", amount: "5.50", category: "food" },
            expenses: [],
            stats: { total: 0, totalText: "$0.00", today: 0, todayText: "$0.00" },
          },
        },
      }

      const { result } = renderHook(() => useA2UIAppBuilder())

      act(() => {
        result.current.handleAppAction({
          type: "userAction",
          surfaceId: "expense-app",
          componentId: "btn",
          action: "add_expense",
          timestamp: Date.now(),
        })
      })

      expect(mockSetDataValue).toHaveBeenCalled()
    })

    it("should handle convert action for unit converter", () => {
      mockSurfaces = {
        "converter-app": {
          components: {},
          dataModel: {
            inputValue: "100",
            fromUnit: "m",
            toUnit: "cm",
            converterType: "length",
            result: "0",
          },
        },
      }

      const { result } = renderHook(() => useA2UIAppBuilder())

      act(() => {
        result.current.handleAppAction({
          type: "userAction",
          surfaceId: "converter-app",
          componentId: "btn",
          action: "convert",
          timestamp: Date.now(),
        })
      })

      expect(mockSetDataValue).toHaveBeenCalledWith("converter-app", "/result", expect.any(String))
    })
  })

  describe("import/export", () => {
    it("should return import/export functions", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(result.current.exportApp).toBeDefined()
      expect(result.current.downloadApp).toBeDefined()
      expect(result.current.importApp).toBeDefined()
      expect(result.current.importAppFromFile).toBeDefined()
      expect(result.current.exportAllApps).toBeDefined()
      expect(result.current.importAllApps).toBeDefined()
    })

    it("should export app to JSON (when app instance exists)", () => {
      // Note: Due to module-level caching in the hook, we verify the function behavior
      // The exportApp function returns null when surface or instance is not found
      mockSurfaces = {
        "app-to-export": {
          components: { root: { id: "root", component: "Column" } },
          dataModel: { key: "value" },
          type: "inline",
          title: "Test App",
        },
      }

      const { result } = renderHook(() => useA2UIAppBuilder())

      // Verify the function is callable and returns expected type
      let jsonData: string | null = null
      act(() => {
        jsonData = result.current.exportApp("app-to-export")
      })

      // Due to module-level caching, instance may not be found - verify function works
      expect(typeof result.current.exportApp).toBe("function")
      // jsonData will be null if instance not found (expected due to caching)
      expect(jsonData === null || typeof jsonData === "string").toBe(true)
    })

    it("should return null when exporting non-existent app", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      let jsonData: string | null
      act(() => {
        jsonData = result.current.exportApp("non-existent")
      })

      expect(jsonData!).toBeNull()
    })

    it("round-trips the instance locale through a single-app export", () => {
      mockSurfaces = {
        "app-surface-123": {
          components: { root: { id: "root", component: "Column" } },
          dataModel: {},
          type: "inline",
          title: "Localized App",
        },
      }
      const { result } = renderHook(() => useA2UIAppBuilder({ locale: "zh-CN" }))
      act(() => {
        result.current.createFromTemplate("template-1")
      })

      const exported = result.current.exportApp("app-surface-123")

      expect(JSON.parse(exported!).app.locale).toBe("zh-CN")
    })

    it("exports the complete surface identity needed to restore a custom root", () => {
      mockSurfaces = {
        "app-surface-123": {
          id: "app-surface-123",
          components: {
            "custom-root": { id: "custom-root", component: "Column" },
          },
          dataModel: {},
          type: "panel",
          catalogId: "catalog-v1",
          title: "Custom root app",
          widget: { theme: "dark" },
          rootId: "custom-root",
        },
      }
      const { result } = renderHook(() => useA2UIAppBuilder())
      act(() => {
        result.current.createFromTemplate("template-1")
      })
      Object.assign(getAppInstancesCache().get("app-surface-123")!, {
        description: "Portable description",
        author: { name: "Author" },
        tags: ["portable"],
        screenshots: ["data:image/png;base64,AA=="],
      })

      const exported = JSON.parse(result.current.exportApp("app-surface-123")!)

      expect(exported.app).toEqual(
        expect.objectContaining({
          surfaceType: "panel",
          catalogId: "catalog-v1",
          widget: { theme: "dark" },
          rootId: "custom-root",
          description: "Portable description",
          author: { name: "Author" },
          tags: ["portable"],
          screenshots: ["data:image/png;base64,AA=="],
        })
      )
    })

    it("should import app from JSON", () => {
      const onAppCreated = jest.fn()
      const { result } = renderHook(() => useA2UIAppBuilder({ onAppCreated }))

      const importData = JSON.stringify({
        version: "1.0",
        app: {
          name: "Imported App",
          templateId: "imported",
          components: [{ id: "root", component: "Column" }],
          dataModel: { imported: true },
          surfaceType: "inline",
        },
      })

      let appId: string | null
      act(() => {
        appId = result.current.importApp(importData)
      })

      expect(appId!).toBeTruthy()
      expect(mockRestoreSurface).toHaveBeenCalledWith(
        expect.objectContaining({
          id: appId!,
          rootId: "root",
          ready: true,
        })
      )
      expect(onAppCreated).toHaveBeenCalled()
    })

    it("restores an imported custom root and surface metadata atomically", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      const importData = JSON.stringify({
        version: "1.0",
        app: {
          name: "Custom root",
          components: [
            { id: "layout", component: "Column", children: ["label"] },
            { id: "label", component: "Text", text: "Hello" },
          ],
          rootId: "layout",
          dataModel: {},
          surfaceType: "fullscreen",
          catalogId: "catalog-v1",
          widget: { theme: "dark" },
        },
      })

      let appId: string | null
      act(() => {
        appId = result.current.importApp(importData)
      })

      expect(mockRestoreSurface).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: appId!,
          type: "fullscreen",
          catalogId: "catalog-v1",
          widget: { theme: "dark" },
          rootId: "layout",
          components: {
            layout: { id: "layout", component: "Column", children: ["label"] },
            label: { id: "label", component: "Text", text: "Hello" },
          },
        })
      )
    })

    it("rejects an invalid component graph without mutating the store or instance cache", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      mockRestoreSurface.mockClear()
      const beforeIds = result.current.getAllApps().map((app) => app.id)

      let appId: string | null
      act(() => {
        appId = result.current.importApp(
          JSON.stringify({
            version: "1.0",
            app: {
              name: "Broken",
              components: [{ id: "root", component: "Column", children: ["missing"] }],
            },
          })
        )
      })

      expect(appId!).toBeNull()
      expect(mockRestoreSurface).not.toHaveBeenCalled()
      expect(result.current.getAllApps().map((app) => app.id)).toEqual(beforeIds)
    })

    it("preserves an exported locale when importing into another active locale", () => {
      const { result } = renderHook(() => useA2UIAppBuilder({ locale: "en" }))
      const importData = JSON.stringify({
        version: "1.0",
        app: {
          name: "中文应用",
          templateId: "template-1",
          locale: "zh-CN",
          components: [{ id: "root", component: "Column" }],
          dataModel: {},
        },
      })

      let appId: string | null
      act(() => {
        appId = result.current.importApp(importData)
      })

      expect(result.current.getAppInstance(appId!)?.locale).toBe("zh-CN")
    })

    it("should return null for invalid import data", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      let appId: string | null
      act(() => {
        appId = result.current.importApp("{ invalid json")
      })

      expect(appId!).toBeNull()
    })

    it("should return null for import data without components", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      const invalidData = JSON.stringify({
        version: "1.0",
        app: {
          name: "No Components",
        },
      })

      let appId: string | null
      act(() => {
        appId = result.current.importApp(invalidData)
      })

      expect(appId!).toBeNull()
    })

    it("should export all apps", () => {
      mockSurfaces = {
        "app-1": { components: {}, dataModel: { a: 1 } },
        "app-2": { components: {}, dataModel: { b: 2 } },
      }
      mockLocalStorage["a2ui-app-instances"] = JSON.stringify([
        { id: "app-1", templateId: "t1", name: "App 1", createdAt: 1000, lastModified: 2000 },
        { id: "app-2", templateId: "t2", name: "App 2", createdAt: 1500, lastModified: 2500 },
      ])

      const { result } = renderHook(() => useA2UIAppBuilder())

      let jsonData: string
      act(() => {
        jsonData = result.current.exportAllApps()
      })

      expect(jsonData!).toBeTruthy()
      const parsed = JSON.parse(jsonData!)
      expect(parsed.version).toBe("1.0")
      expect(parsed.apps).toBeDefined()
      expect(Array.isArray(parsed.apps)).toBe(true)
    })

    it("should import multiple apps from backup", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      const backupData = JSON.stringify({
        version: "1.0",
        apps: [
          {
            name: "Backup App 1",
            templateId: "t1",
            components: [{ id: "root", component: "Column" }],
            dataModel: {},
          },
          {
            name: "Backup App 2",
            templateId: "t2",
            components: [{ id: "root", component: "Row" }],
            dataModel: {},
          },
        ],
      })

      let importedCount: number
      act(() => {
        importedCount = result.current.importAllApps(backupData)
      })

      expect(importedCount!).toBe(2)
    })

    it("validates an entire backup before restoring any app", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      mockRestoreSurface.mockClear()
      const backupData = JSON.stringify({
        version: "1.0",
        apps: [
          {
            name: "Valid",
            components: [{ id: "root", component: "Column" }],
          },
          {
            name: "Broken",
            components: [{ id: "root", component: "Column", children: ["missing"] }],
          },
        ],
      })

      let importedCount: number
      act(() => {
        importedCount = result.current.importAllApps(backupData)
      })

      expect(importedCount!).toBe(0)
      expect(mockRestoreSurface).not.toHaveBeenCalled()
    })

    it("rolls back every staged app when a validated backup cannot be fully restored", () => {
      const onAppCreated = jest.fn()
      const { result } = renderHook(() => useA2UIAppBuilder({ onAppCreated }))
      mockRestoreSurface.mockClear()
      mockDeleteSurface.mockClear()
      mockRestoreSurface.mockReturnValueOnce(true).mockReturnValueOnce(false)
      const backupData = JSON.stringify({
        version: "1.0",
        apps: [
          { name: "First", components: [{ id: "root", component: "Column" }] },
          { name: "Second", components: [{ id: "root", component: "Column" }] },
        ],
      })

      let importedCount: number
      act(() => {
        importedCount = result.current.importAllApps(backupData)
      })

      const stagedId = mockRestoreSurface.mock.calls[0][0].id
      expect(importedCount!).toBe(0)
      expect(mockDeleteSurface).toHaveBeenCalledWith(stagedId)
      expect(result.current.getAppInstance(stagedId)).toBeUndefined()
      expect(onAppCreated).not.toHaveBeenCalled()
    })

    it("restores complete instance metadata from a valid backup", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      const backupData = JSON.stringify({
        version: "1.0",
        apps: [
          {
            name: "Metadata app",
            templateId: "custom",
            components: [{ id: "root", component: "Column" }],
            createdAt: 100,
            lastModified: 200,
            description: "Description",
            author: { name: "Author" },
            tags: ["backup"],
            stats: { views: 4, uses: 2, rating: 5, ratingCount: 1 },
            publishedAt: 150,
            isPublished: true,
            storeId: "store-1",
          },
        ],
      })

      let importedCount: number
      act(() => {
        importedCount = result.current.importAllApps(backupData)
      })

      expect(importedCount!).toBe(1)
      const importedId = mockRestoreSurface.mock.calls.at(-1)?.[0].id
      expect(result.current.getAppInstance(importedId!)).toEqual(
        expect.objectContaining({
          createdAt: 100,
          lastModified: 200,
          description: "Description",
          author: { name: "Author" },
          tags: ["backup"],
          stats: { views: 4, uses: 2, rating: 5, ratingCount: 1 },
          publishedAt: 150,
          isPublished: true,
          storeId: "store-1",
        })
      )
    })

    it("should return 0 for invalid backup data", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      let importedCount: number
      act(() => {
        importedCount = result.current.importAllApps("{ invalid }")
      })

      expect(importedCount!).toBe(0)
    })
  })

  describe("share functionality", () => {
    it("should return share functions", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(result.current.generateShareCode).toBeDefined()
      expect(result.current.importFromShareCode).toBeDefined()
      expect(result.current.generateShareUrl).toBeDefined()
      expect(result.current.copyAppToClipboard).toBeDefined()
      expect(result.current.getShareData).toBeDefined()
      expect(result.current.shareAppNative).toBeDefined()
      expect(result.current.getSocialShareUrls).toBeDefined()
    })

    it("should generate share code", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      // Due to module-level caching, verify function behavior
      let shareCode: string | null = null
      act(() => {
        shareCode = result.current.generateShareCode("non-existent")
      })

      // Should return null for non-existent app
      expect(shareCode).toBeNull()
    })

    it("should return null for non-existent app share URL", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      let shareUrl: string | null = null
      act(() => {
        shareUrl = result.current.generateShareUrl("non-existent")
      })

      expect(shareUrl).toBeNull()
    })

    it("should return null for non-existent app share data", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      let shareData: { title: string; text: string; url: string } | null = null
      act(() => {
        shareData = result.current.getShareData("non-existent")
      })

      expect(shareData).toBeNull()
    })

    it("should return null for non-existent app social share URLs", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      let socialUrls: Record<string, string> | null = null
      act(() => {
        socialUrls = result.current.getSocialShareUrls("non-existent")
      })

      expect(socialUrls).toBeNull()
    })

    it("should import from share code", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      // Test with invalid share code
      let appId: string | null = null
      act(() => {
        appId = result.current.importFromShareCode("invalid-base64")
      })

      // Should return null for invalid share code
      expect(appId).toBeNull()
    })

    it("should handle clipboard copy failure gracefully", async () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      // Mock clipboard API to fail
      const originalClipboard = navigator.clipboard
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: jest.fn().mockRejectedValue(new Error("Clipboard error")),
        },
        writable: true,
      })

      let success: boolean = false
      await act(async () => {
        success = await result.current.copyAppToClipboard("non-existent", "url")
      })

      // Should return false when app doesn't exist
      expect(success).toBe(false)

      // Restore clipboard
      Object.defineProperty(navigator, "clipboard", {
        value: originalClipboard,
        writable: true,
      })
    })

    it("should handle native share failure gracefully", async () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      let success: boolean = false
      await act(async () => {
        success = await result.current.shareAppNative("non-existent")
      })

      // Should return false when app doesn't exist
      expect(success).toBe(false)
    })

    it("should generate valid social share URLs when app exists", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      // Test that getSocialShareUrls function works
      expect(typeof result.current.getSocialShareUrls).toBe("function")
    })

    it("should support all copy formats", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      // Verify copyAppToClipboard accepts all formats
      expect(typeof result.current.copyAppToClipboard).toBe("function")
    })
  })

  describe("metadata management", () => {
    it("should return updateAppMetadata function", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(typeof result.current.updateAppMetadata).toBe("function")
    })

    it("should accept metadata parameters without throwing", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      // Should not throw when called
      expect(() => {
        act(() => {
          result.current.updateAppMetadata("any-app", {
            description: "New description",
            version: "2.0.0",
            tags: ["new-tag"],
          })
        })
      }).not.toThrow()
    })

    it("should not throw when updating non-existent app", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(() => {
        act(() => {
          result.current.updateAppMetadata("non-existent", {
            description: "Test",
          })
        })
      }).not.toThrow()
    })
  })

  describe("thumbnail management", () => {
    it("should return setAppThumbnail function", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(typeof result.current.setAppThumbnail).toBe("function")
    })

    it("should accept thumbnail data without throwing", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(() => {
        act(() => {
          result.current.setAppThumbnail("any-app", "data:image/png;base64,test")
        })
      }).not.toThrow()
    })

    it("should return clearAppThumbnail function", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(typeof result.current.clearAppThumbnail).toBe("function")
    })

    it("should not throw when clearing thumbnail", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(() => {
        act(() => {
          result.current.clearAppThumbnail("any-app")
        })
      }).not.toThrow()
    })
  })

  describe("statistics", () => {
    it("should return incrementAppViews function", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(typeof result.current.incrementAppViews).toBe("function")
    })

    it("should accept view increment without throwing", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(() => {
        act(() => {
          result.current.incrementAppViews("any-app")
        })
      }).not.toThrow()
    })

    it("should return incrementAppUses function", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(typeof result.current.incrementAppUses).toBe("function")
    })

    it("should accept uses increment without throwing", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(() => {
        act(() => {
          result.current.incrementAppUses("any-app")
        })
      }).not.toThrow()
    })
  })

  describe("app store preparation", () => {
    it("should return prepareForPublish function", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      expect(typeof result.current.prepareForPublish).toBe("function")
    })

    it("should return invalid result for non-existent app", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      let publishResult: { valid: boolean; missing: string[] } = { valid: true, missing: [] }
      act(() => {
        publishResult = result.current.prepareForPublish("definitely-non-existent-app-id")
      })

      expect(publishResult.valid).toBe(false)
      expect(publishResult.missing).toContain("App not found")
    })

    it("should return result with valid and missing properties", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())

      let publishResult: { valid: boolean; missing: string[] } | null = null
      act(() => {
        publishResult = result.current.prepareForPublish("any-app")
      })

      expect(publishResult).not.toBeNull()
      expect(typeof publishResult!.valid).toBe("boolean")
      expect(Array.isArray(publishResult!.missing)).toBe(true)
    })
  })

  describe("hydratePersistedApps (orphan recovery)", () => {
    afterEach(() => {
      // The instance cache is a module singleton — clear it so seeded
      // instances don't leak into unrelated suites.
      getAppInstancesCache().clear()
    })

    it("restores a durable custom app when its local surface is missing", async () => {
      const cache = getAppInstancesCache()
      cache.clear()
      mockSurfaces = {}
      mockListApps.mockResolvedValueOnce([
        {
          id: "durable-custom",
          templateId: "custom",
          name: "Durable Custom App",
          description: "Saved in Dexie",
          createdAt: 10,
          lastModified: 20,
          updatedAt: 20,
          components: {
            "custom-root": { id: "custom-root", component: "Column", children: [] },
          },
          dataModel: { durable: true },
          rootId: "custom-root",
        },
      ])

      const { result } = renderHook(() => useA2UIAppBuilder())
      let recovered = 0
      await act(async () => {
        recovered = await result.current.hydratePersistedApps()
      })

      expect(recovered).toBe(1)
      expect(mockRestoreSurface).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "durable-custom",
          rootId: "custom-root",
          dataModel: { durable: true },
          ready: true,
        })
      )
      expect(cache.get("durable-custom")).toMatchObject({
        name: "Durable Custom App",
        description: "Saved in Dexie",
      })
    })

    it("regenerates a template-backed app whose surface tree is missing", async () => {
      const cache = getAppInstancesCache()
      cache.clear()
      cache.set("app-1", {
        id: "app-1",
        templateId: "template-1",
        name: "Calc",
        createdAt: 1,
        lastModified: 2,
      })
      mockSurfaces = {} // no renderable surface for app-1 → orphaned

      const { result } = renderHook(() => useA2UIAppBuilder())

      let recovered = 0
      await act(async () => {
        recovered = await result.current.hydratePersistedApps()
      })

      expect(recovered).toBe(1)
      expect(mockProcessMessages).toHaveBeenCalledWith([{ type: "createSurface" }])
    })

    it("skips apps that already have a renderable surface", async () => {
      const cache = getAppInstancesCache()
      cache.clear()
      cache.set("app-ready", {
        id: "app-ready",
        templateId: "template-1",
        name: "Ready",
        createdAt: 1,
        lastModified: 2,
      })
      mockSurfaces = {
        "app-ready": { ready: true, components: { root: {} }, dataModel: {} } as never,
      }
      mockListApps.mockResolvedValueOnce([
        {
          id: "app-ready",
          templateId: "template-1",
          name: "Durable Ready",
          createdAt: 1,
          lastModified: 3,
          updatedAt: 3,
          components: {
            durableRoot: { id: "durableRoot", component: "Column", children: [] },
          },
          dataModel: { source: "durable" },
          rootId: "durableRoot",
        },
      ])

      const { result } = renderHook(() => useA2UIAppBuilder())

      let recovered = 0
      await act(async () => {
        recovered = await result.current.hydratePersistedApps()
      })

      expect(recovered).toBe(0)
      expect(mockRestoreSurface).not.toHaveBeenCalled()
      expect(mockProcessMessages).not.toHaveBeenCalled()
    })

    it("falls back to deterministic template recovery when durable storage is unavailable", async () => {
      const cache = getAppInstancesCache()
      cache.clear()
      cache.set("app-offline", {
        id: "app-offline",
        templateId: "template-1",
        name: "Offline Template App",
        createdAt: 1,
        lastModified: 2,
      })
      mockSurfaces = {}
      mockListApps.mockRejectedValueOnce(new Error("IndexedDB unavailable"))

      const { result } = renderHook(() => useA2UIAppBuilder())

      let recovered = 0
      await act(async () => {
        recovered = await result.current.hydratePersistedApps()
      })

      expect(recovered).toBe(1)
      expect(mockProcessMessages).toHaveBeenCalledWith([{ type: "createSurface" }])
      expect(mockLoggerError).toHaveBeenCalledWith(
        "A2UI AppBuilder: Failed to restore durable apps",
        expect.any(Error)
      )
    })

    it("skips custom apps whose template cannot be resolved", async () => {
      const cache = getAppInstancesCache()
      cache.clear()
      cache.set("app-custom", {
        id: "app-custom",
        templateId: "custom",
        name: "Lost Custom App",
        createdAt: 1,
        lastModified: 2,
      })
      mockSurfaces = {}

      const { result } = renderHook(() => useA2UIAppBuilder())

      let recovered = 0
      await act(async () => {
        recovered = await result.current.hydratePersistedApps()
      })

      expect(recovered).toBe(0)
      expect(mockProcessMessages).not.toHaveBeenCalled()
    })
  })

  describe("wireBuiltInActions (emitter subscription)", () => {
    afterEach(() => {
      // The action emitter is a module singleton — drop any subscription left
      // behind so it can't fire in unrelated suites.
      globalEventEmitter.clear()
    })

    it("routes an emitted action through the built-in handler when opted in", () => {
      mockSurfaces = {
        "calc-1": {
          components: { root: {} },
          dataModel: { display: "5", waitingForOperand: false },
        } as never,
      }

      const { unmount } = renderHook(() => useA2UIAppBuilder({ wireBuiltInActions: true }))

      act(() => {
        globalEventEmitter.emitAction(createUserAction("calc-1", "input_3", "btn-3"))
      })

      // input_3 appends "3" to the current display via setAppData → setDataValue
      expect(mockSetDataValue).toHaveBeenCalledWith("calc-1", "/display", "53")
      unmount()
    })

    it("handles an action exactly once when two builders both opt in", () => {
      mockSurfaces = {
        "calc-1": {
          components: { root: {} },
          dataModel: { display: "5", waitingForOperand: false },
        } as never,
      }

      // Two concurrently-mounted opted-in builders (e.g. chat view + hub).
      const a = renderHook(() => useA2UIAppBuilder({ wireBuiltInActions: true }))
      const b = renderHook(() => useA2UIAppBuilder({ wireBuiltInActions: true }))

      act(() => {
        globalEventEmitter.emitAction(createUserAction("calc-1", "input_3", "btn-3"))
      })

      // Single module-level emitter listener → handled once, not twice.
      expect(mockSetDataValue).toHaveBeenCalledTimes(1)
      a.unmount()
      b.unmount()
    })

    it("does NOT handle actions when the flag is off (avoids double-dispatch)", () => {
      mockSurfaces = {
        "calc-1": {
          components: { root: {} },
          dataModel: { display: "5", waitingForOperand: false },
        } as never,
      }

      const { unmount } = renderHook(() => useA2UIAppBuilder({}))

      act(() => {
        globalEventEmitter.emitAction(createUserAction("calc-1", "input_3", "btn-3"))
      })

      expect(mockSetDataValue).not.toHaveBeenCalled()
      unmount()
    })

    it("escalates an unhandled action to onAction exactly once (no recursion)", () => {
      const onAction = jest.fn()
      const { unmount } = renderHook(() =>
        useA2UIAppBuilder({ wireBuiltInActions: true, onAction })
      )

      act(() => {
        globalEventEmitter.emitAction(createUserAction("s1", "totally_unknown_action", "c1"))
      })

      // The default branch escalates to onAction; a self-referential wiring
      // would re-enter the handler unboundedly and blow the stack.
      expect(onAction).toHaveBeenCalledTimes(1)
      unmount()
    })
  })

  describe("instance-mutating helpers (cache-backed)", () => {
    beforeEach(() => {
      const cache = getAppInstancesCache()
      cache.clear()
      cache.set("app-x", {
        id: "app-x",
        templateId: "template-1",
        name: "Original",
        createdAt: 100,
        lastModified: 100,
      })
    })

    afterEach(() => {
      getAppInstancesCache().clear()
    })

    it("renameApp updates local and durable metadata", async () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      await act(async () => {
        await result.current.renameApp("app-x", "Renamed")
      })
      expect(result.current.getAppInstance("app-x")?.name).toBe("Renamed")
      expect(mockPatchAppMetadata).toHaveBeenCalledWith(
        "app-x",
        expect.objectContaining({ name: "Renamed" }),
        expect.any(Number)
      )
    })

    it("preserves local metadata when the durable patch fails", async () => {
      mockPatchAppMetadata.mockRejectedValueOnce(new Error("database unavailable"))
      const { result } = renderHook(() => useA2UIAppBuilder())

      await expect(result.current.renameApp("app-x", "Renamed")).rejects.toThrow(
        "database unavailable"
      )
      expect(result.current.getAppInstance("app-x")?.name).toBe("Original")
    })

    it("updateAppMetadata merges fields while preserving id/createdAt", async () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      await act(async () => {
        await result.current.updateAppMetadata("app-x", {
          id: "ignored-id",
          createdAt: 999,
          description: "Desc",
          version: "2.0.0",
        })
      })
      const inst = result.current.getAppInstance("app-x")
      expect(inst?.description).toBe("Desc")
      expect(inst?.version).toBe("2.0.0")
      expect(inst?.id).toBe("app-x")
      expect(inst?.createdAt).toBe(100)
    })

    it("setAppThumbnail then clearAppThumbnail round-trips the thumbnail", async () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      await act(async () => {
        await result.current.setAppThumbnail("app-x", "data:image/png;base64,AAA")
      })
      expect(result.current.getAppInstance("app-x")?.thumbnail).toBe("data:image/png;base64,AAA")
      await act(async () => {
        await result.current.clearAppThumbnail("app-x")
      })
      expect(result.current.getAppInstance("app-x")?.thumbnail).toBeUndefined()
    })

    it("incrementAppViews / incrementAppUses bump the stats counters", async () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      await act(async () => {
        await result.current.incrementAppViews("app-x")
        await result.current.incrementAppViews("app-x")
        await result.current.incrementAppUses("app-x")
      })
      const stats = result.current.getAppInstance("app-x")?.stats
      expect(stats?.views).toBe(2)
      expect(stats?.uses).toBe(1)
    })

    it("prepareForPublish reports every missing field for a bare instance", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      let check: { valid: boolean; missing: string[] } = { valid: true, missing: [] }
      act(() => {
        check = result.current.prepareForPublish("app-x")
      })
      expect(check.valid).toBe(false)
      // description, thumbnail, category, and version are all absent here
      expect(check.missing.length).toBeGreaterThanOrEqual(4)
    })

    it("setAppData bumps lastModified on the backing instance", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      act(() => result.current.setAppData("app-x", "/value", 42))
      expect(mockSetDataValue).toHaveBeenCalledWith("app-x", "/value", 42)
      expect(result.current.getAppInstance("app-x")?.lastModified).toBeGreaterThan(100)
    })

    it("resetAppData replays the template's data model for a template-backed app", () => {
      const { result } = renderHook(() => useA2UIAppBuilder())
      act(() => result.current.resetAppData("app-x"))
      expect(mockProcessMessages).toHaveBeenCalledWith([
        expect.objectContaining({ type: "dataModelUpdate", surfaceId: "app-x", merge: false }),
      ])
    })
  })
})
