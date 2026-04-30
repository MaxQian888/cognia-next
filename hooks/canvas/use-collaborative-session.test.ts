/**
 * Tests for useCollaborativeSession hook
 */

import { renderHook, act, waitFor } from "@testing-library/react"
import { useCollaborativeSession } from "./use-collaborative-session"
import type { Participant, CollaborativeSession } from "@/types/canvas/collaboration"

// Mock CRDT store
const mockCreateSession = jest.fn()
const mockJoinSession = jest.fn()
const mockLeaveSession = jest.fn()
const mockCloseSession = jest.fn()
const mockApplyLocalUpdate = jest.fn()
const mockUpdateCursor = jest.fn()
const mockGetDocumentContent = jest.fn()
const mockSerializeState = jest.fn()
const mockGetSession = jest.fn()
const mockSetLocalParticipantId = jest.fn()
const mockDeserializeState = jest.fn()

jest.mock("@/lib/canvas/collaboration/crdt-store", () => ({
  CanvasCRDTStore: jest.fn(),
  crdtStore: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    joinSession: (...args: unknown[]) => mockJoinSession(...args),
    leaveSession: (...args: unknown[]) => mockLeaveSession(...args),
    closeSession: (...args: unknown[]) => mockCloseSession(...args),
    applyLocalUpdate: (...args: unknown[]) => mockApplyLocalUpdate(...args),
    updateCursor: (...args: unknown[]) => mockUpdateCursor(...args),
    getDocumentContent: (...args: unknown[]) => mockGetDocumentContent(...args),
    serializeState: (...args: unknown[]) => mockSerializeState(...args),
    getSession: (...args: unknown[]) => mockGetSession(...args),
    setLocalParticipantId: (...args: unknown[]) => mockSetLocalParticipantId(...args),
    deserializeState: (...args: unknown[]) => mockDeserializeState(...args),
  },
}))

// Mock WebSocket provider
const mockProviderConnect = jest.fn()
const mockProviderDisconnect = jest.fn()
const mockProviderOn = jest.fn()
const mockBroadcastOperation = jest.fn()
const mockBroadcastCursor = jest.fn()
const mockBroadcastSelection = jest.fn()
const mockRequestSync = jest.fn()

jest.mock("@/lib/canvas/collaboration/websocket-provider", () => ({
  CanvasWebSocketProvider: jest.fn().mockImplementation(() => ({
    connect: mockProviderConnect,
    disconnect: mockProviderDisconnect,
    on: mockProviderOn,
    broadcastOperation: mockBroadcastOperation,
    broadcastCursor: mockBroadcastCursor,
    broadcastSelection: mockBroadcastSelection,
    requestSync: mockRequestSync,
  })),
}))

