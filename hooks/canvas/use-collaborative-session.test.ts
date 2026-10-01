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
const mockEncodeSnapshot = jest.fn()
const mockApplySnapshot = jest.fn()
const mockGetSession = jest.fn()
const mockSetLocalParticipantId = jest.fn()
/** The document update bus. Returns its own unsubscribe, like the real one. */
const mockOnLocalUpdate = jest.fn()
const mockUnsubscribeLocalUpdate = jest.fn()
/** The awareness bus: this device's cursor and presence, encoded for the wire. */
const mockOnLocalAwarenessUpdate = jest.fn()
const mockUnsubscribeLocalAwareness = jest.fn()
const mockMarkSessionReady = jest.fn()
const mockSeedLocally = jest.fn()
const mockIsSeededLocally = jest.fn()
/** The editor's debounced keystrokes, flushed before the store is read. */
const mockFlushPendingEdits = jest.fn()
jest.mock("@/lib/canvas/pending-edits", () => ({
  flushPendingCanvasEdits: (...args: unknown[]) => mockFlushPendingEdits(...args),
}))

/**
 * `shareTarget` asks the artifact store which workspace owns the document,
 * because a link is addressed to a workspace the recipient must be a member of.
 */
const artifactDocument: { current: { id: string; projectId?: string } | null } = {
  current: { id: "doc-456", projectId: "ws-1" },
}
/** What the artifact store holds for each document, which the editor shows. */
const canvasDocuments: Record<string, { content: string }> = {}
const mockSaveCanvasVersion = jest.fn()
const mockUpdateCanvasDocument = jest.fn()
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: {
    getState: () => ({
      getCanvasDocumentForWorkspace: (id: string) =>
        artifactDocument.current?.id === id ? artifactDocument.current : null,
      canvasDocuments,
      saveCanvasVersion: (...args: unknown[]) => mockSaveCanvasVersion(...args),
      updateCanvasDocument: (...args: unknown[]) => mockUpdateCanvasDocument(...args),
    }),
  },
}))

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
    encodeSnapshot: (...args: unknown[]) => mockEncodeSnapshot(...args),
    applySnapshot: (...args: unknown[]) => mockApplySnapshot(...args),
    getSession: (...args: unknown[]) => mockGetSession(...args),
    setLocalParticipantId: (...args: unknown[]) => mockSetLocalParticipantId(...args),
    onLocalUpdate: (...args: unknown[]) => mockOnLocalUpdate(...args),
    onLocalAwarenessUpdate: (...args: unknown[]) => mockOnLocalAwarenessUpdate(...args),
    markSessionReady: (...args: unknown[]) => mockMarkSessionReady(...args),
    seedLocally: (...args: unknown[]) => mockSeedLocally(...args),
    isSeededLocally: (...args: unknown[]) => mockIsSeededLocally(...args),
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
const mockGetConnectionState = jest.fn()
const mockBroadcastAwareness = jest.fn()
const mockNoteSequence = jest.fn()
const mockNoteCaughtUpTo = jest.fn()
/** The config each provider was built with, so a test can drive `catchUp`. */
const providerConfigs: Array<{ catchUp?: (since: number) => Promise<number> }> = []

jest.mock("@/lib/canvas/collaboration/websocket-provider", () => ({
  CanvasWebSocketProvider: jest
    .fn()
    .mockImplementation((_store: unknown, config: { catchUp?: () => Promise<number> }) => {
      providerConfigs.push(config)
      return {
        connect: mockProviderConnect,
        disconnect: mockProviderDisconnect,
        on: mockProviderOn,
        broadcastOperation: mockBroadcastOperation,
        broadcastCursor: mockBroadcastCursor,
        broadcastSelection: mockBroadcastSelection,
        broadcastAwareness: mockBroadcastAwareness,
        noteSequence: mockNoteSequence,
        noteCaughtUpTo: mockNoteCaughtUpTo,
        requestSync: mockRequestSync,
        getConnectionState: mockGetConnectionState,
      }
    }),
}))

