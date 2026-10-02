// The broker connection: one loopback TCP socket back to the app, the
// challenge/hello handshake, request/response correlation in both directions,
// cancellation, progress, and reconnects.
//
// Free of the `vscode` API: the editor side is injected as `dispatch`, so the
// whole connection lifecycle runs under `node --test` against a real socket.

import * as net from "node:net"

import {
  challengeProof,
  contentBearer,
  newClientNonce,
  nextSessionCredential,
  readBootstrapCredential,
} from "./broker-credential.mjs"
import {
  ContentLengthDecoder,
  PROTOCOL_INCOMPATIBLE_CODE,
  brokerChallengeRequest,
  brokerHelloRequest,
  errorResponse,
  eventNotification,
  responseMessage,
  serializeContentLength,
  validateNegotiatedHello,
} from "./jsonrpc.mjs"

/** Delay before retrying a dropped connection to the app's agent channel. */
export const RECONNECT_DELAY_MS = 1000

/**
 * How long state events are coalesced before being pushed.
 *
 * Selection changes fire per keystroke and per cursor move; forwarding each one
 * would turn a held arrow key into hundreds of socket writes and app-side
 * re-reads. The app only ever responds to them by re-reading current state, so
 * collapsing a burst into one trailing event loses nothing. User-initiated
 * events are never coalesced (see {@link AgentBridge.emit}).
 */
export const EVENT_COALESCE_MS = 150

/** Used only until the host's hello reply supplies its own deadlines. */
const FALLBACK_REQUEST_DEADLINE_MS = 30_000

/** JSON-RPC "request cancelled" (LSP's RequestCancelled). */
const REQUEST_CANCELLED_CODE = -32800

/**
 * Owns the single TCP connection back to the app and dispatches inbound request
 * frames to the editor handlers. Reconnects with a fixed backoff so a transient
 * app-side restart doesn't leave the bridge dead.
 *
 * Credentials: the first connection authenticates with the bootstrap read from
 * the credential file; every successful hello replaces the held credential with
 * a session derived from it. A credential the host refuses is dropped, and the
 * next attempt reads a fresh bootstrap file (the host re-mints one whenever no
 * extension host is connected).
 */
export class AgentBridge {
  constructor({
    port,
    credentialFile,
    hostId,
    workspace,
    catalogHash,
    dispatch,
    onConnectionChange = () => {},
    createConnection = (options, onConnect) => net.createConnection(options, onConnect),
    readCredential = readBootstrapCredential,
    reconnectDelayMs = RECONNECT_DELAY_MS,
    eventCoalesceMs = EVENT_COALESCE_MS,
  }) {
    this.port = port
    this.credentialFile = credentialFile
    this.hostId = hostId
    this.workspace = workspace
    this.catalogHash = catalogHash
    this.dispatch = dispatch
    this.onConnectionChange = onConnectionChange
    this.createConnection = createConnection
    this.readCredential = readCredential
    this.reconnectDelayMs = reconnectDelayMs
    this.eventCoalesceMs = eventCoalesceMs
    this.socket = null
    this.decoder = new ContentLengthDecoder()
    this.disposed = false
    this.reconnectTimer = null
    this.coalesceTimers = new Map()
    this.inflight = new Map()
    this.pending = new Map()
    this.notificationListeners = new Set()
    this.nextRequestId = 1
    this.negotiated = null
    this.credential = null
    this.handshake = null
    this.incompatible = false
    this.readyWaiters = new Set()
  }