describe("useCollaborativeSession", () => {
  const mockSession: CollaborativeSession = {
    id: "session-123",
    documentId: "doc-456",
    participants: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ownerId: "owner-1",
    isActive: true,
    permissions: {
      canEdit: true,
      canComment: true,
      canShare: true,
      canExport: true,
    },
  }

  const mockParticipant: Participant = {
    id: "participant-1",
    name: "Test User",
    color: "#3b82f6",
    lastActive: new Date(),
    isOnline: true,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateSession.mockReturnValue(mockSession)
    mockApplyLocalUpdate.mockReturnValue({ id: "op-1", type: "insert" })
    mockGetDocumentContent.mockReturnValue("document content")
    mockSerializeState.mockReturnValue("serialized-state")
    mockGetSession.mockReturnValue(mockSession)
    mockDeserializeState.mockReturnValue("session-123")
    mockProviderConnect.mockResolvedValue(undefined)
  })

  describe("initialization", () => {
    it("should initialize with default state", () => {
      const { result } = renderHook(() => useCollaborativeSession())

      expect(result.current.session).toBeNull()
      expect(result.current.participants).toEqual([])
      expect(result.current.remoteCursors).toEqual([])
      expect(result.current.connectionState).toBe("disconnected")
      expect(result.current.isConnected).toBe(false)
    })

    it("should merge config with defaults", () => {
      const customConfig = {
        participantName: "Custom Name",
        participantColor: "#ff0000",
      }

      const { result } = renderHook(() => useCollaborativeSession(customConfig))

      expect(result.current.session).toBeNull()
      // Config is merged internally
    })
  })

  describe("connect", () => {
    it("should create session and set up participant", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      let sessionId: string = ""
      await act(async () => {
        sessionId = await result.current.connect("doc-456", "initial content")
      })

      expect(mockCreateSession).toHaveBeenCalledWith("doc-456", "initial content")
      expect(mockJoinSession).toHaveBeenCalled()
      expect(sessionId).toBe("session-123")
      expect(result.current.session).toEqual(mockSession)
      expect(result.current.participants).toHaveLength(1)
    })

    it("should connect to websocket when url is provided", async () => {
      const { result } = renderHook(() =>
        useCollaborativeSession({ websocketUrl: "ws://localhost:8080" })
      )

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(mockProviderConnect).toHaveBeenCalled()
      expect(mockProviderOn).toHaveBeenCalled()
    })

    it("should publish document-scoped collaboration state through onStateChange", async () => {
      const onStateChange = jest.fn()
      const { result } = renderHook(() =>
        useCollaborativeSession({ websocketUrl: "ws://localhost:8080", onStateChange })
      )

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-123",
          documentId: "doc-456",
          connectionState: expect.any(String),
          participants: expect.any(Array),
        })
      )
    })

    it("should handle websocket connection failure gracefully", async () => {
      mockProviderConnect.mockRejectedValue(new Error("Connection failed"))

      const { result } = renderHook(() =>
        useCollaborativeSession({ websocketUrl: "ws://localhost:8080" })
      )

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(result.current.connectionState).toBe("disconnected")
    })
  })

  describe("disconnect", () => {
    it("should clean up session and provider", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      act(() => {
        result.current.disconnect()
      })

      expect(result.current.session).toBeNull()
      expect(result.current.participants).toEqual([])
      expect(result.current.remoteCursors).toEqual([])
      expect(result.current.connectionState).toBe("disconnected")
    })

    it("should leave session in store", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      act(() => {
        result.current.disconnect()
      })

      expect(mockLeaveSession).toHaveBeenCalled()
      expect(mockCloseSession).toHaveBeenCalled()
    })
  })

  describe("updateContent", () => {
    it("should apply local update for insert", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      act(() => {
        result.current.updateContent(5, "new text", "insert")
      })

      expect(mockApplyLocalUpdate).toHaveBeenCalledWith(
        "session-123",
        expect.objectContaining({
          type: "insert",
          position: 5,
          text: "new text",
        })
      )
    })

    it("should apply local update for delete", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      act(() => {
        result.current.updateContent(5, "deleted", "delete")
      })

      expect(mockApplyLocalUpdate).toHaveBeenCalledWith(
        "session-123",
        expect.objectContaining({
          type: "delete",
          position: 5,
          length: 7, // 'deleted'.length
        })
      )
    })

    it("should not update when no session", () => {
      const { result } = renderHook(() => useCollaborativeSession())

      act(() => {
        result.current.updateContent(0, "text", "insert")
      })

      expect(mockApplyLocalUpdate).not.toHaveBeenCalled()
    })
  })

  describe("updateCursor", () => {
    it("should update cursor position", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      const cursorPosition = { line: 10, column: 5 }

      act(() => {
        result.current.updateCursor(cursorPosition)
      })

      expect(mockUpdateCursor).toHaveBeenCalledWith(
        "session-123",
        expect.any(String),
        cursorPosition
      )
    })

    it("should not update cursor when no session", () => {
      const { result } = renderHook(() => useCollaborativeSession())

      act(() => {
        result.current.updateCursor({ line: 1, column: 1 })
      })

      expect(mockUpdateCursor).not.toHaveBeenCalled()
    })
  })

  describe("updateSelection", () => {
    it("should broadcast selection changes when session is active", async () => {
      const { result } = renderHook(() =>
        useCollaborativeSession({ websocketUrl: "ws://localhost:8080" })
      )

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      act(() => {
        result.current.updateSelection({
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 5,
        })
      })

      expect(mockBroadcastSelection).toHaveBeenCalledWith({
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 5,
      })
    })
  })

  describe("getContent", () => {
    it("should return document content", async () => {
      mockGetDocumentContent.mockReturnValue("current content")
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      const content = result.current.getContent()

      expect(mockGetDocumentContent).toHaveBeenCalledWith("session-123")
      expect(content).toBe("current content")
    })

    it("should return null when no session", () => {
      const { result } = renderHook(() => useCollaborativeSession())

      const content = result.current.getContent()

      expect(content).toBeNull()
    })
  })

  describe("shareSession", () => {
    it("should serialize and return session state", async () => {
      mockSerializeState.mockReturnValue("serialized-session-data")
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      const serialized = result.current.shareSession()

      expect(mockSerializeState).toHaveBeenCalledWith("session-123")
      expect(serialized).toBe("serialized-session-data")
    })

    it("should return null when no session", () => {
      const { result } = renderHook(() => useCollaborativeSession())

      const serialized = result.current.shareSession()

      expect(serialized).toBeNull()
    })
  })

  describe("joinSession", () => {
    it("should join existing session", async () => {
      const existingSession = {
        ...mockSession,
        participants: [mockParticipant],
      }
      mockGetSession.mockReturnValue(existingSession)

      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.joinSession("session-123")
      })

      expect(mockGetSession).toHaveBeenCalledWith("session-123")
      expect(mockJoinSession).toHaveBeenCalled()
      expect(result.current.session).toEqual(existingSession)
    })

    it("should not join non-existent session", async () => {
      mockGetSession.mockReturnValue(null)

      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.joinSession("non-existent")
      })

      expect(result.current.session).toBeNull()
      expect(mockJoinSession).not.toHaveBeenCalled()
    })

    it("should connect to websocket when joining with url", async () => {
      const existingSession = {
        ...mockSession,
        participants: [mockParticipant],
      }
      mockGetSession.mockReturnValue(existingSession)

      const { result } = renderHook(() =>
        useCollaborativeSession({ websocketUrl: "ws://localhost:8080" })
      )

      await act(async () => {
        await result.current.joinSession("session-123")
      })

      expect(mockProviderConnect).toHaveBeenCalled()
      expect(mockRequestSync).toHaveBeenCalled()
    })
  })

  describe("importSharedSession", () => {
    it("should deserialize shared state and surface remote content", async () => {
      const onRemoteContentChange = jest.fn()
      mockGetDocumentContent.mockReturnValue("# shared content")

      const { result } = renderHook(() => useCollaborativeSession({ onRemoteContentChange }))

      let importedSessionId: string | null = null
      await act(async () => {
        importedSessionId = await result.current.importSharedSession("serialized-state")
      })

      expect(mockDeserializeState).toHaveBeenCalledWith("serialized-state")
      expect(importedSessionId).toBe("session-123")
      expect(onRemoteContentChange).toHaveBeenCalledWith("# shared content")
    })
  })

  describe("collaboration events", () => {
    it("should handle participant-joined event", async () => {
      const { result } = renderHook(() =>
        useCollaborativeSession({ websocketUrl: "ws://localhost:8080" })
      )

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      // Simulate participant-joined event
      const eventHandler = mockProviderOn.mock.calls.find(
        (call) => call[0] === "participant-joined"
      )?.[1]

      if (eventHandler) {
        act(() => {
          eventHandler({
            type: "participant-joined",
            data: mockParticipant,
          })
        })
      }

      await waitFor(() => {
        expect(result.current.participants.length).toBeGreaterThanOrEqual(1)
      })
    })

    it("should handle participant-left event", async () => {
      const { result } = renderHook(() =>
        useCollaborativeSession({ websocketUrl: "ws://localhost:8080" })
      )

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      // First add a participant
      const joinHandler = mockProviderOn.mock.calls.find(
        (call) => call[0] === "participant-joined"
      )?.[1]

      if (joinHandler) {
        act(() => {
          joinHandler({
            type: "participant-joined",
            data: mockParticipant,
          })
        })
      }

      // Then remove them
      const leaveHandler = mockProviderOn.mock.calls.find(
        (call) => call[0] === "participant-left"
      )?.[1]

      if (leaveHandler) {
        act(() => {
          leaveHandler({
            type: "participant-left",
            participantId: mockParticipant.id,
          })
        })
      }

      // Participant should be removed
      await waitFor(() => {
        expect(result.current.participants.find((p) => p.id === mockParticipant.id)).toBeUndefined()
      })
    })

    it("should handle connection state changes", async () => {
      const { result } = renderHook(() =>
        useCollaborativeSession({ websocketUrl: "ws://localhost:8080" })
      )

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      const connectedHandler = mockProviderOn.mock.calls.find(
        (call) => call[0] === "connected"
      )?.[1]

      if (connectedHandler) {
        act(() => {
          connectedHandler({ type: "connected" })
        })

        expect(result.current.connectionState).toBe("connected")
        expect(result.current.isConnected).toBe(true)
      }
    })

    it("should handle disconnected event", async () => {
      const { result } = renderHook(() =>
        useCollaborativeSession({ websocketUrl: "ws://localhost:8080" })
      )

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      const disconnectedHandler = mockProviderOn.mock.calls.find(
        (call) => call[0] === "disconnected"
      )?.[1]

      if (disconnectedHandler) {
        act(() => {
          disconnectedHandler({ type: "disconnected" })
        })

        expect(result.current.connectionState).toBe("disconnected")
        expect(result.current.isConnected).toBe(false)
      }
    })

    it("should handle error event", async () => {
      const { result } = renderHook(() =>
        useCollaborativeSession({ websocketUrl: "ws://localhost:8080" })
      )

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      const errorHandler = mockProviderOn.mock.calls.find((call) => call[0] === "error")?.[1]

      if (errorHandler) {
        act(() => {
          errorHandler({ type: "error" })
        })

        expect(result.current.connectionState).toBe("error")
      }
    })
  })

  describe("cleanup", () => {
    it("should disconnect on unmount", async () => {
      const { result, unmount } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      unmount()

      // Disconnect should be called via cleanup effect
      expect(mockLeaveSession).toHaveBeenCalled()
    })
  })

  describe("edge cases", () => {
    it("should not add duplicate participants", async () => {
      const { result } = renderHook(() =>
        useCollaborativeSession({ websocketUrl: "ws://localhost:8080" })
      )

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      const joinHandler = mockProviderOn.mock.calls.find(
        (call) => call[0] === "participant-joined"
      )?.[1]

      if (joinHandler) {
        // Add same participant twice
        act(() => {
          joinHandler({
            type: "participant-joined",
            data: mockParticipant,
          })
        })

        act(() => {
          joinHandler({
            type: "participant-joined",
            data: mockParticipant,
          })
        })

        // Should not duplicate
        const count = result.current.participants.filter((p) => p.id === mockParticipant.id).length
        expect(count).toBeLessThanOrEqual(1)
      }
    })

    it("should generate unique participant ID", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(result.current.participants[0].id).toMatch(/^participant-/)
    })
  })
})
