/**
 * WebSocket transport for live voice.
 *
 * Owns the socket only. Every byte on the wire is shaped by the provider
 * adapter (`Experimental_RealtimeModelV4`), so this module never learns a
 * vendor's event names:
 *
 *   send    → adapter.serializeClientEvent → JSON → socket
 *   receive → socket → JSON → adapter.parseServerEvent → normalized events
 *
 * Three behaviours worth knowing about:
 *
 * - **Send order is preserved even though serialization may be async.**
 *   `serializeClientEvent` is allowed to return a promise, and audio appends
 *   are high-rate, so sends are chained through a tail promise. Awaiting each
 *   call at the call site would be the alternative; a reordered audio stream is
 *   not recoverable.
 *
 * - **Frames are dropped, never buffered, while the socket is not open.**
 *   Replaying stale microphone audio into a freshly reconnected server's VAD
 *   produces a session that looks alive and transcribes nonsense; a gap is the
 *   lesser failure.
 *
 * - **`parseServerEvent` may fan one message out to several events.** Google
 *   packs audio, text and turn-complete into a single `serverContent` message.
 */

import type {
  Experimental_RealtimeModelV4 as RealtimeModel,
  Experimental_RealtimeModelV4ClientEvent as RealtimeClientEvent,
  Experimental_RealtimeModelV4ServerEvent as RealtimeServerEvent,
} from "@ai-sdk/provider"

/** The subset of the WebSocket API this transport relies on. */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
}

export const WS_OPEN = 1

export interface LiveVoiceTransportOptions {
  adapter: RealtimeModel
  onServerEvent(event: RealtimeServerEvent): void
  onOpen?(): void
  onClose?(info: { code?: number; reason?: string }): void
  onError?(error: Error): void
  /** Injectable socket constructor (tests pass a fake). */
  createWebSocket?(url: string, protocols?: string[]): WebSocketLike
}

export interface LiveVoiceConnectOptions {
  /** Maximum time allowed for the WebSocket handshake. */
  timeoutMs?: number
  /** Cancels a handshake without surfacing it as an unexpected transport error. */
  signal?: AbortSignal
}

function defaultCreateWebSocket(url: string, protocols?: string[]): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (u: string, p?: string[]) => WebSocketLike })
    .WebSocket
  if (!Ctor) throw new Error("WebSocket is not available in this environment")
  return protocols && protocols.length > 0 ? new Ctor(url, protocols) : new Ctor(url)
}

export class LiveVoiceTransport {
  private socket: WebSocketLike | null = null
  private sendTail: Promise<void> = Promise.resolve()
  private closing = false
  private pendingConnect: {
    resolve(): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout> | null
    signal?: AbortSignal
    onAbort?: () => void
  } | null = null