/**
 * The plane. `null` from `resolveCanvasTransport` is the ordinary answer on an
 * install with no collaboration server, and it must leave the local document
 * working rather than fail.
 */
const mockResolveTransport = jest.fn()
const mockPublishDocument = jest.fn()
const mockResolveShareTarget = jest.fn()
const mockHydrate = jest.fn()
const mockCatchUp = jest.fn()

jest.mock("@/lib/canvas/collaboration/canvas-transport", () => ({
  resolveCanvasTransport: (...args: unknown[]) => mockResolveTransport(...args),
  publishCanvasDocument: (...args: unknown[]) => mockPublishDocument(...args),
  resolveCanvasShareTarget: (...args: unknown[]) => mockResolveShareTarget(...args),
  hydrateCanvasSession: (...args: unknown[]) => mockHydrate(...args),
  catchUpCanvasDocument: (...args: unknown[]) => mockCatchUp(...args),
}))

const BINDING = {
  orgId: "org_acme",
  workspaceId: "ws-1",
  documentId: "doc-1",
  userId: "usr_ada",
  client: {} as never,
  openSocket: jest.fn(),
}

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
    mockEncodeSnapshot.mockReturnValue("AQE=")
    mockGetSession.mockReturnValue(mockSession)
    mockProviderConnect.mockResolvedValue(undefined)
    mockOnLocalUpdate.mockReturnValue(mockUnsubscribeLocalUpdate)
    mockOnLocalAwarenessUpdate.mockReturnValue(mockUnsubscribeLocalAwareness)
    mockIsSeededLocally.mockReturnValue(false)
    // `clearAllMocks` keeps implementations, and `closeForReal` installs one.
    mockCloseSession.mockImplementation(() => undefined)
    mockHydrate.mockResolvedValue({ kind: "joined", latestSequence: 7 })
    mockCatchUp.mockResolvedValue({ latestSequence: 9, empty: false })
    providerConfigs.length = 0
    for (const key of Object.keys(canvasDocuments)) delete canvasDocuments[key]
    mockGetConnectionState.mockReturnValue("connected")
    artifactDocument.current = { id: "doc-456", projectId: "ws-1" }
    mockResolveTransport.mockResolvedValue(BINDING)
    mockPublishDocument.mockResolvedValue({ id: "doc-1", latestSequence: 0 })
    mockResolveShareTarget.mockResolvedValue({
      orgId: "org_acme",
      workspaceId: "ws-1",
      documentId: "doc-456",
    })
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

      // Pending: empty and hidden from the editor until the plane has answered.
      expect(mockCreateSession).toHaveBeenCalledWith("doc-456", "initial content", {
        pending: true,
      })
      expect(mockJoinSession).toHaveBeenCalled()
      expect(sessionId).toBe("session-123")
      expect(result.current.session).toEqual(mockSession)
      expect(result.current.participants).toHaveLength(1)
    })

    it("should connect to websocket when url is provided", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(mockProviderConnect).toHaveBeenCalled()
      expect(mockProviderOn).toHaveBeenCalled()
    })

    it("should publish document-scoped collaboration state through onStateChange", async () => {
      const onStateChange = jest.fn()
      const { result } = renderHook(() =>
        useCollaborativeSession({
          onStateChange,
        })
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

    it("reports a failed connection as an error, not as a clean disconnect", async () => {
      // `connect` used to report this as "disconnected", which made a server
      // that refused the socket indistinguishable from never having tried.
      // The state feeds `recoveryReason`, so the difference is user-visible.
      mockProviderConnect.mockRejectedValue(new Error("Connection failed"))

      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(result.current.connectionState).toBe("error")
    })

    it("leaves nothing half-joined when the plane cannot be reached", async () => {
      // The session never became visible to the editor, so closing it leaves
      // the local document exactly as it was.
      mockHydrate.mockRejectedValue(new Error("catch-up failed"))
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(result.current.connectionState).toBe("error")
      expect(result.current.session).toBeNull()
      expect(mockCloseSession).toHaveBeenCalledWith("session-123")
      expect(mockMarkSessionReady).not.toHaveBeenCalled()
      expect(mockProviderDisconnect).toHaveBeenCalled()
      expect(mockUnsubscribeLocalUpdate).toHaveBeenCalled()
      expect(mockUnsubscribeLocalAwareness).toHaveBeenCalled()
      expect(mockUpdateCanvasDocument).not.toHaveBeenCalled()
    })

    it("stays local, and quiet, when this install has no plane", async () => {
      // The ordinary case for a single-machine user. Not an error.
      mockResolveTransport.mockResolvedValue(null)
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(result.current.connectionState).toBe("disconnected")
      expect(result.current.session).toEqual(mockSession)
      expect(mockPublishDocument).not.toHaveBeenCalled()
      // Settled on this device: the text is inserted here and the editor binds.
      expect(mockSeedLocally).toHaveBeenCalledWith("session-123", "content")
      expect(mockFlushPendingEdits).toHaveBeenCalledWith("doc-456")
      expect(mockMarkSessionReady).toHaveBeenCalledWith("session-123")
    })

    it("does not open a socket for a document it could not publish", async () => {
      // A viewer cannot create the row. Attaching anyway would open a socket
      // against a document the server does not have.
      mockPublishDocument.mockResolvedValue(null)
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(mockProviderConnect).not.toHaveBeenCalled()
      expect(mockSeedLocally).toHaveBeenCalledWith("session-123", "content")
      expect(mockMarkSessionReady).toHaveBeenCalledWith("session-123")
    })

    it("broadcasts every local change through the document bus", async () => {
      // The CRDT could receive and never send: the only producer of an
      // operation was `updateContent`, which had no callers. Subscribing to
      // the document rather than to one call site means an editor binding, an
      // AI apply and a plugin write all leave the same way.
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(mockOnLocalUpdate).toHaveBeenCalledWith("session-123", expect.any(Function))
      const forward = mockOnLocalUpdate.mock.calls[0][1] as (op: unknown) => void
      const operation = { id: "op-1", update: "AQE=", origin: "p-self", timestamp: 1 }
      forward(operation)
      expect(mockBroadcastOperation).toHaveBeenCalledWith(operation)
    })

    it("stops broadcasting once the session is closed", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })
      act(() => {
        result.current.disconnect()
      })

      expect(mockUnsubscribeLocalUpdate).toHaveBeenCalled()
    })

    it("publishes the document before opening the socket", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(mockPublishDocument).toHaveBeenCalledWith(
        BINDING,
        expect.objectContaining({ title: expect.any(String), language: expect.any(String) })
      )
      expect(mockProviderConnect).toHaveBeenCalled()
      // The opener hydrates from the plane rather than asking the socket for
      // one page from zero.
      expect(mockHydrate).toHaveBeenCalledWith(
        BINDING,
        expect.anything(),
        "session-123",
        expect.any(Function)
      )
      expect(mockRequestSync).not.toHaveBeenCalled()
      // Everything up to the hydrated sequence is applied, not just that one.
      expect(mockNoteCaughtUpTo).toHaveBeenCalledWith(7)
    })

    it("subscribes to both buses before the socket opens", async () => {
      // An edit or a caret move made while the socket is coming up is queued
      // by the provider. Subscribing after `connect` used to drop it.
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      const connectOrder = mockProviderConnect.mock.invocationCallOrder[0]
      expect(mockOnLocalUpdate.mock.invocationCallOrder[0]).toBeLessThan(connectOrder)
      expect(mockOnLocalAwarenessUpdate.mock.invocationCallOrder[0]).toBeLessThan(connectOrder)
    })

    it("sends this device's awareness through the provider", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(mockOnLocalAwarenessUpdate).toHaveBeenCalledWith("session-123", expect.any(Function))
      const forward = mockOnLocalAwarenessUpdate.mock.calls[0][1] as (update: string) => void
      forward("AAEC")
      expect(mockBroadcastAwareness).toHaveBeenCalledWith("AAEC")
    })

    it("lets the editor bind only after the plane has answered", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(mockMarkSessionReady).toHaveBeenCalledWith("session-123")
      expect(mockMarkSessionReady.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockHydrate.mock.invocationCallOrder[0]
      )
    })

    it("offers the content as it is when the plane answers, not as it was", async () => {
      // Text typed while the connection came up is part of what gets seeded.
      canvasDocuments["doc-456"] = { content: "typed while connecting" }
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      const readLocal = mockHydrate.mock.calls[0][3] as () => string
      expect(readLocal()).toBe("typed while connecting")
    })

    it("keeps this device's differing copy as a version before the shared text replaces it", async () => {
      canvasDocuments["doc-456"] = { content: "edited offline" }
      mockGetDocumentContent.mockReturnValue("the shared text")
      const { result } = renderHook(() =>
        useCollaborativeSession({ localCopyVersionLabel: "Local copy" })
      )

      await act(async () => {
        await result.current.connect("doc-456", "edited offline")
      })

      expect(mockSaveCanvasVersion).toHaveBeenCalledWith("doc-456", "Local copy")
      expect(mockUpdateCanvasDocument).toHaveBeenCalledWith(
        "doc-456",
        expect.objectContaining({ content: "the shared text" })
      )
      expect(mockSaveCanvasVersion.mock.invocationCallOrder[0]).toBeLessThan(
        mockUpdateCanvasDocument.mock.invocationCallOrder[0]
      )
    })

    it("saves no version when the copies already agree, or the local one is empty", async () => {
      canvasDocuments["doc-456"] = { content: "same" }
      mockGetDocumentContent.mockReturnValue("same")
      const { result, unmount } = renderHook(() => useCollaborativeSession())
      await act(async () => {
        await result.current.connect("doc-456", "same")
      })
      expect(mockSaveCanvasVersion).not.toHaveBeenCalled()
      expect(mockUpdateCanvasDocument).not.toHaveBeenCalled()
      unmount()

      canvasDocuments["doc-456"] = { content: "" }
      mockGetDocumentContent.mockReturnValue("from the plane")
      const second = renderHook(() => useCollaborativeSession())
      await act(async () => {
        await second.result.current.connect("doc-456", "")
      })
      expect(mockSaveCanvasVersion).not.toHaveBeenCalled()
      expect(mockUpdateCanvasDocument).toHaveBeenCalledWith(
        "doc-456",
        expect.objectContaining({ content: "from the plane" })
      )
    })

    it("settles locally with the text as it is once the plane has answered", async () => {
      // Typing continued while the plane was being asked. Seeding with what
      // `connect` was handed would bind the editor to older text.
      mockResolveTransport.mockImplementation(async () => {
        canvasDocuments["doc-456"] = { content: "typed meanwhile" }
        return null
      })
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(mockSeedLocally).toHaveBeenCalledWith("session-123", "typed meanwhile")
    })

    it("keeps a document seeded on this device off the plane", async () => {
      // Its Yjs items exist nowhere else: merging them with the plane's
      // state would put the text in twice.
      mockIsSeededLocally.mockReturnValue(true)
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      expect(mockResolveTransport).not.toHaveBeenCalled()
      expect(mockProviderConnect).not.toHaveBeenCalled()
      expect(mockMarkSessionReady).toHaveBeenCalledWith("session-123")
    })

    it("flushes the editor's waiting keystrokes before deciding what the document says", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      const readLocal = mockHydrate.mock.calls[0][3] as () => string
      mockFlushPendingEdits.mockClear()
      readLocal()
      expect(mockFlushPendingEdits).toHaveBeenCalledWith("doc-456")
    })

    describe("ending the session while it is still joining", () => {
      /** A promise the test resolves when it chooses. */
      function gate<T>() {
        let release!: (value: T) => void
        const promise = new Promise<T>((resolve) => {
          release = resolve
        })
        return { promise, release }
      }

      /**
       * The real store forgets a closed session, so `getSession` and
       * `getDocumentContent` answer as it does once `disconnect` has run.
       */
      function closeForReal() {
        mockCloseSession.mockImplementation(() => {
          mockGetSession.mockReturnValue(undefined)
          mockGetDocumentContent.mockReturnValue(null)
        })
      }

      it("does not touch the local document or leave a socket behind", async () => {
        closeForReal()
        canvasDocuments["doc-456"] = { content: "precious local text" }
        const hydration = gate<{ kind: string; latestSequence: number }>()
        mockHydrate.mockReturnValue(hydration.promise)
        const { result } = renderHook(() => useCollaborativeSession())

        let joining!: Promise<string>
        act(() => {
          joining = result.current.connect("doc-456", "precious local text")
        })
        await waitFor(() => expect(mockHydrate).toHaveBeenCalled())
        act(() => {
          result.current.disconnect()
        })
        await act(async () => {
          hydration.release({ kind: "joined", latestSequence: 3 })
          await joining
        })

        expect(mockUpdateCanvasDocument).not.toHaveBeenCalled()
        expect(mockSaveCanvasVersion).not.toHaveBeenCalled()
        expect(mockMarkSessionReady).not.toHaveBeenCalled()
        expect(mockProviderDisconnect).toHaveBeenCalled()
        expect(result.current.connectionState).toBe("disconnected")
      })

      it("opens nothing when the session ends before the socket does", async () => {
        closeForReal()
        const published = gate<unknown>()
        mockPublishDocument.mockReturnValue(published.promise)
        const { result } = renderHook(() => useCollaborativeSession())

        let joining!: Promise<string>
        act(() => {
          joining = result.current.connect("doc-456", "content")
        })
        await waitFor(() => expect(mockPublishDocument).toHaveBeenCalled())
        act(() => {
          result.current.disconnect()
        })
        await act(async () => {
          published.release({ id: "doc-1" })
          await joining
        })

        expect(mockProviderConnect).not.toHaveBeenCalled()
        expect(mockHydrate).not.toHaveBeenCalled()
      })

      it("lets the next connect bind instead of finding a stale provider", async () => {
        closeForReal()
        const hydration = gate<{ kind: string; latestSequence: number }>()
        mockHydrate.mockReturnValueOnce(hydration.promise)
        const { result } = renderHook(() => useCollaborativeSession())

        let first!: Promise<string>
        act(() => {
          first = result.current.connect("doc-456", "content")
        })
        await waitFor(() => expect(mockHydrate).toHaveBeenCalled())
        act(() => {
          result.current.disconnect()
        })
        await act(async () => {
          hydration.release({ kind: "joined", latestSequence: 1 })
          await first
        })

        mockGetSession.mockReturnValue(mockSession)
        mockGetDocumentContent.mockReturnValue("document content")
        await act(async () => {
          await result.current.connect("doc-456", "content")
        })
        expect(mockMarkSessionReady).toHaveBeenCalledWith("session-123")
      })

      it("reports nothing as an error when the user ended it and the join then failed", async () => {
        closeForReal()
        let fail!: (error: Error) => void
        mockHydrate.mockReturnValue(
          new Promise((_, reject) => {
            fail = reject
          })
        )
        const { result } = renderHook(() => useCollaborativeSession())

        let joining!: Promise<string>
        act(() => {
          joining = result.current.connect("doc-456", "content")
        })
        await waitFor(() => expect(mockHydrate).toHaveBeenCalled())
        act(() => {
          result.current.disconnect()
        })
        await act(async () => {
          fail(new Error("socket closed"))
          await joining
        })

        expect(result.current.connectionState).toBe("disconnected")
      })
    })

    it("resumes a reconnect from the sequence the provider has reached", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.connect("doc-456", "content")
      })

      const catchUp = providerConfigs[0]?.catchUp
      expect(catchUp).toBeDefined()
      await expect(catchUp!(4)).resolves.toBe(9)
      expect(mockCatchUp).toHaveBeenCalledWith(BINDING, expect.anything(), "session-123", 4)
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
      const { result } = renderHook(() => useCollaborativeSession())

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

  describe("shareTarget", () => {
    it("names the document, the workspace and the real org, and nothing else", async () => {
      // The old `shareSession` serialised the session, its owner, its
      // participants, its permission flags, the content and the operation log
      // into the URL. Permissions in a link are permissions the recipient can
      // edit.
      const { result } = renderHook(() => useCollaborativeSession())
      await act(async () => {
        await result.current.connect("doc-1", "content")
      })

      const target = await result.current.shareTarget()
      // Not the literal string "personal", which is what this returned while
      // there was no server to resolve a real organisation against.
      expect(target).toEqual({
        orgId: "org_acme",
        workspaceId: "ws-1",
        documentId: "doc-456",
      })
    })

    it("returns null when there is no session", async () => {
      const { result } = renderHook(() => useCollaborativeSession())
      await expect(result.current.shareTarget()).resolves.toBeNull()
    })

    it("returns null when this install has no plane to share onto", async () => {
      // A recipient is checked against org AND workspace membership, so a link
      // that can name neither is not a link worth handing out.
      mockResolveShareTarget.mockResolvedValue(null)
      const { result } = renderHook(() => useCollaborativeSession())
      await act(async () => {
        await result.current.connect("doc-1", "content")
      })
      await expect(result.current.shareTarget()).resolves.toBeNull()
    })
  })

  describe("joinSession", () => {
    it("reopens a session with no live provider instead of attaching it in place", async () => {
      // A session settled on this device holds text the plane never received.
      // Attaching it would merge a second copy of that text into the shared
      // document, so it is closed and a fresh one hydrates from the plane.
      mockResolveTransport.mockResolvedValueOnce(null)
      canvasDocuments["doc-456"] = { content: "current" }
      const { result } = renderHook(() => useCollaborativeSession())
      await act(async () => {
        await result.current.connect("doc-456", "content")
      })
      mockCreateSession.mockClear()

      await act(async () => {
        await result.current.joinSession("session-123")
      })

      expect(mockCloseSession).toHaveBeenCalledWith("session-123")
      expect(mockCreateSession).toHaveBeenCalledWith("doc-456", "current", { pending: true })
      expect(mockHydrate).toHaveBeenCalled()
    })

    it("only republishes state for a session that is already live", async () => {
      const { result } = renderHook(() => useCollaborativeSession())
      await act(async () => {
        await result.current.connect("doc-456", "content")
      })
      mockCreateSession.mockClear()

      await act(async () => {
        await result.current.joinSession("session-123")
      })

      expect(mockCreateSession).not.toHaveBeenCalled()
      expect(mockCloseSession).not.toHaveBeenCalled()
    })
  })

  describe("openDocumentSession", () => {
    it("mints a local session around content the caller already authorised", async () => {
      // `importSharedSession` took a JSON string off a link and let it define
      // the session, its participants and its permissions.
      const { result } = renderHook(() => useCollaborativeSession())

      let sessionId: string | null = null
      await act(async () => {
        sessionId = await result.current.openDocumentSession("doc-1", "hello")
      })

      expect(sessionId).toBe("session-123")
      expect(mockCreateSession).toHaveBeenCalledWith("doc-1", "hello")
      expect(result.current.session).toEqual(mockSession)
    })

    it("opens no transport, so viewing a shared link does not publish it", async () => {
      // The join page shows a document the caller already read locally.
      // Publishing it to an org as a side effect of looking at it would be a
      // write nobody asked for.
      const { result } = renderHook(() => useCollaborativeSession())

      await act(async () => {
        await result.current.openDocumentSession("doc-1", "hello")
      })

      expect(mockResolveTransport).not.toHaveBeenCalled()
      expect(mockPublishDocument).not.toHaveBeenCalled()
    })
  })

  describe("collaboration events", () => {
    it("should handle participant-joined event", async () => {
      const { result } = renderHook(() => useCollaborativeSession())

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
      const { result } = renderHook(() => useCollaborativeSession())

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
      const { result } = renderHook(() => useCollaborativeSession())

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
      const { result } = renderHook(() => useCollaborativeSession())

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
      const { result } = renderHook(() => useCollaborativeSession())

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
      const { result } = renderHook(() => useCollaborativeSession())

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
