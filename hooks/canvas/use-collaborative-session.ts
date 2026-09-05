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
  type WebSocketProviderConfig,
} from "@/lib/canvas/collaboration/websocket-provider"
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
  /** Identifiers for a share link, or `null` when the document cannot be shared. */
  shareTarget: () => CanvasShareTarget | null
  joinSession: (sessionId: string) => Promise<void>
  openDocumentSession: (documentId: string, content: string) => Promise<string | null>
}

export interface CollaborativeSessionConfig {
  websocketUrl?: string
  participantName?: string
  participantColor?: string
  autoReconnect?: boolean
  reconnectAttempts?: number
  /**
   * Server-minted proof; without it every remote Canvas transport remains
   * disabled.
   *
   * DORMANT BY DESIGN, for now: nothing in the app mints one yet, so
   * `connect`/`joinSession` never open a socket and Canvas collaboration is
   * local-only. That is the intended fail-closed state — a transport must not
   * open without a grant — but it means the remote half is unreachable rather
   * than merely unused. Purely local operations (`shareTarget`,
   * `openDocumentSession`) deliberately do NOT consult this field.
   */
  remoteAuthorization?: WebSocketProviderConfig["authorization"]
  onStateChange?: (state: CanvasCollaborationRuntimeState) => void
  onRemoteContentChange?: (content: string) => void
}

const DEFAULT_CONFIG: CollaborativeSessionConfig = {
  websocketUrl: "ws://localhost:8080/canvas",
  participantName: "Anonymous",
  participantColor: "#3b82f6",
  autoReconnect: true,
  reconnectAttempts: 5,
}

/**
 * The organisation a share link is addressed to.
 *
 * A recipient is checked against org AND workspace membership, so the org has
 * to be in the link. There is no synchronous accessor for the active
 * organisation today, and inventing a store for one would be a second source
 * of truth next to `lib/collab/`, so an install with no organisation addresses
 * its own implicit one. The collaboration server's Canvas routes are what will
 * replace this with the caller's real org, and they will also be the thing
 * that can reject a mismatch.
 */
export const PERSONAL_SHARE_ORG_ID = "personal"

function resolveShareOrgId(): string {
  return PERSONAL_SHARE_ORG_ID
}

export function useCollaborativeSession(
  config: CollaborativeSessionConfig = {}
): UseCollaborativeSessionReturn {
  const websocketUrl = config.websocketUrl ?? DEFAULT_CONFIG.websocketUrl
  const participantName = config.participantName ?? DEFAULT_CONFIG.participantName ?? "Anonymous"
  const participantColor = config.participantColor ?? DEFAULT_CONFIG.participantColor ?? "#3b82f6"
  const reconnectAttempts = config.reconnectAttempts ?? DEFAULT_CONFIG.reconnectAttempts ?? 5
  const remoteAuthorization = config.remoteAuthorization
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

      if (
        websocketUrl &&
        remoteAuthorization?.resourceId === documentId &&
        remoteAuthorization.expiresAt > Date.now()
      ) {
        try {
          const provider = new CanvasWebSocketProvider(store, {
            url: websocketUrl,
            reconnectAttempts,
            authorization: remoteAuthorization,
          })
          providerRef.current = provider

          attachProviderEvents(provider, handleCollaborationEvent)

          setConnectionState("connecting")
          await provider.connect(newSession.id, localParticipant)
        } catch (error) {
          log.error("Failed to connect WebSocket", error as Error)
          setConnectionState("disconnected")
        }
      }

      return newSession.id
    },
    [
      createLocalParticipant,
      handleCollaborationEvent,
      getParticipantId,
      reconnectAttempts,
      remoteAuthorization,
      websocketUrl,
    ]
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
   * Purely local, and it opens no transport, so it is not gated on a remote
   * grant. The gate that belongs to `remoteAuthorization` stays on
   * `connect` / `joinSession`, which are the calls that open a socket.
   */
  const shareTarget = useCallback((): CanvasShareTarget | null => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return null
    const current = storeRef.current.getSession(sessionId)
    if (!current) return null

    const document = useArtifactStore.getState().getCanvasDocumentForWorkspace(current.documentId)
    // A document with no workspace cannot be addressed by a link: the
    // recipient's membership is checked against the workspace, and there would
    // be nothing to check.
    if (!document?.projectId) return null

    return {
      orgId: resolveShareOrgId(),
      workspaceId: document.projectId,
      documentId: document.id,
    }
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

        if (
          websocketUrl &&
          providerRef.current === null &&
          remoteAuthorization?.resourceId === existingSession.documentId &&
          remoteAuthorization.expiresAt > Date.now()
        ) {
          try {
            const provider = new CanvasWebSocketProvider(store, {
              url: websocketUrl,
              reconnectAttempts,
              authorization: remoteAuthorization,
            })
            providerRef.current = provider

            attachProviderEvents(provider, handleCollaborationEvent)

            setConnectionState("connecting")
            await provider.connect(sessionId, currentParticipant)
            provider.requestSync()
          } catch (error) {
            log.error("Failed to join session", error as Error)
            setConnectionState("error")
          }
        }
      }
    },
    [
      createLocalParticipant,
      handleCollaborationEvent,
      getParticipantId,
      onRemoteContentChange,
      reconnectAttempts,
      remoteAuthorization,
      websocketUrl,
    ]
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
      const authorization =
        remoteAuthorization && remoteAuthorization.expiresAt > Date.now()
          ? remoteAuthorization
          : null
      // When a grant IS present it still pins the session to the document it
      // was minted for, so an authorised session cannot be pointed at another.
      if (authorization && authorization.resourceId !== documentId) return null

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
    [createLocalParticipant, onRemoteContentChange, remoteAuthorization]
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
