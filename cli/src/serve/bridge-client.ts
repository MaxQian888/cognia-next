/**
 * BridgeClient — the brain's side of `/internal/bridge` (ADR-0059 W3 / T-B1).
 *
 * Implements the `RuntimeBridge` shape the three data-plane installers
 * accept (`listen` + `invoke`), so `installDesktopSyncSource({ bridge })`
 * and friends run VERBATIM against the socket:
 *
 * - `listen(event, handler)` — local subscription; the server's `event`
 *   frames fan out to matching handlers.
 * - `invoke(command, args)` — sends a `respond` frame carrying the Tauri
 *   response-command args verbatim (camelCase `requestId`, exactly what the
 *   installers pass today).
 *
 * Lifecycle: connect → hello → hello_ack; jittered-backoff reconnect with
 * re-hello; server pings answered with pong frames carrying the RSS gauge;
 * `token_refresh` frames update the token used on the next (re)connect.
 */
import {
  MAX_MEDIA_RESPONSE_BYTES,
  type MediaResponse,
  type RuntimeBridge,
} from "@/lib/headless/types"
import { HEADLESS_CATALOG_HASH, HEADLESS_CONTRACT_VERSION } from "./headless-contract-identity"
import { reconnectDelayMs } from "../runtime/reconnect-delay"

import {
  BRIDGE_PROTOCOL_VERSION,
  buildHello,
  buildPong,
  buildRespond,
  buildWorkerFrame,
  parseBridgeFrame,
  serializeBridgeFrame,
  MEDIA_RESPONSE_COMMAND,
} from "./protocol"

export type BridgeClientState = "idle" | "connecting" | "connected" | "reconnecting" | "closed"

/** The subset of the WHATWG WebSocket surface the client uses (Node 20+'s
 * global `WebSocket` satisfies it; tests inject fakes). */
export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: {
      data?: unknown
      error?: unknown
      message?: unknown
      code?: unknown
    }) => void
  ): void
}

type Handler = (e: { payload: unknown }) => void

export interface BridgeClientOptions {
  /** `wss://127.0.0.1:<port>/internal/bridge` (no query — the token is appended). */
  url: string
  /** Initial service token; refreshed by `token_refresh` frames. */
  token: string
  accountId: string
  brainVersion?: string
  capabilities?: string[]
  // ── Injectable seams (tests) ────────────────────────────────────────────────
  wsFactory?: (url: string) => WebSocketLike
  now?: () => number
  random?: () => number
  /** Schedule a deferred call; returns a cancel fn. Defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** Fail the handshake when hello_ack does not arrive in time. */
  helloAckTimeoutMs?: number
  /** Disable automatic reconnection (tests, one-shot probes). */
  reconnect?: boolean
  onStateChange?: (state: BridgeClientState) => void
  onTokenRefresh?: (token: string) => void
  onWorkerAttach?: (worker: {
    connectionId: string
    hostRef: string
    manifest: Record<string, unknown>
  }) => void
  onWorkerFrame?: (connectionId: string, frame: string) => void
  onWorkerDetach?: (worker: { connectionId: string; hostRef: string; reason: string }) => void
  /** RSS gauge for pong frames. */
  rss?: () => { rssBytes: number; lastFlushAt: number }
  log?: (level: "info" | "warn" | "error", message: string) => void
}

function redactBridgeErrorDetail(value: string): string {
  return value
    .replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(authorization:\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[redacted]")
}

function describeBridgeSocketError(event: {
  error?: unknown
  message?: unknown
  code?: unknown
}): string | null {
  const parts: string[] = []
  let current = event.error
  for (let depth = 0; current != null && depth < 3; depth += 1) {
    if (current instanceof Error) {
      if (current.message) parts.push(current.message)
      current = current.cause
      continue
    }
    if (typeof current === "string") parts.push(current)
    break
  }
  if (parts.length === 0 && typeof event.message === "string" && event.message) {
    parts.push(event.message)
  }
  if (parts.length === 0 && (typeof event.code === "string" || typeof event.code === "number")) {
    parts.push(`code ${event.code}`)
  }
  return parts.length > 0 ? redactBridgeErrorDetail(parts.join(": ")) : null
}

function defaultWsFactory(url: string): WebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  if (!ctor) {
    throw new Error("no global WebSocket (Node >= 20 required)")
  }
  return new ctor(url)
}

export class BridgeClient implements RuntimeBridge {
  private readonly opts: BridgeClientOptions
  private readonly handlers = new Map<string, Set<Handler>>()
  private socket: WebSocketLike | null = null
  private state: BridgeClientState = "idle"
  private token: string
  private attempts = 0
  private cancelTimer: (() => void) | null = null
  private connectResolve: (() => void) | null = null
  private connectReject: ((err: Error) => void) | null = null

