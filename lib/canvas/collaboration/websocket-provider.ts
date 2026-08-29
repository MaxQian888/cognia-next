/**
 * WebSocket Provider - Real-time sync for collaborative editing
 */

import type {
  Participant,
  CursorPosition,
  LineRange,
  CollaborationEvent,
  CollaborationEventType,
} from "@/types/canvas/collaboration"
import { CanvasCRDTStore, type CRDTOperation } from "./crdt-store"
import { loggers } from "@cognia/logging"

const log = loggers.app

export interface WebSocketMessage {
  type: "operation" | "cursor" | "selection" | "presence" | "sync" | "error"
  sessionId: string
  participantId: string
  data: unknown
  timestamp: number
}

export interface WebSocketProviderConfig {
  url: string
  /** Short-lived server-minted proof bound to the human subject and canvas resource. */
  authorization?: {
    token: string
    subjectId: string
    resourceId: string
    expiresAt: number
  }
  reconnectAttempts?: number
  reconnectInterval?: number
  heartbeatInterval?: number
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error"

export class CanvasWebSocketProvider {
  private ws: WebSocket | null = null
  private crdtStore: CanvasCRDTStore
  private config: WebSocketProviderConfig
  private sessionId: string | null = null
  private participantId: string | null = null
  private connectionState: ConnectionState = "disconnected"
  private reconnectAttempts = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private eventListeners: Map<CollaborationEventType, Set<(event: CollaborationEvent) => void>> =
    new Map()
  private messageQueue: WebSocketMessage[] = []

  constructor(crdtStore: CanvasCRDTStore, config: WebSocketProviderConfig) {
    this.crdtStore = crdtStore
    this.config = {
      reconnectAttempts: 5,
      reconnectInterval: 1000,
      heartbeatInterval: 30000,
      ...config,
    }
  }

  async connect(sessionId: string, participant: Participant): Promise<void> {
    const authorization = this.config.authorization
    if (
      !authorization?.token ||
      !authorization.subjectId ||
      !authorization.resourceId ||
      authorization.expiresAt <= Date.now()
    ) {
      throw new Error("CANVAS_REMOTE_AUTH_REQUIRED")
    }
    this.sessionId = sessionId
    this.participantId = participant.id
    this.connectionState = "connecting"

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url, ["cognia.canvas.v1", authorization.token])

        this.ws.onopen = () => {
          this.connectionState = "connected"
          this.reconnectAttempts = 0
          this.startHeartbeat()
          this.flushMessageQueue()

          this.send({
            type: "presence",
            sessionId,
            participantId: participant.id,
            data: {
              action: "join",
              participant,
              subjectId: authorization.subjectId,
              resourceId: authorization.resourceId,
            },
            timestamp: Date.now(),
          })

          this.emitEvent({ type: "connected", timestamp: new Date() })
          resolve()
        }

        this.ws.onclose = () => {
          this.handleDisconnect()
        }

