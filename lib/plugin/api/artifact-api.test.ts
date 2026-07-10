/**
 * Tests for Artifact Plugin API
 */

import { createArtifactAPI, getArtifactRenderers, clearArtifactRenderers } from "./artifact-api"
import { initializePluginPermissions } from "./permission-api"
import type { ArtifactRenderer } from "@/types/plugin/plugin"

// Mock artifact renderers to prevent heavy dependency chain (react-vega etc.)
jest.mock("@/components/artifacts/artifact-renderers", () => ({
  ArtifactRenderer: () => null,
  MermaidRenderer: () => null,
  ChartRenderer: () => null,
  MathRenderer: () => null,
  MarkdownRenderer: () => null,
  CodeRenderer: () => null,
}))

jest.mock("@/components/artifacts/artifact-preview", () => ({
  ArtifactPreview: () => null,
}))

// Mock artifact store
const mockArtifacts: Record<
  string,
  {
    id: string
    sessionId: string
    title: string
    content: string
    type: string
    language?: string
    metadata?: Record<string, unknown>
  }
> = {}
let mockActiveArtifactId: string | null = null
let mockPanelView: string | null = null
let mockPanelOpen = false
const mockSubscribers: Array<(state: unknown) => void> = []

jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: {
    getState: jest.fn(() => ({
      artifacts: mockArtifacts,
      activeArtifactId: mockActiveArtifactId,
      createArtifact: jest.fn((options) => {
        const id = `artifact-${Date.now()}`
        mockArtifacts[id] = { id, ...options }
        return { id }
      }),
      updateArtifact: jest.fn((id, updates) => {
        if (mockArtifacts[id]) {
          Object.assign(mockArtifacts[id], updates)
        }
      }),
      deleteArtifact: jest.fn((id) => {
        delete mockArtifacts[id]
      }),
      setActiveArtifact: jest.fn((id) => {
        mockActiveArtifactId = id
      }),
      setPanelView: jest.fn((view) => {
        mockPanelView = view
      }),
      openPanel: jest.fn((view) => {
        mockPanelOpen = true
        mockPanelView = view
      }),
      closePanel: jest.fn(() => {
        mockPanelOpen = false
        mockPanelView = null
      }),
    })),
    subscribe: jest.fn((callback) => {
      mockSubscribers.push(callback)
      return () => {
        const idx = mockSubscribers.indexOf(callback)
        if (idx >= 0) mockSubscribers.splice(idx, 1)
      }
    }),
  },
}))

jest.mock("@/stores", () => ({
  useArtifactStore: {
    getState: jest.fn(() => ({
      artifacts: mockArtifacts,
      activeArtifactId: mockActiveArtifactId,
      createArtifact: jest.fn((options) => {
        const id = `artifact-${Date.now()}`
        mockArtifacts[id] = { id, ...options }
        return { id }
      }),
      updateArtifact: jest.fn((id, updates) => {
        if (mockArtifacts[id]) {
          Object.assign(mockArtifacts[id], updates)
        }
      }),
      deleteArtifact: jest.fn((id) => {
        delete mockArtifacts[id]
      }),
      setActiveArtifact: jest.fn((id) => {
        mockActiveArtifactId = id
      }),
      setPanelView: jest.fn((view) => {
        mockPanelView = view
      }),
      openPanel: jest.fn((view) => {
        mockPanelOpen = true
        mockPanelView = view
      }),
      closePanel: jest.fn(() => {
        mockPanelOpen = false
        mockPanelView = null
      }),
    })),
  },
}))