  constructor(private readonly options: LiveVoiceTransportOptions) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WS_OPEN
  }

  /**
   * Dial the provider. `token` and `url` come from the minted session; the
   * adapter decides how they map onto the actual socket URL and subprotocols
   * (OpenAI authenticates via subprotocol, xAI via a query parameter).
   */
  connect(
    session: { token: string; url: string },
    options: LiveVoiceConnectOptions = {}
  ): Promise<void> {
    if (this.socket) throw new Error("live voice transport is already connected")
    if (options.signal?.aborted) {
      return Promise.reject(new Error("live voice connection was cancelled"))
    }
    this.closing = false

    const { adapter, createWebSocket = defaultCreateWebSocket } = this.options
    const config = adapter.getWebSocketConfig({ token: session.token, url: session.url })
    const socket = createWebSocket(config.url, config.protocols)

    const connected = new Promise<void>((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        timer: null as ReturnType<typeof setTimeout> | null,
        signal: options.signal,
        onAbort: undefined as (() => void) | undefined,
      }
      this.pendingConnect = pending

      if (options.timeoutMs && options.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.cancelPendingConnect(
            new Error(`live voice connection timed out after ${options.timeoutMs}ms`),
            "connection timeout"
          )
        }, options.timeoutMs)
      }
      if (options.signal) {
        pending.onAbort = () => {
          this.cancelPendingConnect(
            new Error("live voice connection was cancelled"),
            "connection cancelled"
          )
        }
        options.signal.addEventListener("abort", pending.onAbort, { once: true })
      }
    })

    socket.onopen = () => {
      this.settlePendingConnect()
      this.options.onOpen?.()
    }
    socket.onerror = () => {
      const error = new Error("live voice socket error")
      this.rejectPendingConnect(error)
      this.fail(error)
    }
    socket.onclose = (event) => {
      this.socket = null
      this.rejectPendingConnect(
        new Error(
          `live voice connection closed before readiness${event?.code ? ` (${event.code})` : ""}`
        )
      )
      this.options.onClose?.({ code: event?.code, reason: event?.reason })
    }
    socket.onmessage = (event) => this.handleMessage(event.data)

    this.socket = socket
    // Some fire-and-forget callers observe lifecycle through callbacks. Mark
    // the promise handled for them while preserving rejection for callers that
    // await it (the controller does, so candidate fallback remains reliable).
    void connected.catch(() => undefined)
    return connected
  }

  /**
   * Serialize and send a normalized client event.
   *
   * Fire-and-forget by design so a 50 fps audio append does not force the
   * caller into an await; ordering is still guaranteed by the send chain.
   */
  send(event: RealtimeClientEvent): void {
    if (!this.isOpen) return
    this.sendTail = this.sendTail
      .then(async () => {
        // Re-check: the socket can close while earlier sends are in flight.
        if (!this.isOpen) return
        const payload = await this.options.adapter.serializeClientEvent(event)
        if (payload === undefined || payload === null) return
        this.socket?.send(typeof payload === "string" ? payload : JSON.stringify(payload))
      })
      .catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      })
  }

  /** Close the socket. Safe to call when already closed. */
  close(code?: number, reason?: string): void {
    this.closing = true
    this.rejectPendingConnect(new Error("live voice connection was cancelled"))
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onmessage = null
    socket.onopen = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close(code, reason)
    } catch {
      // A socket closing mid-handshake throws in some engines; nothing to do.
    }
  }

  private handleMessage(raw: unknown): void {
    let parsed: unknown
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    } catch (error) {
      this.fail(new Error(`live voice received malformed JSON: ${String(error)}`))
      return
    }

    const { adapter, onServerEvent } = this.options
    try {
      // Vendor keepalive (Google sends periodic pings) is answered before the
      // message is interpreted as a session event.
      const health = adapter.getHealthCheckResponse?.(parsed)
      if (health !== undefined && health !== null) {
        this.socket?.send(typeof health === "string" ? health : JSON.stringify(health))
        return
      }

      const events = adapter.parseServerEvent(parsed)
      for (const event of Array.isArray(events) ? events : [events]) {
        if (event) onServerEvent(event)
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private fail(error: Error): void {
    // A close we initiated is not an error worth surfacing.
    if (this.closing) return
    this.options.onError?.(error)
  }

  private clearPendingConnect(): typeof this.pendingConnect {
    const pending = this.pendingConnect
    if (!pending) return null
    this.pendingConnect = null
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort)
    }
    return pending
  }

  private settlePendingConnect(): void {
    this.clearPendingConnect()?.resolve()
  }

  private rejectPendingConnect(error: Error): void {
    this.clearPendingConnect()?.reject(error)
  }

  private cancelPendingConnect(error: Error, reason: string): void {
    const socket = this.socket
    this.socket = null
    this.rejectPendingConnect(error)
    if (!socket) return
    socket.onopen = null
    socket.onerror = null
    socket.onmessage = null
    socket.onclose = null
    try {
      socket.close(4000, reason)
    } catch {
      // The rejection above is the observable cancellation result.
    }
  }
}

export function createLiveVoiceTransport(options: LiveVoiceTransportOptions): LiveVoiceTransport {
  return new LiveVoiceTransport(options)
}
