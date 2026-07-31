/**
 * Tests for useA2UI hook
 */

import { renderHook, act } from "@testing-library/react"
import { useA2UI } from "./use-a2ui"

// Mock the store
const mockCreateSurface = jest.fn()
const mockDeleteSurface = jest.fn()
const mockGetSurface = jest.fn()
const mockProcessMessage = jest.fn()
const mockProcessMessages = jest.fn()
const mockSetDataValue = jest.fn()
const mockGetDataValue = jest.fn()
const mockClearEventHistory = jest.fn()
const mockSetActiveSurface = jest.fn()

jest.mock("@/stores/a2ui", () => {
  const state = () => ({
    surfaces: {},
    eventHistory: [],
    activeSurfaceId: null,
    createSurface: mockCreateSurface,
    deleteSurface: mockDeleteSurface,
    getSurface: mockGetSurface,
    processMessage: mockProcessMessage,
    processMessages: mockProcessMessages,
    setDataValue: mockSetDataValue,
    getDataValue: mockGetDataValue,
    clearEventHistory: mockClearEventHistory,
    setActiveSurface: mockSetActiveSurface,
  })
  const useA2UIStore = Object.assign(
    jest.fn((selector) => selector(state())),
    { getState: jest.fn(() => state()) }
  )
  return { useA2UIStore }
})

// Mock parser functions
jest.mock("@/lib/a2ui/parser", () => ({
  parseA2UIInput: jest.fn((input) => {
    const toMessages = (surfaceId: string) => [
      { type: "createSurface", surfaceId, surfaceType: "inline" },
    ]

    if (typeof input === "string") {
      if (input.includes("a2ui")) {
        return { surfaceId: "test-surface", messages: toMessages("test-surface"), errors: [] }
      }
      if (input.startsWith("[") || input.startsWith("{")) {
        return { surfaceId: "json-surface", messages: toMessages("json-surface"), errors: [] }
      }
      return { surfaceId: null, messages: [], errors: ["invalid"] }
    }

    if (input && typeof input === "object") {
      return { surfaceId: "object-surface", messages: toMessages("object-surface"), errors: [] }
    }

    return { surfaceId: null, messages: [], errors: ["invalid"] }
  }),
  createA2UISurface: jest.fn(() => [{ type: "createSurface" }]),
}))

// Mock events
jest.mock("@/lib/a2ui/events", () => ({
  globalEventEmitter: {
    onAction: jest.fn(() => jest.fn()),
    onDataChange: jest.fn(() => jest.fn()),
  },
}))