describe("Artifact API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    // Clear state
    Object.keys(mockArtifacts).forEach((key) => delete mockArtifacts[key])
    mockActiveArtifactId = null
    mockPanelView = null
    mockPanelOpen = false
    mockSubscribers.length = 0

    // Clear renderers
    clearArtifactRenderers()
  })

  describe("createArtifactAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createArtifactAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.getActiveArtifact).toBe("function")
      expect(typeof api.getArtifact).toBe("function")
      expect(typeof api.createArtifact).toBe("function")
      expect(typeof api.updateArtifact).toBe("function")
      expect(typeof api.deleteArtifact).toBe("function")
      expect(typeof api.listArtifacts).toBe("function")
      expect(typeof api.openArtifact).toBe("function")
      expect(typeof api.closeArtifact).toBe("function")
      expect(typeof api.onArtifactChange).toBe("function")
      expect(typeof api.registerRenderer).toBe("function")
    })
  })

  describe("getActiveArtifact", () => {
    it("should return null when no artifact is active", () => {
      const api = createArtifactAPI(testPluginId)

      const result = api.getActiveArtifact()
      expect(result).toBeNull()
    })

    it("should return active artifact when one is set", () => {
      mockArtifacts["test-artifact"] = {
        id: "test-artifact",
        sessionId: "session-1",
        title: "Test Artifact",
        content: "test content",
        type: "code",
      }
      mockActiveArtifactId = "test-artifact"

      const api = createArtifactAPI(testPluginId)
      const result = api.getActiveArtifact()

      expect(result).toBeDefined()
      expect(result?.id).toBe("test-artifact")
    })
  })

  describe("getArtifact", () => {
    it("should return artifact by ID", () => {
      mockArtifacts["artifact-123"] = {
        id: "artifact-123",
        sessionId: "session-1",
        title: "My Artifact",
        content: "content",
        type: "document",
      }

      const api = createArtifactAPI(testPluginId)
      const result = api.getArtifact("artifact-123")

      expect(result).toBeDefined()
      expect(result?.title).toBe("My Artifact")
    })

    it("should return null for non-existent artifact", () => {
      const api = createArtifactAPI(testPluginId)
      const result = api.getArtifact("non-existent")

      expect(result).toBeNull()
    })
  })

  describe("createArtifact", () => {
    it("should create a new artifact", async () => {
      const api = createArtifactAPI(testPluginId)

      const id = await api.createArtifact({
        title: "New Artifact",
        content: 'console.log("hello")',
        type: "code",
        language: "javascript",
      })

      expect(id).toBeDefined()
      expect(typeof id).toBe("string")
    })

    it("should add deterministic source metadata while preserving explicit overrides", async () => {
      const api = createArtifactAPI(testPluginId)

      const id = await api.createArtifact({
        title: "Plugin Artifact",
        content: 'console.log("plugin");',
        type: "code",
        language: "javascript",
        sessionId: "session-1",
        messageId: "plugin-msg-1",
        metadata: {
          sourceOrigin: "manual",
          userInitiated: false,
        },
      })

      expect(mockArtifacts[id].metadata).toEqual(
        expect.objectContaining({
          sourceOrigin: "manual",
          userInitiated: false,
          sourceFingerprint: expect.any(String),
        })
      )
    })
  })

  describe("updateArtifact", () => {
    it("should update an existing artifact", () => {
      mockArtifacts["update-test"] = {
        id: "update-test",
        sessionId: "session-1",
        title: "Original Title",
        content: "original",
        type: "code",
      }

      const api = createArtifactAPI(testPluginId)
      api.updateArtifact("update-test", { title: "Updated Title" })

      // The mock should have been called
      expect(mockArtifacts["update-test"].title).toBe("Updated Title")
    })
  })

  describe("deleteArtifact", () => {
    it("should delete an artifact", () => {
      mockArtifacts["delete-test"] = {
        id: "delete-test",
        sessionId: "session-1",
        title: "To Delete",
        content: "",
        type: "document",
      }

      const api = createArtifactAPI(testPluginId)
      api.deleteArtifact("delete-test")

      expect(mockArtifacts["delete-test"]).toBeUndefined()
    })
  })

  describe("listArtifacts", () => {
    beforeEach(() => {
      mockArtifacts["artifact-1"] = {
        id: "artifact-1",
        sessionId: "session-1",
        title: "Artifact 1",
        content: "",
        type: "code",
        language: "python",
      }
      mockArtifacts["artifact-2"] = {
        id: "artifact-2",
        sessionId: "session-2",
        title: "Artifact 2",
        content: "",
        type: "document",
      }
      mockArtifacts["artifact-3"] = {
        id: "artifact-3",
        sessionId: "session-1",
        title: "Artifact 3",
        content: "",
        type: "code",
        language: "python",
      }
    })

    it("should list all artifacts without filter", () => {
      const api = createArtifactAPI(testPluginId)
      const result = api.listArtifacts()

      expect(result.length).toBe(3)
    })

    it("should filter by sessionId", () => {
      const api = createArtifactAPI(testPluginId)
      const result = api.listArtifacts({ sessionId: "session-1" })

      expect(result.length).toBe(2)
      expect(result.every((a) => a.sessionId === "session-1")).toBe(true)
    })

    it("should filter by language", () => {
      const api = createArtifactAPI(testPluginId)
      const result = api.listArtifacts({ language: "python" })

      expect(result.length).toBe(2)
    })

    it("should apply pagination", () => {
      const api = createArtifactAPI(testPluginId)

      const limited = api.listArtifacts({ limit: 2 })
      expect(limited.length).toBe(2)

      const offset = api.listArtifacts({ offset: 1 })
      expect(offset.length).toBe(2)

      const both = api.listArtifacts({ offset: 1, limit: 1 })
      expect(both.length).toBe(1)
    })

    it("should filter by type", () => {
      const api = createArtifactAPI(testPluginId)
      const result = api.listArtifacts({ type: "code" })

      expect(result.length).toBe(2)
      expect(result.every((a) => a.type === "code")).toBe(true)
    })

    it("should sort by updatedAt descending", () => {
      // Add timestamps to mock artifacts
      const now = Date.now()
      mockArtifacts["artifact-1"] = {
        ...mockArtifacts["artifact-1"],
        updatedAt: new Date(now - 2000),
      } as (typeof mockArtifacts)["artifact-1"]
      mockArtifacts["artifact-2"] = {
        ...mockArtifacts["artifact-2"],
        updatedAt: new Date(now - 1000),
      } as (typeof mockArtifacts)["artifact-2"]
      mockArtifacts["artifact-3"] = {
        ...mockArtifacts["artifact-3"],
        updatedAt: new Date(now),
      } as (typeof mockArtifacts)["artifact-3"]

      const api = createArtifactAPI(testPluginId)
      const result = api.listArtifacts()

      // Most recently updated should be first
      expect(result[0].id).toBe("artifact-3")
      expect(result[result.length - 1].id).toBe("artifact-1")
    })
  })

  describe("openArtifact / closeArtifact", () => {
    it("should open an artifact and reveal the artifact panel", () => {
      mockArtifacts["artifact-to-open"] = {
        id: "artifact-to-open",
        sessionId: "session-1",
        title: "Open Me",
        content: "artifact content",
        type: "code",
      }
      const api = createArtifactAPI(testPluginId)
      api.openArtifact("artifact-to-open")

      expect(mockActiveArtifactId).toBe("artifact-to-open")
      expect(mockPanelOpen).toBe(true)
      expect(mockPanelView).toBe("artifact")
    })

    it("should close artifact panel", () => {
      mockPanelView = "artifact"

      const api = createArtifactAPI(testPluginId)
      api.closeArtifact()

      expect(mockPanelView).toBeNull()
    })
  })

  describe("onArtifactChange", () => {
    it("should subscribe to artifact changes", () => {
      const api = createArtifactAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onArtifactChange(handler)

      expect(typeof unsubscribe).toBe("function")
      expect(mockSubscribers.length).toBe(1)
    })

    it("should unsubscribe when cleanup is called", () => {
      const api = createArtifactAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onArtifactChange(handler)
      expect(mockSubscribers.length).toBe(1)

      unsubscribe()
      expect(mockSubscribers.length).toBe(0)
    })
  })

  describe("registerRenderer", () => {
    it("should register a custom renderer", () => {
      const api = createArtifactAPI(testPluginId)

      const renderer: ArtifactRenderer = {
        type: "custom-type",
        name: "Custom Renderer",
        canRender: () => true,
        render: () => () => {},
      }

      const unregister = api.registerRenderer("custom-type", renderer)

      expect(typeof unregister).toBe("function")

      const renderers = getArtifactRenderers()
      expect(renderers.length).toBe(1)
    })

    it("should prefix renderer type with plugin ID", () => {
      const api = createArtifactAPI(testPluginId)

      const renderer: ArtifactRenderer = {
        type: "my-renderer",
        name: "My Renderer",
        canRender: () => true,
        render: () => () => {},
      }

      api.registerRenderer("my-renderer", renderer)

      const renderers = getArtifactRenderers()
      expect(renderers[0].type).toBe(`${testPluginId}:my-renderer`)
    })

    it("should unregister renderer when cleanup is called", () => {
      const api = createArtifactAPI(testPluginId)

      const renderer: ArtifactRenderer = {
        type: "temp-renderer",
        name: "Temp Renderer",
        canRender: () => true,
        render: () => () => {},
      }

      const unregister = api.registerRenderer("temp-renderer", renderer)
      expect(getArtifactRenderers().length).toBe(1)

      unregister()
      expect(getArtifactRenderers().length).toBe(0)
    })
  })

  describe("getArtifactRenderers", () => {
    it("should return all registered renderers", () => {
      const api = createArtifactAPI(testPluginId)

      api.registerRenderer("type-1", {
        type: "type-1",
        name: "Type 1",
        canRender: () => true,
        render: () => () => {},
      })
      api.registerRenderer("type-2", {
        type: "type-2",
        name: "Type 2",
        canRender: () => true,
        render: () => () => {},
      })

      const renderers = getArtifactRenderers()
      expect(renderers.length).toBe(2)
    })
  })
})

// W2.3: the artifact API is permission-gated; grant the suite's plugin.
beforeAll(() => {
  initializePluginPermissions("test-plugin", ["artifact:read", "artifact:write"])
})

describe("permission gate", () => {
  it("throws PermissionError when artifact permissions are not granted", () => {
    const api = createArtifactAPI("no-perms-plugin")
    expect(() => api.listArtifacts()).toThrow(/artifact:read/)
  })
})
