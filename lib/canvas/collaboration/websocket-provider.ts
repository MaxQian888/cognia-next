/**
 * The live half of Canvas collaboration.
 *
 * # It no longer knows where the server is
 *
 * This used to hold a `url` and an `authorization.token` and call
 * `new WebSocket(url, ["cognia.canvas.v1", token])` itself. Three things were
 * wrong with that.
 *
 * A bare `WebSocket` in the renderer misses the desktop proxy settings
 * entirely, so a machine that reaches the plane over a proxy could not open a
 * Canvas socket at all while every other collaboration call worked.
 *
 * The token was reused on every reconnect. The server's tickets are single-use
 * and live 30 seconds, so the first reconnect would have failed, and so would
 * every one after it.
 *
 * And the URL was configuration a caller supplied, which is what let the old
 * join page point the transport at an arbitrary host.
 *
 * So the provider now takes `openSocket`, a factory that is called afresh for
 * the first connection and for each retry. `CollabClient.openCanvasStream`
 * mints a new ticket per call and opens the socket through the platform
 * transport, which answers all three.
 *
 * # Fail closed
 *
 * No factory means no socket. A Canvas with no collaboration server configured
 * stays local rather than half-connecting.
 */

import type {
  Participant,
  CursorPosition,
  LineRange,
  CollaborationEvent,
  CollaborationEventType,
} from "@/types/canvas/collaboration"
import type { PlatformWebSocket, PlatformWebSocketHandlers } from "@/lib/network/platform-websocket"
import { CanvasCRDTStore, type CRDTOperation } from "./crdt-store"
import { loggers } from "@cognia/logging"

const log = loggers.canvas

export interface WebSocketMessage {
  type: "operation" | "cursor" | "selection" | "presence" | "sync" | "error"
  sessionId: string
  participantId: string
  data: unknown
  timestamp: number
}

/**
 * Opens one socket for one document.
 *
 * Called again for every reconnect attempt, so whatever short-lived credential
 * the transport needs is minted per call rather than captured once.
 */
export type CanvasSocketFactory = (
  handlers: PlatformWebSocketHandlers
) => Promise<PlatformWebSocket>

export interface WebSocketProviderConfig {
  openSocket?: CanvasSocketFactory
  reconnectAttempts?: number
  reconnectInterval?: number
  heartbeatInterval?: number
}

/** Thrown when a socket is asked for on an install with no server configured. */
export class CanvasTransportUnavailableError extends Error {
  readonly code = "CANVAS_REMOTE_AUTH_REQUIRED" as const

  constructor() {
    super("Canvas collaboration has no configured transport")
    this.name = "CanvasTransportUnavailableError"
  }
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error"

export class CanvasWebSocketProvider {
  private socket: PlatformWebSocket | null = null
  private crdtStore: CanvasCRDTStore
  private config: WebSocketProviderConfig
  private sessionId: string | null = null
  private participantId: string | null = null
  private participant: Participant | null = null
  private connectionState: ConnectionState = "disconnected"
  private reconnectAttempts = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private eventListeners: Map<CollaborationEventType, Set<(event: CollaborationEvent) => void>> =
    new Map()
  private messageQueue: WebSocketMessage[] = []
  /** Set by `disconnect`, so a deliberate close does not schedule a retry. */
  private closing = false

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
    if (!this.config.openSocket) throw new CanvasTransportUnavailableError()
    this.closing = false
    this.sessionId = sessionId
    this.participantId = participant.id
    this.participant = participant
    this.connectionState = "connecting"

    try {
      this.socket = await this.config.openSocket({
        onMessage: (data) => this.handleMessage(data),
        onClose: () => this.handleDisconnect(),
        onError: (message) => {
          this.connectionState = "error"
          this.emitEvent({ type: "error", timestamp: new Date(), data: message })
        },
      })
    } catch (error) {
      this.connectionState = "error"
      this.emitEvent({ type: "error", timestamp: new Date(), data: error })
      throw error
    }

    this.connectionState = "connected"
    this.reconnectAttempts = 0
    this.startHeartbeat()

    // Announced before the queue drains, so a peer sees who is typing rather
    // than edits from a participant it has never heard of.
    await this.dispatch({
      type: "presence",
      sessionId,
      participantId: participant.id,
      data: { action: "join", participant },
      timestamp: Date.now(),
    })
    await this.flushMessageQueue()
    this.emitEvent({ type: "connected", timestamp: new Date() })
  }

  disconnect(): void {
    this.closing = true
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.socket && this.sessionId && this.participantId) {
      void this.dispatch({
        type: "presence",
        sessionId: this.sessionId,
        participantId: this.participantId,
        data: { action: "leave" },
        timestamp: Date.now(),
      })
    }