        this.ws.onerror = (error) => {
          this.connectionState = "error"
          this.emitEvent({
            type: "error",
            timestamp: new Date(),
            data: error,
          })
          reject(error)
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }
      } catch (error) {
        this.connectionState = "error"
        reject(error)
      }
    })
  }

  disconnect(): void {
    this.stopHeartbeat()

    if (this.ws && this.sessionId && this.participantId) {
      this.send({
        type: "presence",
        sessionId: this.sessionId,
        participantId: this.participantId,
        data: { action: "leave" },
        timestamp: Date.now(),
      })
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.connectionState = "disconnected"
    this.emitEvent({ type: "disconnected", timestamp: new Date() })
  }

  broadcastOperation(operation: CRDTOperation): void {
    if (!this.sessionId || !this.participantId) return

    this.send({
      type: "operation",
      sessionId: this.sessionId,
      participantId: this.participantId,
      data: this.serializeOperation(operation),
      timestamp: Date.now(),
    })
  }

  broadcastCursor(cursor: CursorPosition): void {
    if (!this.sessionId || !this.participantId) return

    this.send({
      type: "cursor",
      sessionId: this.sessionId,
      participantId: this.participantId,
      data: cursor,
      timestamp: Date.now(),
    })
  }

  broadcastSelection(selection: LineRange | null): void {
    if (!this.sessionId || !this.participantId) return

    this.send({
      type: "selection",
      sessionId: this.sessionId,
      participantId: this.participantId,
      data: selection,
      timestamp: Date.now(),
    })
  }

  requestSync(): void {
    if (!this.sessionId || !this.participantId) return

    this.send({
      type: "sync",
      sessionId: this.sessionId,
      participantId: this.participantId,
      data: { action: "request" },
      timestamp: Date.now(),
    })
  }

  on(eventType: CollaborationEventType, callback: (event: CollaborationEvent) => void): () => void {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, new Set())
    }
    this.eventListeners.get(eventType)!.add(callback)

    return () => {
      this.eventListeners.get(eventType)?.delete(callback)
    }
  }

  getConnectionState(): ConnectionState {
    return this.connectionState
  }

  private send(message: WebSocketMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    } else {
      this.messageQueue.push(message)
    }
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const message = this.messageQueue.shift()
      if (message) {
        this.ws.send(JSON.stringify(message))
      }
    }
  }

  private handleMessage(data: string): void {
    try {
      const message: WebSocketMessage = JSON.parse(data)

      switch (message.type) {
        case "operation":
          this.handleRemoteOperation(message)
          break
        case "cursor":
          this.handleRemoteCursor(message)
          break
        case "selection":
          this.handleRemoteSelection(message)
          break
        case "presence":
          this.handlePresence(message)
          break
        case "sync":
          this.handleSync(message)
          break
        case "error":
          this.emitEvent({
            type: "error",
            timestamp: new Date(),
            data: message.data,
          })
          break
      }
    } catch (error) {
      log.error("Failed to parse WebSocket message", error as Error)
    }
  }

  private handleRemoteOperation(message: WebSocketMessage): void {
    if (!this.sessionId || message.participantId === this.participantId) return

    const operation = this.deserializeOperation(message.data)
    this.crdtStore.applyRemoteUpdate(this.sessionId, operation)

    this.emitEvent({
      type: "content-updated",
      timestamp: new Date(),
      participantId: message.participantId,
      data: operation,
    })
  }

  private handleRemoteCursor(message: WebSocketMessage): void {
    if (message.participantId === this.participantId) return

    this.emitEvent({
      type: "cursor-moved",
      timestamp: new Date(),
      participantId: message.participantId,
      data: message.data,
    })
  }

  private handleRemoteSelection(message: WebSocketMessage): void {
    if (message.participantId === this.participantId) return

    this.emitEvent({
      type: "selection-changed",
      timestamp: new Date(),
      participantId: message.participantId,
      data: message.data,
    })
  }

  private handlePresence(message: WebSocketMessage): void {
    const presenceData = message.data as { action: string; participant?: Participant }

    if (presenceData.action === "join" && presenceData.participant) {
      this.emitEvent({
        type: "participant-joined",
        timestamp: new Date(),
        participantId: message.participantId,
        data: presenceData.participant,
      })
    } else if (presenceData.action === "leave") {
      this.emitEvent({
        type: "participant-left",
        timestamp: new Date(),
        participantId: message.participantId,
      })
    }
  }

  private handleSync(message: WebSocketMessage): void {
    const syncData = message.data as { action: string; state?: string }

    if (syncData.action === "response" && syncData.state && this.sessionId) {
      this.crdtStore.deserializeState(syncData.state)
    }
  }

  private handleDisconnect(): void {
    this.stopHeartbeat()
    this.connectionState = "disconnected"

    if (this.reconnectAttempts < (this.config.reconnectAttempts || 5)) {
      this.connectionState = "reconnecting"
      this.reconnectAttempts++

      setTimeout(() => {
        if (this.sessionId && this.participantId) {
          this.connect(this.sessionId, {
            id: this.participantId,
            name: "Reconnecting...",
            color: "#888",
            lastActive: new Date(),
            isOnline: true,
          }).catch(() => {
            this.handleDisconnect()
          })
        }
      }, this.config.reconnectInterval)
    } else {
      this.emitEvent({ type: "disconnected", timestamp: new Date() })
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && this.sessionId && this.participantId) {
        this.send({
          type: "presence",
          sessionId: this.sessionId,
          participantId: this.participantId,
          data: { action: "heartbeat" },
          timestamp: Date.now(),
        })
      }
    }, this.config.heartbeatInterval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private emitEvent(event: CollaborationEvent): void {
    const listeners = this.eventListeners.get(event.type)
    if (listeners) {
      for (const callback of listeners) {
        callback(event)
      }
    }
  }

  private serializeOperation(operation: CRDTOperation): unknown {
    return {
      ...operation,
      vectorClock: Array.from(operation.vectorClock.entries()),
    }
  }

  private deserializeOperation(data: unknown): CRDTOperation {
    const raw = data as {
      id: string
      type: "insert" | "delete"
      position: number
      text?: string
      length?: number
      origin: string
      timestamp: number
      vectorClock: [string, number][]
    }

    return {
      ...raw,
      vectorClock: new Map(raw.vectorClock),
    }
  }
}

export default CanvasWebSocketProvider