  /**
   * Resolve once the broker has negotiated, at once if it already has.
   *
   * A proxy extension activates at startup alongside the broker, often before
   * the broker's connection is up; a request sent then is refused, and VS Code
   * never retries a failed activation. Rejects after `timeoutMs`, or when the
   * bridge is disposed or the host refuses this broker's protocol.
   */
  whenReady(timeoutMs) {
    if (this.socket && this.negotiated) return Promise.resolve()
    if (this.disposed) return Promise.reject(new Error("Managed IDE broker disposed"))
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer)
          this.readyWaiters.delete(waiter)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          this.readyWaiters.delete(waiter)
          reject(error)
        },
      }
      const timer = setTimeout(
        () => waiter.reject(new Error(`Managed IDE broker did not connect within ${timeoutMs} ms`)),
        timeoutMs
      )
      this.readyWaiters.add(waiter)
    })
  }

  settleReadyWaiters(error) {
    for (const waiter of [...this.readyWaiters]) {
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }

  start() {
    void this.connect()
  }

  dispose() {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    for (const timer of this.coalesceTimers.values()) clearTimeout(timer)
    this.coalesceTimers.clear()
    this.failPending("Managed IDE broker disposed")
    this.settleReadyWaiters(new Error("Managed IDE broker disposed"))
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
    this.notificationListeners.clear()
    this.socket?.destroy()
    this.socket = null
    this.credential = null
  }

  /** Whether the hello completed on the live socket. */
  get connected() {
    return this.negotiated !== null
  }

  /** Whether both sides offered `capability` in the hello. */
  supports(capability) {
    return this.negotiated?.capabilities.includes(capability) === true
  }

  /** Bearer for the content endpoint, derived from the live session. */
  contentBearer() {
    if (!this.negotiated || this.credential?.kind !== "session") return null
    return contentBearer(this.credential.tokenId, this.credential.secret)
  }

  /**
   * Push an event to the app.
   *
   * State events (`coalesce: true`, the default) collapse repeats of the same
   * `name` inside {@link EVENT_COALESCE_MS} and are dropped while disconnected:
   * the next one supersedes anything missed. User-initiated events
   * (`coalesce: false`) — a command the person just ran — go out immediately,
   * one per invocation; two quick "Add to Chat" clicks are two requests.
   */
  emit(name, payloadFn, { coalesce = true } = {}) {
    if (this.disposed) return false
    if (!coalesce) {
      if (!this.socket || !this.negotiated) return false
      try {
        this.writeEvent(name, payloadFn())
        return true
      } catch {
        return false
      }
    }
    const existing = this.coalesceTimers.get(name)
    if (existing) clearTimeout(existing)
    this.coalesceTimers.set(
      name,
      setTimeout(() => {
        this.coalesceTimers.delete(name)
        if (this.disposed || !this.socket || !this.negotiated) return
        try {
          this.writeEvent(name, payloadFn())
        } catch {
          // Socket died between the check and the write; the reconnect handles it.
        }
      }, this.eventCoalesceMs)
    )
    return true
  }

  async connect() {
    if (this.disposed || this.incompatible) return
    if (!this.credential) {
      try {
        this.credential = await this.readCredential(this.credentialFile)
      } catch {
        this.scheduleReconnect()
        return
      }
      if (this.disposed) return
    }
    const credential = this.credential
    const socket = this.createConnection({ host: "127.0.0.1", port: this.port }, () => {
      this.decoder = new ContentLengthDecoder()
      this.negotiated = null
      this.handshake = { credential, clientNonce: newClientNonce(), challenge: null }
      socket.write(
        serializeContentLength(
          brokerChallengeRequest(credential.tokenId, this.handshake.clientNonce)
        )
      )
    })
    socket.on("data", (chunk) => this.onData(chunk))
    // Errors surface as a `close`; swallow so an unhandled 'error' can't crash
    // the extension host.
    socket.on("error", () => {})
    socket.on("close", () => {
      if (this.socket !== socket) return
      const wasConnected = this.negotiated !== null
      this.socket = null
      this.negotiated = null
      this.handshake = null
      this.failPending("Managed IDE broker disconnected")
      for (const controller of this.inflight.values()) controller.abort()
      this.inflight.clear()
      if (wasConnected) this.notifyConnectionChange(false)
      this.scheduleReconnect()
    })
    this.socket = socket
  }

  notifyConnectionChange(connected) {
    try {
      this.onConnectionChange(connected)
    } catch {
      // A listener's failure must not take the connection down with it.
    }
  }

  scheduleReconnect() {
    if (this.disposed || this.incompatible || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, this.reconnectDelayMs)
  }

  onData(chunk) {
    let messages
    try {
      messages = this.decoder.push(chunk)
    } catch {
      this.socket?.destroy()
      return
    }
    for (const message of messages) void this.handleJsonRpc(message)
  }

  writeEvent(name, payload) {
    if (!this.socket) return
    this.socket.write(serializeContentLength(eventNotification(name, payload)))
  }

  /** The host-supplied deadline for `method`, in milliseconds. */
  requestDeadline(method) {
    const deadlines = this.negotiated?.requestDeadlinesMs
    const value = deadlines?.[method] ?? deadlines?.default
    return Number.isSafeInteger(value) && value > 0 ? value : FALLBACK_REQUEST_DEADLINE_MS
  }

  request(method, params, options = {}) {
    if (!this.socket || !this.negotiated) {
      return Promise.reject(new Error("Managed IDE broker is not ready"))
    }
    const id = `proxy:${this.nextRequestId++}`
    const timeoutMs = options.timeoutMs ?? this.requestDeadline(method)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (this.supports("cancel")) this.notify("$/cancelRequest", { id })
        reject(new Error(`Managed IDE broker request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.socket.write(
          serializeContentLength({
            jsonrpc: "2.0",
            id,
            method,
            params,
          })
        )
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params) {
    if (!this.socket || !this.negotiated) return
    this.socket.write(serializeContentLength({ jsonrpc: "2.0", method, params }))
  }

  onNotification(listener) {
    this.notificationListeners.add(listener)
    return {
      dispose: () => this.notificationListeners.delete(listener),
    }
  }

  failPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.pending.clear()
  }

  /**
   * The host refused the credential this handshake presented. Drop it so the
   * next attempt reads a fresh bootstrap; a protocol refusal stops reconnecting
   * altogether, since no credential would change the answer.
   */
  rejectHandshake(error) {
    if (this.handshake && this.credential === this.handshake.credential) {
      this.credential = null
    }
    if (error?.code === PROTOCOL_INCOMPATIBLE_CODE) {
      this.incompatible = true
      // It will not retry, so nothing waiting for it should either.
      this.settleReadyWaiters(
        new Error("IDE_BROKER_PROTOCOL_INCOMPATIBLE: the host refused this broker")
      )
    }
    this.socket?.destroy()
  }

  async handleJsonRpc(message) {
    if (!message || message.jsonrpc !== "2.0") return
    if (message.id === "challenge" && ("result" in message || "error" in message)) {
      const handshake = this.handshake
      if (message.error || typeof message.result?.challenge !== "string" || !handshake) {
        this.rejectHandshake(message.error)
        return
      }
      handshake.challenge = message.result.challenge
      this.socket?.write(
        serializeContentLength(
          brokerHelloRequest({
            tokenId: handshake.credential.tokenId,
            proof: challengeProof(handshake.credential.secret, handshake.challenge),
            catalogHash: this.catalogHash,
            hostId: this.hostId,
            workspace: this.workspace,
          })
        )
      )
      return
    }
    if (message.id === "hello" && ("result" in message || "error" in message)) {
      const handshake = this.handshake
      if (message.error || !handshake?.challenge) {
        this.rejectHandshake(message.error)
        return
      }
      try {
        const negotiated = validateNegotiatedHello(message.result, this.catalogHash)
        this.credential = nextSessionCredential(
          handshake.credential,
          handshake.challenge,
          handshake.clientNonce,
          negotiated.sessionId
        )
        this.negotiated = negotiated
        this.handshake = null
      } catch {
        this.rejectHandshake(null)
        return
      }
      this.notifyConnectionChange(true)
      this.settleReadyWaiters(null)
      return
    }
    if (message.id === null && message.error) {
      // An unaddressed refusal: the host could not even parse our framing.
      this.rejectHandshake(message.error)
      return
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) {
        const error = new Error(message.error.message ?? "Managed IDE broker request failed")
        error.code = message.error.code
        error.data = message.error.data
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (!this.negotiated) return
    if (message.method === "$/cancelRequest") {
      if (!this.supports("cancel")) return
      this.inflight.get(message.params?.id)?.abort()
      return
    }
    if (message.method === "cognia/provider/event" && message.id === undefined) {
      for (const listener of this.notificationListeners) {
        try {
          listener(message.params ?? {})
        } catch {
          // One proxy's event handler cannot break delivery to other proxies.
        }
      }
      return
    }
    if (typeof message.method !== "string" || message.id === undefined) return

    const id = message.id
    const socket = this.socket
    const controller = new AbortController()
    this.inflight.set(id, controller)
    const reportProgress = (value) => {
      if (controller.signal.aborted || !this.supports("progress") || this.socket !== socket) return
      try {
        socket?.write(
          serializeContentLength({
            jsonrpc: "2.0",
            method: "$/progress",
            params: { token: id, value },
          })
        )
      } catch {
        // Progress is advisory; the response still settles the request.
      }
    }
    const reply = (frame) => {
      if (this.socket !== socket) return
      try {
        socket?.write(serializeContentLength(frame))
      } catch {
        // Socket died; the host fails the request on its side.
      }
    }
    try {
      const result = await this.dispatch(message.method, message.params ?? {}, {
        signal: controller.signal,
        reportProgress,
      })
      if (controller.signal.aborted) {
        reply(errorResponse(id, REQUEST_CANCELLED_CODE, "Request cancelled"))
      } else {
        reply(responseMessage(id, result))
      }
    } catch (error) {
      const text = String(error?.message ?? error)
      const code = controller.signal.aborted
        ? REQUEST_CANCELLED_CODE
        : text.startsWith("unknown method:")
          ? -32601
          : -32603
      reply(errorResponse(id, code, text))
    } finally {
      this.inflight.delete(id)
    }
  }
}
