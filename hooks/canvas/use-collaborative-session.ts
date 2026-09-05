/**
 * useCollaborativeSession - Hook for real-time collaborative editing
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type {
  Participant,
  CollaborativeSession,
  RemoteCursor,
  CursorPosition,
  CollaborationEvent,
  LineRange,
} from "@/types/canvas/collaboration"
import type { CanvasCollaborationSessionState } from "@/types/canvas/collaboration"
import { CanvasCRDTStore, crdtStore } from "@/lib/canvas/collaboration/crdt-store"
import {
  CanvasWebSocketProvider,
  type ConnectionState,
} from "@/lib/canvas/collaboration/websocket-provider"
import {
  publishCanvasDocument,
  resolveCanvasShareTarget,
  resolveCanvasTransport,
  type CanvasTransportBinding,
} from "@/lib/canvas/collaboration/canvas-transport"
import { loggers } from "@cognia/logging"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { CanvasShareTarget } from "@/lib/canvas/collaboration/share-link"

const log = loggers.app

const PROVIDER_EVENTS = [
  "connected",
  "disconnected",
  "participant-joined",
  "participant-left",
  "cursor-moved",
  "selection-changed",
  "content-updated",
  "error",
] as const

function attachProviderEvents(
  provider: CanvasWebSocketProvider,
  handler: (event: CollaborationEvent) => void
): void {
  for (const event of PROVIDER_EVENTS) {
    provider.on(event, handler)
  }
}

export type CanvasCollaborationRuntimeState = CanvasCollaborationSessionState

export interface UseCollaborativeSessionReturn {
  session: CollaborativeSession | null
  participants: Participant[]
  remoteCursors: RemoteCursor[]
  connectionState: ConnectionState
  isConnected: boolean
  isConnecting: boolean
  localParticipant: Participant | null
  connect: (documentId: string, content: string) => Promise<string>
  disconnect: () => void
  updateContent: (position: number, text: string, type: "insert" | "delete") => void
  updateCursor: (cursor: CursorPosition) => void
  updateSelection: (selection: LineRange | null) => void
  getContent: () => string | null
  /**
   * Identifiers for a share link, or `null` when the document cannot be
   * shared.
   *
   * Asynchronous because the organisation comes from the sign-in binding
   * rather than from a constant. It used to name an org literally called
   * `"personal"`, which no server could ever have honoured.
   */
  shareTarget: () => Promise<CanvasShareTarget | null>
  joinSession: (sessionId: string) => Promise<void>
  openDocumentSession: (documentId: string, content: string) => Promise<string | null>
}

export interface CollaborativeSessionConfig {
  participantName?: string
  participantColor?: string
  autoReconnect?: boolean
  reconnectAttempts?: number
  /**
   * Where this document lives on the collaboration plane, and how to open a
   * socket to it. Injectable so the remote path can be driven in a test
   * without a server.
   *
   * `null` is the ordinary answer on an install with no plane configured, and
   * it keeps Canvas local rather than failing. The remote half no longer
   * depends on a credential nothing mints: `resolveCanvasTransport` mints a
   * fresh single-use ticket per connection attempt.
   */
  resolveTransport?: (documentId: string) => Promise<CanvasTransportBinding | null>
  onStateChange?: (state: CanvasCollaborationRuntimeState) => void
  onRemoteContentChange?: (content: string) => void
}

const DEFAULT_CONFIG: CollaborativeSessionConfig = {
  participantName: "Anonymous",
  participantColor: "#3b82f6",
  autoReconnect: true,
  reconnectAttempts: 5,
}

