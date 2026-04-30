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
import { loggers } from "@/lib/logger"

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
  shareSession: () => string | null
  joinSession: (sessionId: string) => Promise<void>
  importSharedSession: (serialized: string) => Promise<string | null>
}

export interface CollaborativeSessionConfig {
  websocketUrl?: string
  participantName?: string
  participantColor?: string
  autoReconnect?: boolean
  reconnectAttempts?: number
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

export function useCollaborativeSession(
  config: CollaborativeSessionConfig = {}
): UseCollaborativeSessionReturn {
  const websocketUrl = config.websocketUrl ?? DEFAULT_CONFIG.websocketUrl
  const participantName = config.participantName ?? DEFAULT_CONFIG.participantName ?? "Anonymous"
  const participantColor = config.participantColor ?? DEFAULT_CONFIG.participantColor ?? "#3b82f6"
  const reconnectAttempts = config.reconnectAttempts ?? DEFAULT_CONFIG.reconnectAttempts ?? 5
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

      if (websocketUrl) {
        try {
          const provider = new CanvasWebSocketProvider(store, {
            url: websocketUrl,
            reconnectAttempts,
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

  const shareSession = useCallback((): string | null => {
    if (!sessionIdRef.current) return null
    return storeRef.current.serializeState(sessionIdRef.current)
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

        if (websocketUrl && providerRef.current === null) {
          try {
            const provider = new CanvasWebSocketProvider(store, {
              url: websocketUrl,
              reconnectAttempts,
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
      websocketUrl,
    ]
  )

  const importSharedSession = useCallback(
    async (serialized: string): Promise<string | null> => {
      const store = storeRef.current
      const sessionId = store.deserializeState(serialized)
      if (!sessionId) {
        return null
      }

      const existingSession = store.getSession(sessionId)
      if (!existingSession) {
        return null
      }

      sessionIdRef.current = sessionId
      setSession(existingSession)
      setParticipants(existingSession.participants)
      setRemoteCursors([])

      const latestContent = store.getDocumentContent(sessionId)
      if (latestContent !== null) {
        onRemoteContentChange?.(latestContent)
      }

      return sessionId
    },
    [onRemoteContentChange]
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
      sharePayload: session ? storeRef.current.serializeState(session.id) : null,
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
    shareSession,
    joinSession,
    importSharedSession,
  }
}

export default useCollaborativeSession