  constructor(opts: BridgeClientOptions) {
    this.opts = opts
    this.token = opts.token
  }

  getState(): BridgeClientState {
    return this.state
  }

  /** Resolves once the first hello/hello_ack handshake completes. */
  connect(): Promise<void> {
    if (this.state === "closed") {
      return Promise.reject(new Error("bridge client is closed"))
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
    })
    this.setState("connecting")
    this.open()
    return promise
  }

  /** Stop reconnecting and close the socket. */
  close(): void {
    this.setState("closed")
    this.cancelTimer?.()
    this.cancelTimer = null
    try {
      this.socket?.close()
    } catch {
      // already gone
    }
    this.socket = null
  }

  // ── RuntimeBridge ───────────────────────────────────────────────────────────

  async listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void> {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    const entry = handler as Handler
    set.add(entry)
    return () => {
      set.delete(entry)
      if (set.size === 0) this.handlers.delete(event)
    }
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.state !== "connected" || !this.socket) {
      // The server's pending request has already failed fast on disconnect;
      // dropping the response (loudly) beats an unhandled rejection inside
      // the fire-and-forget installer handlers.
      this.log("warn", `bridge invoke(${name}) dropped: not connected`)
      return null
    }
    this.socket.send(serializeBridgeFrame(buildRespond(name, args)))
    return null
  }

  /**
   * Answer a session-media read over the WS bridge.
   *
   * The v3 frame set is newline-delimited JSON text and `ws_bridge.rs` reads
   * only `Message::Text`, so the bytes ride as base64 inside an ordinary
   * `respond` payload rather than as a binary frame. That costs 33% inflation
   * on a payload already capped at 10 MB, against a 64 MB frame ceiling, and
   * buys not having to bump `BRIDGE_PROTOCOL_VERSION` and upgrade both halves
   * in lockstep for one command.
   *
   * The payload is typed rather than a header bag. Tauri normalizes header
   * casing and a JSON object does not, so mirroring "headers" across the two
   * transports would make casing drift a silent 404 on one of them.
   */
  async respondMedia({ requestId, bytes, mediaType, etag, error }: MediaResponse): Promise<void> {
    if (this.state !== "connected" || !this.socket) {
      this.log("warn", `bridge respondMedia(${requestId}) dropped: not connected`)
      return
    }
    if (bytes.byteLength > MAX_MEDIA_RESPONSE_BYTES) {
      // Refused here as well as at the caller: this is the last point that
      // knows the true encoded size, and an oversized frame is dropped by the
      // server without resolving anything.
      this.log("warn", `bridge respondMedia(${requestId}) refused: ${bytes.byteLength} bytes`)
      this.socket.send(
        serializeBridgeFrame(
          buildRespond(MEDIA_RESPONSE_COMMAND, {
            requestId,
            bodyBase64: "",
            mediaType: "application/octet-stream",
            etag: null,
            error: "MEDIA_TOO_LARGE",
          })
        )
      )
      return
    }
    this.socket.send(
      serializeBridgeFrame(
        buildRespond(MEDIA_RESPONSE_COMMAND, {
          requestId,
          bodyBase64: Buffer.from(bytes).toString("base64"),
          mediaType,
          etag: etag ?? null,
          error: error ?? null,
        })
      )
    )
  }

  sendWorkerFrame(connectionId: string, frame: string): void {
    if (this.state !== "connected" || !this.socket) {
      throw new Error("brain bridge is not connected")
    }
    this.socket.send(serializeBridgeFrame(buildWorkerFrame(connectionId, frame)))
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private setState(state: BridgeClientState): void {
    if (this.state === state) return
    this.state = state
    this.opts.onStateChange?.(state)
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.opts.log?.(level, message)
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private schedule(fn: () => void, ms: number): () => void {
    if (this.opts.schedule) return this.opts.schedule(fn, ms)
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  }

  private open(): void {
    const factory = this.opts.wsFactory ?? defaultWsFactory
    const url = `${this.opts.url}?token=${encodeURIComponent(this.token)}`
    let socket: WebSocketLike
    try {
      socket = factory(url)
    } catch (err) {
      this.onDisconnect(err instanceof Error ? err : new Error(String(err)))
      return
    }
    this.socket = socket
    let acked = false
    let cancelAckTimeout: (() => void) | null = null

    socket.addEventListener("open", () => {
      socket.send(
        serializeBridgeFrame(
          buildHello({
            brainVersion: this.opts.brainVersion ?? "0.0.0",
            accountId: this.opts.accountId,
            capabilities: this.opts.capabilities,
          })
        )
      )
      const timeoutMs = this.opts.helloAckTimeoutMs ?? 10_000
      cancelAckTimeout = this.schedule(() => {
        if (!acked) {
          this.log("error", "bridge hello_ack timeout; closing")
          try {
            socket.close()
          } catch {
            // already gone
          }
        }
      }, timeoutMs)
    })

    socket.addEventListener("message", (event: { data?: unknown }) => {
      const text = typeof event.data === "string" ? event.data : String(event.data)
      const frame = parseBridgeFrame(text)
      if (!frame) {
        this.log("warn", "bridge: ignoring unparseable frame")
        return
      }
      switch (frame.type) {
        case "hello_ack": {
          if (frame.accountId !== this.opts.accountId) {
            this.log("error", "bridge account mismatch")
            this.close()
            this.connectReject?.(new Error("bridge account mismatch"))
            this.connectReject = null
            this.connectResolve = null
            return
          }
          if (frame.protocol !== BRIDGE_PROTOCOL_VERSION) {
            this.log(
              "error",
              `bridge protocol mismatch (server ${frame.protocol}, client ${BRIDGE_PROTOCOL_VERSION})`
            )
            this.close()
            this.connectReject?.(new Error("bridge protocol mismatch"))
            this.connectReject = null
            this.connectResolve = null
            return
          }
          if (
            frame.catalogHash !== HEADLESS_CATALOG_HASH ||
            frame.contractVersion !== HEADLESS_CONTRACT_VERSION
          ) {
            this.log("error", "bridge Headless contract mismatch")
            this.close()
            this.connectReject?.(new Error("bridge Headless contract mismatch"))
            this.connectReject = null
            this.connectResolve = null
            return
          }
          acked = true
          cancelAckTimeout?.()
          this.attempts = 0
          this.setState("connected")
          this.connectResolve?.()
          this.connectResolve = null
          this.connectReject = null
          this.log("info", `bridge connected (server ${frame.serverVersion})`)
          break
        }
        case "event": {
          const set = this.handlers.get(frame.event)
          if (!set || set.size === 0) {
            this.log("warn", `bridge: no handler for event ${frame.event}`)
            return
          }
          for (const handler of set) {
            try {
              handler({ payload: frame.payload })
            } catch (err) {
              this.log(
                "error",
                `bridge handler for ${frame.event} threw: ${
                  err instanceof Error ? err.message : String(err)
                }`
              )
            }
          }
          break
        }
        case "worker_attach": {
          this.opts.onWorkerAttach?.({
            connectionId: frame.connectionId,
            hostRef: frame.hostRef,
            manifest: frame.manifest,
          })
          break
        }
        case "worker_frame": {
          this.opts.onWorkerFrame?.(frame.connectionId, frame.frame)
          break
        }
        case "worker_detach": {
          this.opts.onWorkerDetach?.({
            connectionId: frame.connectionId,
            hostRef: frame.hostRef,
            reason: frame.reason,
          })
          break
        }
        case "ping": {
          const rss = this.opts.rss?.() ?? { rssBytes: 0, lastFlushAt: 0 }
          try {
            socket.send(serializeBridgeFrame(buildPong(this.now(), rss.rssBytes, rss.lastFlushAt)))
          } catch {
            // socket raced shut; the close handler reconnects.
          }
          break
        }
        case "token_refresh": {
          this.token = frame.token
          this.opts.onTokenRefresh?.(frame.token)
          break
        }
        default:
          // hello / respond / pong are never server→brain; ignore.
          break
      }
    })

    socket.addEventListener("close", () => {
      cancelAckTimeout?.()
      this.onDisconnect(new Error("bridge socket closed"))
    })
    socket.addEventListener("error", (event) => {
      // The close event follows; nothing to do here beyond logging.
      const detail = describeBridgeSocketError(event)
      this.log("warn", detail ? `bridge socket error: ${detail}` : "bridge socket error")
    })
  }

  private onDisconnect(cause: Error): void {
    if (this.state === "closed") return
    this.socket = null
    const shouldReconnect = this.opts.reconnect !== false
    if (!shouldReconnect) {
      this.setState("closed")
      this.connectReject?.(cause)
      this.connectReject = null
      this.connectResolve = null
      return
    }
    this.setState("reconnecting")
    const random = this.opts.random ? this.opts.random() : Math.random()
    const delay = reconnectDelayMs(this.attempts, random)
    this.attempts += 1
    this.log("info", `bridge reconnecting in ${delay} ms (${cause.message})`)
    this.cancelTimer?.()
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      if (this.state === "closed") return
      this.open()
    }, delay)
  }
}