describe("useA2UI", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("initialization", () => {
    it("should initialize with default options", () => {
      const { result } = renderHook(() => useA2UI())

      expect(result.current.createSurface).toBeDefined()
      expect(result.current.deleteSurface).toBeDefined()
      expect(result.current.getSurface).toBeDefined()
      expect(result.current.processMessage).toBeDefined()
      expect(result.current.processMessages).toBeDefined()
      expect(result.current.getEventHistory()).toEqual([])
      expect(result.current.activeSurfaceId).toBeNull()
    })

    it("should accept custom options", () => {
      const onAction = jest.fn()
      const onDataChange = jest.fn()

      renderHook(() => useA2UI({ onAction, onDataChange, autoProcess: false }))

      // Event listeners should be set up via the mock
      const { globalEventEmitter } = jest.requireMock("@/lib/a2ui/events")
      expect(globalEventEmitter.onAction).toHaveBeenCalledTimes(1)
      expect(globalEventEmitter.onDataChange).toHaveBeenCalledTimes(1)

      // The registered listeners delegate to the latest handler refs
      const registeredAction = globalEventEmitter.onAction.mock.calls[0][0]
      const registeredDataChange = globalEventEmitter.onDataChange.mock.calls[0][0]
      const actionPayload = { surfaceId: "s1", action: "click" }
      const changePayload = { surfaceId: "s1", path: "/a", value: 1 }
      registeredAction(actionPayload)
      registeredDataChange(changePayload)
      expect(onAction).toHaveBeenCalledWith(actionPayload)
      expect(onDataChange).toHaveBeenCalledWith(changePayload)
    })
  })

  describe("surface management", () => {
    it("should create a surface", () => {
      const { result } = renderHook(() => useA2UI())

      act(() => {
        result.current.createSurface("test-surface", "inline", { title: "Test" })
      })

      expect(mockCreateSurface).toHaveBeenCalledWith("test-surface", "inline", { title: "Test" })
    })

    it("should delete a surface", () => {
      const { result } = renderHook(() => useA2UI())

      act(() => {
        result.current.deleteSurface("test-surface")
      })

      expect(mockDeleteSurface).toHaveBeenCalledWith("test-surface")
    })

    it("should get a surface", () => {
      mockGetSurface.mockReturnValue({ id: "test-surface", components: {} })
      const { result } = renderHook(() => useA2UI())

      const surface = result.current.getSurface("test-surface")

      expect(mockGetSurface).toHaveBeenCalledWith("test-surface")
      expect(surface).toEqual({ id: "test-surface", components: {} })
    })
  })

  describe("message processing", () => {
    it("should process a single message", () => {
      const { result } = renderHook(() => useA2UI())
      const message = { type: "createSurface", surfaceId: "test" }

      act(() => {
        result.current.processMessage(
          message as unknown as import("@/types/artifact/a2ui").A2UIServerMessage
        )
      })

      expect(mockProcessMessage).toHaveBeenCalledWith(message)
    })

    it("should process multiple messages", () => {
      const { result } = renderHook(() => useA2UI())
      const messages = [
        { type: "createSurface", surfaceId: "test" },
        { type: "addComponent", surfaceId: "test", component: {} },
      ]

      act(() => {
        result.current.processMessages(
          messages as unknown as import("@/types/artifact/a2ui").A2UIServerMessage[]
        )
      })

      expect(mockProcessMessages).toHaveBeenCalledWith(messages)
    })

    it("should process valid JSON string", () => {
      const { result } = renderHook(() => useA2UI())
      const jsonStr = JSON.stringify([{ type: "createSurface" }])

      let success: boolean
      act(() => {
        success = result.current.processJsonString(jsonStr)
      })

      expect(success!).toBe(true)
      expect(mockProcessMessages).toHaveBeenCalled()
    })

    it("should return false for invalid JSON", () => {
      const { result } = renderHook(() => useA2UI())

      let success: boolean
      act(() => {
        success = result.current.processJsonString("invalid json")
      })

      expect(success!).toBe(false)
    })
  })

  describe("extractAndProcess", () => {
    it("should extract and process A2UI content from response", () => {
      const { result } = renderHook(() => useA2UI())

      let surfaceId: string | null
      act(() => {
        surfaceId = result.current.extractAndProcess("response with a2ui content")
      })

      expect(surfaceId!).toBe("test-surface")
      expect(mockProcessMessages).toHaveBeenCalled()
    })

    it("should return null for response without A2UI content", () => {
      const { result } = renderHook(() => useA2UI())

      let surfaceId: string | null
      act(() => {
        surfaceId = result.current.extractAndProcess("regular response")
      })

      expect(surfaceId!).toBeNull()
    })

    it("should not process when autoProcess is false", () => {
      const { result } = renderHook(() => useA2UI({ autoProcess: false }))

      act(() => {
        result.current.extractAndProcess("response with a2ui content")
      })

      expect(mockProcessMessages).not.toHaveBeenCalled()
    })
  })

  describe("quick surface creation", () => {
    it("should create a quick surface with components", () => {
      const { result } = renderHook(() => useA2UI())
      const components = [{ type: "text", props: { content: "Hello" } }]
      const dataModel = { message: "Hello" }

      act(() => {
        result.current.createQuickSurface(
          "quick-surface",
          components as unknown as import("@/types/artifact/a2ui").A2UIComponent[],
          dataModel,
          {
            type: "inline",
            title: "Quick App",
          }
        )
      })

      expect(mockProcessMessages).toHaveBeenCalled()
    })
  })

  describe("data model", () => {
    it("should set data value", () => {
      const { result } = renderHook(() => useA2UI())

      act(() => {
        result.current.setDataValue("test-surface", "/path/to/value", "new value")
      })

      expect(mockSetDataValue).toHaveBeenCalledWith("test-surface", "/path/to/value", "new value")
    })

    it("should get data value", () => {
      mockGetDataValue.mockReturnValue("stored value")
      const { result } = renderHook(() => useA2UI())

      const value = result.current.getDataValue("test-surface", "/path/to/value")

      expect(mockGetDataValue).toHaveBeenCalledWith("test-surface", "/path/to/value")
      expect(value).toBe("stored value")
    })
  })

  describe("event history", () => {
    it("should clear event history", () => {
      const { result } = renderHook(() => useA2UI())

      act(() => {
        result.current.clearEventHistory()
      })

      expect(mockClearEventHistory).toHaveBeenCalled()
    })
  })

  describe("active surface", () => {
    it("should set active surface", () => {
      const { result } = renderHook(() => useA2UI())

      act(() => {
        result.current.setActiveSurface("test-surface")
      })

      expect(mockSetActiveSurface).toHaveBeenCalledWith("test-surface")
    })

    it("should clear active surface", () => {
      const { result } = renderHook(() => useA2UI())

      act(() => {
        result.current.setActiveSurface(null)
      })

      expect(mockSetActiveSurface).toHaveBeenCalledWith(null)
    })
  })
})