    const socket = this.socket
    this.socket = null
    void socket?.close()

    this.connectionState = "disconnected"
    this.emitEvent({ type: "disconnected", timestamp: new Date() })
  }

  broadcastOperation(operation: CRDTOperation): void {
    if (!this.sessionId || !this.participantId) return
    void this.dispatch({
      type: "operation",
      sessionId: this.sessionId,
      participantId: this.participantId,
      data: operation,
      timestamp: Date.now(),
    })
  }

  broadcastCursor(cursor: CursorPosition): void {
    if (!this.sessionId || !this.participantId) return
    void this.dispatch({
      type: "cursor",
      sessionId: this.sessionId,
      participantId: this.participantId,
      data: cursor,
      timestamp: Date.now(),
    })
  }

  broadcastSelection(selection: LineRange | null): void {
    if (!this.sessionId || !this.participantId) return
    void this.dispatch({
      type: "selection",
      sessionId: this.sessionId,
      participantId: this.participantId,
      data: selection,
      timestamp: Date.now(),
    })
  }

  /**
   * Ask for everything after `since`.
   *
   * The server answers with the baseline when this client is behind it, then
   * each later update, as separate frames. Applying them one at a time is
   * equivalent to applying a merged update, which is what lets the server relay
   * Yjs without decoding it.
   */
  requestSync(since = 0): void {
    if (!this.sessionId || !this.participantId) return
    void this.dispatch({
      type: "sync",
      sessionId: this.sessionId,
      participantId: this.participantId,
      data: { action: "request", since },
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

  private async dispatch(message: WebSocketMessage): Promise<void> {
    if (!this.socket || this.connectionState !== "connected") {
      this.messageQueue.push(message)
      return
    }
    try {
      await this.socket.send(JSON.stringify(message))
    } catch (error) {
      // A send that fails means the socket is already gone. Queue the frame so
      // the reconnect delivers it rather than dropping the edit.
      this.messageQueue.push(message)
      log.warn("canvas frame not sent", { error: String(error) })
    }
  }

  private async flushMessageQueue(): Promise<void> {
    const pending = this.messageQueue
    this.messageQueue = []
    for (const message of pending) {
      await this.dispatch(message)
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
    if (!operation) return
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

  /**
   * A state frame, merged into the session we are already in.
   *
   * This used to call `deserializeState`, which `JSON.parse`d the frame and
   * installed whatever session and document it described, with no validation.
   * Any frame typed `"sync"` could therefore replace the session, its
   * participants and its permissions. A snapshot is opaque bytes now, and it
   * can only merge into the document of the session this provider is already
   * connected to.
   */
  private handleSync(message: WebSocketMessage): void {
    const syncData = message.data as { action?: unknown; state?: unknown }

    if (syncData.action !== "response" || typeof syncData.state !== "string" || !this.sessionId) {
      return
    }
    this.crdtStore.applySnapshot(this.sessionId, syncData.state)
  }

  private handleDisconnect(): void {
    this.stopHeartbeat()
    this.socket = null
    this.connectionState = "disconnected"
    if (this.closing) return

    const limit = this.config.reconnectAttempts ?? 5
    if (this.reconnectAttempts >= limit) {
      this.emitEvent({ type: "disconnected", timestamp: new Date() })
      return
    }

    this.connectionState = "reconnecting"
    this.reconnectAttempts++
    const sessionId = this.sessionId
    // Reconnecting AS somebody, not as a placeholder. The old code invented a
    // participant named "Reconnecting..." in a grey colour, which is what
    // every other peer then saw in the roster.
    const participant = this.participant
    this.reconnectTimer = setTimeout(() => {
      if (!sessionId || !participant) return
      this.connect(sessionId, participant)
        .then(() => {
          // The server may have moved on while this client was away, and the
          // updates it missed are not replayed by the socket on its own.
          this.requestSync()
        })
        .catch(() => this.handleDisconnect())
    }, this.config.reconnectInterval)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.connectionState === "connected" && this.sessionId && this.participantId) {
        void this.dispatch({
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

  /**
   * `null` for a frame that is not shaped like an operation. Nothing here
   * trusts the sender: an unparseable update is refused by `Y.applyUpdate`
   * downstream, but a frame missing the fields entirely is dropped here rather
   * than reaching it as `undefined`.
   */
  private deserializeOperation(data: unknown): CRDTOperation | null {
    if (!data || typeof data !== "object") return null
    const raw = data as Partial<CRDTOperation>
    if (typeof raw.update !== "string" || typeof raw.origin !== "string") return null
    return {
      id: typeof raw.id === "string" ? raw.id : `op-${Date.now()}`,
      update: raw.update,
      origin: raw.origin,
      timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
    }
  }
}

export default CanvasWebSocketProvider