export function useCollaborativeSession(
  config: CollaborativeSessionConfig = {}
): UseCollaborativeSessionReturn {
  const participantName = config.participantName ?? DEFAULT_CONFIG.participantName ?? "Anonymous"
  const participantColor = config.participantColor ?? DEFAULT_CONFIG.participantColor ?? "#3b82f6"
  const reconnectAttempts = config.reconnectAttempts ?? DEFAULT_CONFIG.reconnectAttempts ?? 5
  const resolveTransport = config.resolveTransport ?? resolveCanvasTransport
  const onStateChange = config.onStateChange
  const onRemoteContentChange = config.onRemoteContentChange

  const [session, setSession] = useState<CollaborativeSession | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([])
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected")
  const [localParticipant, setLocalParticipant] = useState<Participant | null>(null)

  const storeRef = useRef<CanvasCRDTStore>(crdtStore)
  const providerRef = useRef<CanvasWebSocketProvider | null>(null)
  const participantIdRef = useRef<string | null>(null)
  const participantsRef = useRef<Participant[]>([])
  // Generate participant ID only once on first access
  const getParticipantId = useCallback((): string => {
    if (!participantIdRef.current) {
      participantIdRef.current = `participant-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
    return participantIdRef.current
  }, [])
  const sessionIdRef = useRef<string | null>(null)

  const createLocalParticipant = useCallback(
    (): Participant => ({
      id: getParticipantId(),
      name: participantName,
      color: participantColor,
      lastActive: new Date(),
      isOnline: true,
    }),
    [participantColor, participantName, getParticipantId]
  )

  const handleCollaborationEvent = useCallback(
    (event: CollaborationEvent) => {
      switch (event.type) {
        case "participant-joined":
          if (event.data) {
            setParticipants((prev) => {
              const existing = prev.find((p) => p.id === (event.data as Participant).id)
              if (existing) return prev
              return [...prev, event.data as Participant]
            })
          }
          break

        case "participant-left":
          setParticipants((prev) => prev.filter((p) => p.id !== event.participantId))
          setRemoteCursors((prev) => prev.filter((c) => c.participantId !== event.participantId))
          break

        case "cursor-moved":
          if (event.participantId && event.data) {
            const cursorData = event.data as CursorPosition
            setRemoteCursors((prev) => {
              const existing = prev.find((c) => c.participantId === event.participantId)
              const participant = participantsRef.current.find((p) => p.id === event.participantId)

              const cursor: RemoteCursor = {
                participantId: event.participantId!,
                position: cursorData,
                color: participant?.color || "#888",
                name: participant?.name || "Unknown",
              }

              if (existing) {
                return prev.map((c) => (c.participantId === event.participantId ? cursor : c))
              }
              return [...prev, cursor]
            })
          }
          break

        case "selection-changed":
          if (event.participantId) {
            const participantId = event.participantId
            const selectionData = (event.data as LineRange | null) || undefined
            setRemoteCursors((prev) => {
              const participant = participantsRef.current.find((p) => p.id === participantId)
              const existing = prev.find((cursor) => cursor.participantId === participantId)
              if (!existing) {
                return [
                  ...prev,
                  {
                    participantId,
                    position: participant?.cursor || { line: 1, column: 1 },
                    selection: selectionData,
                    color: participant?.color || "#888",
                    name: participant?.name || "Unknown",
                  },
                ]
              }

              return prev.map((cursor) =>
                cursor.participantId === participantId
                  ? { ...cursor, selection: selectionData }
                  : cursor
              )
            })
          }
          break

        case "content-updated":
          if (sessionIdRef.current) {
            const latestContent = storeRef.current.getDocumentContent(sessionIdRef.current)
            if (latestContent !== null) {
              onRemoteContentChange?.(latestContent)
            }
          }
          break

        case "connected":
          setConnectionState("connected")
          break

        case "disconnected":
          setConnectionState("disconnected")
          break

        case "error":
          setConnectionState("error")
          log.error("Canvas collaboration error", event.data as Error)
          break
      }
    },
    [onRemoteContentChange]
  )

  /**
   * Bring one session onto the plane, when there is a plane to bring it onto.
   *
   * Both entry points used to carry their own copy of this, differing only in
   * whether they called `requestSync` afterwards. They now differ in exactly
   * that, and nothing else.
   */
  const attachTransport = useCallback(
    async (
      sessionId: string,
      documentId: string,
      participant: Participant,
      options: { sync: boolean }
    ): Promise<void> => {
      if (providerRef.current) return
      let binding: CanvasTransportBinding | null = null
      try {
        binding = await resolveTransport(documentId)
      } catch (error) {
        // A plane that is configured but unreachable is not a reason to lose
        // the local document.
        log.warn("canvas transport unavailable", { error: String(error) })
        return
      }
      if (!binding) return

      const document = useArtifactStore.getState().getCanvasDocumentForWorkspace(documentId)
      try {
        // The socket needs a row to attach to, and a document created locally
        // has none until somebody with write access publishes it.
        const published = await publishCanvasDocument(binding, {
          title: document?.title ?? "Untitled",
          language: document?.language ?? "markdown",
        })
        if (!published) return

        const provider = new CanvasWebSocketProvider(storeRef.current, {
          openSocket: binding.openSocket,
          reconnectAttempts,
        })
        providerRef.current = provider
        attachProviderEvents(provider, handleCollaborationEvent)

        setConnectionState("connecting")
        await provider.connect(sessionId, participant)
        if (options.sync) provider.requestSync()
      } catch (error) {
        log.error("Failed to open the Canvas transport", error as Error)
        providerRef.current = null
        setConnectionState("error")
      }
    },
    [handleCollaborationEvent, reconnectAttempts, resolveTransport]
  )

  const connect = useCallback(
    async (documentId: string, content: string): Promise<string> => {
      const store = storeRef.current

      const newSession = store.createSession(documentId, content)
      sessionIdRef.current = newSession.id
      setSession(newSession)

      const localParticipant = createLocalParticipant()
      store.joinSession(newSession.id, localParticipant)
      store.setLocalParticipantId(getParticipantId())
      setLocalParticipant(localParticipant)
      setParticipants([localParticipant])

      // The opener syncs too. Its local content seeds the session, but the
      // plane may already hold edits from another device, and Yjs merging the
      // two is exactly right where picking one would lose work.
      await attachTransport(newSession.id, documentId, localParticipant, { sync: true })

      return newSession.id
    },
    [attachTransport, createLocalParticipant, getParticipantId]
  )

  const disconnect = useCallback(() => {
    if (providerRef.current) {
      providerRef.current.disconnect()
      providerRef.current = null
    }

    if (sessionIdRef.current) {
      storeRef.current.leaveSession(sessionIdRef.current, getParticipantId())
      storeRef.current.closeSession(sessionIdRef.current)
      sessionIdRef.current = null
    }

    setSession(null)
    setParticipants([])
    setRemoteCursors([])
    setLocalParticipant(null)
    setConnectionState("disconnected")
  }, [getParticipantId])

  const updateContent = useCallback(
    (position: number, text: string, type: "insert" | "delete") => {
      if (!sessionIdRef.current) return

      const operation = storeRef.current.applyLocalUpdate(sessionIdRef.current, {
        type,
        position,
        text: type === "insert" ? text : undefined,
        length: type === "delete" ? text.length : undefined,
        origin: getParticipantId(),
      })

      if (providerRef.current) {
        providerRef.current.broadcastOperation(operation)
      }
    },
    [getParticipantId]
  )

  const updateCursor = useCallback(
    (cursor: CursorPosition) => {
      if (!sessionIdRef.current) return

      storeRef.current.updateCursor(sessionIdRef.current, getParticipantId(), cursor)

      if (providerRef.current) {
        providerRef.current.broadcastCursor(cursor)
      }
    },
    [getParticipantId]
  )

  const updateSelection = useCallback((selection: LineRange | null) => {
    if (!sessionIdRef.current || !providerRef.current) return
    providerRef.current.broadcastSelection(selection)
  }, [])

  const getContent = useCallback((): string | null => {
    if (!sessionIdRef.current) return null
    return storeRef.current.getDocumentContent(sessionIdRef.current)
  }, [])

  /**
   * What a share link is allowed to name: the document, and the workspace and
   * organisation it belongs to.
   *
   * This replaced `shareSession`, which serialised the session, its owner, its
   * participants, its permission flags, the document content and the whole
   * operation log into the URL. Permissions in a link are permissions the
   * recipient can edit, and the payload landed in an unvalidated `JSON.parse`
   * that installed whatever session it described.
   *
   * Opens no transport, but it does need the organisation, which comes from
   * the sign-in binding. `null` when this install has no plane, when nobody is
   * signed in, or when the document is filed under no workspace: a recipient's
   * membership is checked against org and workspace, and a link naming neither
   * could never be honoured.
   */
  const shareTarget = useCallback(async (): Promise<CanvasShareTarget | null> => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return null
    const current = storeRef.current.getSession(sessionId)
    if (!current) return null
    return resolveCanvasShareTarget(current.documentId)
  }, [])

  const joinSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const store = storeRef.current
      const existingSession = store.getSession(sessionId)

      if (existingSession) {
        sessionIdRef.current = sessionId
        setSession(existingSession)

        const currentParticipant = createLocalParticipant()
        store.joinSession(sessionId, currentParticipant)
        store.setLocalParticipantId(getParticipantId())
        setLocalParticipant(currentParticipant)
        setParticipants(existingSession.participants)

        const latestContent = store.getDocumentContent(sessionId)
        if (latestContent !== null) {
          onRemoteContentChange?.(latestContent)
        }

        await attachTransport(sessionId, existingSession.documentId, currentParticipant, {
          sync: true,
        })
      }
    },
    [attachTransport, createLocalParticipant, getParticipantId, onRemoteContentChange]
  )

  /**
   * Open a session for a document this client has already authorised and
   * loaded.
   *
   * This replaced `importSharedSession(serialized)`, which took a JSON string
   * off a share link and let it define the session, its participants and its
   * permissions. Nothing about a session comes off the wire now: the caller
   * says which document, having already checked it may open it, and the
   * session is minted locally around the content it read.
   */
  const openDocumentSession = useCallback(
    async (documentId: string, content: string): Promise<string | null> => {
      const store = storeRef.current
      // Deliberately local. The caller has already checked it may open this
      // document, and opening a transport is `connect` / `joinSession`, not
      // this. Keeping them separate is what lets the join page show a
      // document without publishing it to an org as a side effect.
      const created = store.createSession(documentId, content)
      const participant = createLocalParticipant()
      store.setLocalParticipantId(participant.id)
      store.joinSession(created.id, participant)
      setLocalParticipant(participant)

      sessionIdRef.current = created.id
      setSession(created)
      setParticipants([...created.participants])
      setRemoteCursors([])

      const latestContent = store.getDocumentContent(created.id)
      if (latestContent !== null) {
        onRemoteContentChange?.(latestContent)
      }

      return created.id
    },
    [createLocalParticipant, onRemoteContentChange]
  )

  useEffect(() => {
    participantsRef.current = participants
  }, [participants])

  useEffect(() => {
    if (!onStateChange) {
      return
    }

    onStateChange({
      sessionId: session?.id ?? null,
      documentId: session?.documentId ?? null,
      connectionState,
      recoveryState:
        connectionState === "connected" || connectionState === "connecting" ? "live" : "local-copy",
      participants,
      remoteCursors,
      localParticipant,
      lastEventAt: new Date(),
      lastSyncedAt: connectionState === "connected" ? new Date() : undefined,
      // The document's state, not the session. `serializeState` used to put
      // the session, its participants and its permissions in here, and this
      // field is published to whoever renders the collaboration state.
      sharePayload: session ? storeRef.current.encodeSnapshot(session.id) : null,
      shareUrl: session?.shareLink ?? null,
      recoveryReason: connectionState === "error" ? "Transport error" : undefined,
    })
  }, [connectionState, localParticipant, onStateChange, participants, remoteCursors, session])

  useEffect(() => {
    return () => {
      disconnect()
    }
  }, [disconnect])

  return {
    session,
    participants,
    remoteCursors,
    connectionState,
    isConnected: connectionState === "connected",
    isConnecting: connectionState === "connecting",
    localParticipant,
    connect,
    disconnect,
    updateContent,
    updateCursor,
    updateSelection,
    getContent,
    shareTarget,
    joinSession,
    openDocumentSession,
  }
}

export default useCollaborativeSession
