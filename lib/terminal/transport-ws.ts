"use client"

/**
 * LAN-only WebSocket transport for the integrated terminal.
 *
 * On Capacitor mobile (no Tauri runtime, no `ipc::Channel` access) the
 * dock talks to the desktop server's `cognia-server` axum router at
 * `wss://<host>/ws/v1/terminal?...`. The companion pair flow has
 * already signed a JWT and stored the base URL; this transport reads
 * those (lazily, via `getCompanionEndpoint`) and frames PTY bytes as
 * binary WS messages plus a small JSON control envelope for spawn /
 * resize / kill.
 *
 * Wire protocol (v1):
 *   * `?token=<jwt>` — auth, JWT injected by middleware
 *   * `?projectId=…` (optional) — propagates to PtySession.project_id
 *   * `?spawn=1&shell=…&rows=…&cols=…` — open the session inline; the
 *     server allocates `sessionId` and replies with a JSON
 *     `{ "kind": "ready", "sessionId": "…" }` text frame.
 *   * `?sessionId=<id>&resumeFrom=<seq>` — Wave 2: reconnect to an
 *     existing session. The server's `ReplayBuffer` re-emits every
 *     buffered event with `seq > resumeFrom` then resumes live.
 *
 * Frame conventions after the first text:
 *   * Binary frames Server→Client = PTY stdout.
 *   * Binary frames Client→Server = PTY stdin.
 *   * Text frames carry control envelopes (integration events,
 *     resize, kill, exit). Each control frame is `{ "kind": "…", "seq": <u64>, … }`
 *     with the same tagged-enum shape as `TerminalEvent` minus the
 *     `data` variant (which uses binary frames). `seq` is monotonic
 *     per session and powers the reconnect replay; if the server is
 *     pre-Wave-2 it may be missing — we treat that as `seq = 0`.
 *
 * Wave 2 — reconnect: when the WebSocket drops (network blip,
 * background tab, mobile-app pause) we schedule a reconnect with
 * exponential backoff up to a 5-minute envelope. During the window:
 *   * outgoing writes are queued and flushed on reattach,
 *   * `transport-state` listeners see `"reconnecting"`,
 *   * the session never appears exited to its consumers.
 * If the envelope expires, we surface `"gone"` then `handleExit(null)`.
 *
 * This file mirrors the public surface of `lib/terminal/session.ts` so
 * `spawn-orchestrator` can swap transports without conditionals. Both
 * classes share `BaseTerminalSession` for listener / exit bookkeeping.
 */

import { BaseTerminalSession } from "./base-session"
import { isCapacitor } from "@/lib/tauri"
import { getActiveRemoteEndpoint } from "@/lib/tauri/transport-routing"

import type { IntegrationEvent, SessionInfo, SpawnRequest } from "./types"

/**
 * Resolver for the desktop server endpoint + JWT. Injected from
 * `companion-boot-provider` in production; tests stub it.
 */
export interface CompanionEndpoint {
  /** Base WSS URL (e.g. `wss://192.168.1.10:7654`). */
  baseUrl: string
  /** Signed device JWT — the auth middleware reads `?token=`. */
  token: string
}

export type CompanionEndpointResolver = () => Promise<CompanionEndpoint | null>

/**
 * Default resolver — reads from `pickCompanionStorage()`, the same
 * source the companion boot provider uses to load the pair JWT + base
 * URL. Returns `null` when the device hasn't paired yet so the dock's
 * mobile empty state surfaces "Remote terminal not configured".
 *
 * Tests inject their own resolver via
 * `configureCompanionEndpointResolver` to avoid the dynamic import.
 */
/** Companion `baseUrl` is `https://…`; flip to `wss://…` for the WS upgrade. */
function toWsBase(baseUrl: string): string {
  return baseUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://")
}

const defaultResolver: CompanionEndpointResolver = async () => {
  // Desktop driving a remote Cognia host (ADR-0082): the active-host store
  // installs the endpoint descriptor. Prefer it over the local companion cache
  // so a remote terminal opens against the active host, not the paired server.
  const remote = getActiveRemoteEndpoint()
  if (remote) {
    return { baseUrl: toWsBase(remote.baseUrl), token: remote.deviceJwt }
  }
  if (!isCapacitor()) return null
  const { pickCompanionStorage } = await import("@/lib/tauri/companion-storage")
  const config = await pickCompanionStorage().load()
  if (!config) return null
  return { baseUrl: toWsBase(config.baseUrl), token: config.deviceJwt }
}

let endpointResolver: CompanionEndpointResolver = defaultResolver

export function configureCompanionEndpointResolver(resolver: CompanionEndpointResolver): void {
  endpointResolver = resolver
}

export function __resetEndpointResolverForTesting(): void {
  endpointResolver = defaultResolver
}

export type TransportState = "connected" | "reconnecting" | "gone"
type TransportStateListener = (state: TransportState) => void

type ControlFrame =
  | { kind: "ready"; sessionId: string; shell: string; seq?: number }
  | { kind: "integration"; event: IntegrationEvent; seq?: number }
  | { kind: "exit"; code: number | null; seq?: number }
  | { kind: "error"; message: string; seq?: number }

/**
 * Backoff schedule used during reconnect. Sums to ~5 min so a long
 * mobile sleep (commute through a tunnel, screen lock) still survives.
 * Indices past the end clamp to the last value.
 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000, 60_000, 60_000]
const RECONNECT_BUDGET_MS = 5 * 60 * 1000

/** Override hook for the WebSocket factory — tests inject a stub. */
let webSocketFactory: (url: string) => WebSocket = (url) => new WebSocket(url)

export function __setWebSocketFactoryForTesting(
  factory: (url: string) => WebSocket | null = (url) => new WebSocket(url)
): void {
  webSocketFactory = (url) => {
    const ws = factory(url)
    if (!ws) throw new Error("test factory returned null")
    return ws
  }
}

/**
 * Server-side companion that owns the actual `PtySession`. From the
 * renderer's POV this class is API-compatible with `TerminalSession`
 * from `session.ts` — both extend `BaseTerminalSession`.
 */
export class RemoteTerminalSession extends BaseTerminalSession {
  readonly info: SessionInfo

  private ws: WebSocket
  private readonly endpoint: CompanionEndpoint
  private readonly req: SpawnRequest
  private readonly transportStateListeners = new Set<TransportStateListener>()
  /** Highest control-frame seq we've observed. Powers `resumeFrom`. */
  private lastSeq = 0
  /** Bytes queued during a reconnect window — flushed on reattach. */
  private pendingWrites: Uint8Array[] = []
  /** Resolves when a `kill()` has been requested explicitly. */
  private intentionalClose = false
  /** Wall-clock time the current reconnect cycle began. Null when connected. */
  private reconnectStartedAt: number | null = null
  /** Index into BACKOFF_MS for the next attempt. */
  private backoffIndex = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private constructor(
    info: SessionInfo,
    ws: WebSocket,
    endpoint: CompanionEndpoint,
    req: SpawnRequest
  ) {
    super()
    this.info = info
    this.ws = ws
    this.endpoint = endpoint
    this.req = req
    this.wireListeners()
  }

  static async spawn(req: SpawnRequest): Promise<RemoteTerminalSession> {
    const endpoint = await endpointResolver()
    if (!endpoint) {
      throw new Error("transport-ws: companion endpoint not configured")
    }
    const url = buildSpawnUrl(endpoint, req)
    const ws = webSocketFactory(url)
    ws.binaryType = "arraybuffer"
    const info = await waitForReady(ws, req)
    return new RemoteTerminalSession(info, ws, endpoint, req)
  }

  /** Subscribe to transport-state changes (connected → reconnecting → connected | gone). */
  onTransportState(listener: TransportStateListener): () => void {
    this.transportStateListeners.add(listener)
    return () => {
      this.transportStateListeners.delete(listener)
    }
  }

  async write(data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    if (this.ws.readyState === WebSocket.OPEN) {
      // `WebSocket.send` only accepts ArrayBuffer-backed views (not the
      // SharedArrayBuffer side of `Uint8Array<ArrayBufferLike>` that TS 6
      // surfaces). Callers always hand us ArrayBuffer-backed bytes at
      // runtime (PTY transport + TextEncoder above), so the cast is safe.
      this.ws.send(bytes as Uint8Array<ArrayBuffer>)
      return
    }
    if (this.isExited) return
    // Reconnecting — queue for replay. Bounded to a sensible cap so a
    // long disconnect doesn't blow the heap; the user can always retry.
    if (this.pendingWrites.length < 256) {
      this.pendingWrites.push(bytes)
    }
  }

  async resize(rows: number, cols: number): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(
      JSON.stringify({
        kind: "resize",
        rows: Math.max(1, Math.floor(rows)),
        cols: Math.max(1, Math.floor(cols)),
      })
    )
  }

  async kill(): Promise<void> {
    if (this.isExited) return
    this.intentionalClose = true
    this.cancelReconnect()
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ kind: "kill" }))
      } catch {
        /* noop */
      }
    }
    try {
      this.ws.close()
    } catch {
      /* noop */
    }
    this.handleExit(null)
  }

  private wireListeners(): void {
    this.ws.addEventListener("message", (event) => this.onMessage(event))
    this.ws.addEventListener("close", (event) => this.onClose(event))
    this.ws.addEventListener("error", () => this.onError())
    // Drain any queued writes immediately on attach (initial connect
    // races: the spawn promise resolved on `ready`, so a fast caller
    // might have written before this listener was wired).
    if (this.ws.readyState === WebSocket.OPEN) {
      this.flushPendingWrites()
    } else {
      this.ws.addEventListener("open", () => this.flushPendingWrites(), { once: true })
    }
  }

  private onMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      try {
        const frame = JSON.parse(event.data) as ControlFrame
        if (typeof frame.seq === "number" && frame.seq > this.lastSeq) {
          this.lastSeq = frame.seq
        }
        this.dispatchControl(frame)
      } catch {
        // Ignore non-JSON text frames — protocol drift; the server
        // should only emit valid JSON.
      }
      return
    }
    const buf = new Uint8Array(event.data as ArrayBuffer)
    this.dispatchData(buf)
  }

  private onClose(event: CloseEvent): void {
    if (this.intentionalClose || this.isExited) return
    // Schedule reconnect rather than treating this as exit.
    this.scheduleReconnect()
    void event // event.code is informational only
  }

  private onError(): void {
    if (this.intentionalClose || this.isExited) return
    this.scheduleReconnect()
  }

  private dispatchControl(frame: ControlFrame): void {
    switch (frame.kind) {
      case "integration":
        this.dispatchIntegration(frame.event)
        break
      case "exit":
        // Server reports clean exit — surface to the consumer.
        this.intentionalClose = true
        this.cancelReconnect()
        this.handleExit(frame.code)
        break
      case "error":
        console.warn(`remote-terminal(${this.info.id}): server error:`, frame.message)
        break
      default:
        break
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.isExited) return
    if (this.reconnectStartedAt == null) {
      this.reconnectStartedAt = Date.now()
      this.backoffIndex = 0
      this.emitTransportState("reconnecting")
    }
    const elapsed = Date.now() - this.reconnectStartedAt
    if (elapsed >= RECONNECT_BUDGET_MS) {
      this.emitTransportState("gone")
      this.handleExit(null)
      return
    }
    const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)]
    this.backoffIndex += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.attemptReconnect()
    }, delay)
  }

  private attemptReconnect(): void {
    const url = buildResumeUrl(this.endpoint, this.req, this.info.id, this.lastSeq)
    let ws: WebSocket
    try {
      ws = webSocketFactory(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    ws.binaryType = "arraybuffer"
    const onOpen = () => {
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onError)
      this.ws = ws
      this.reconnectStartedAt = null
      this.backoffIndex = 0
      this.emitTransportState("connected")
      this.wireListeners()
    }
    const onError = () => {
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onError)
      try {
        ws.close()
      } catch {
        /* noop */
      }
      this.scheduleReconnect()
    }
    ws.addEventListener("open", onOpen)
    ws.addEventListener("error", onError)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectStartedAt = null
    this.backoffIndex = 0
  }

  private flushPendingWrites(): void {
    if (this.pendingWrites.length === 0) return
    if (this.ws.readyState !== WebSocket.OPEN) return
    for (const bytes of this.pendingWrites) {
      try {
        this.ws.send(bytes as Uint8Array<ArrayBuffer>)
      } catch {
        // Drop the rest if the socket flips closed mid-flush.
        break
      }
    }
    this.pendingWrites = []
  }

  private emitTransportState(state: TransportState): void {
    for (const listener of this.transportStateListeners) {
      try {
        listener(state)
      } catch (err) {
        console.warn(`remote-terminal(${this.info.id}): transport-state listener threw:`, err)
      }
    }
  }
}

function buildSpawnUrl(endpoint: CompanionEndpoint, req: SpawnRequest): string {
  const url = new URL("/ws/v1/terminal", endpoint.baseUrl.replace(/\/$/, ""))
  url.searchParams.set("token", endpoint.token)
  url.searchParams.set("spawn", "1")
  url.searchParams.set("shell", req.shell)
  url.searchParams.set("rows", String(req.rows))
  url.searchParams.set("cols", String(req.cols))
  if (req.cwd) url.searchParams.set("cwd", req.cwd)
  if (req.projectId) url.searchParams.set("projectId", req.projectId)
  if (req.extensionId) url.searchParams.set("extensionId", req.extensionId)
  if (req.enableShellIntegration === false) {
    url.searchParams.set("shellIntegration", "0")
  }
  return url.toString()
}

function buildResumeUrl(
  endpoint: CompanionEndpoint,
  _req: SpawnRequest,
  sessionId: string,
  resumeFrom: number
): string {
  const url = new URL("/ws/v1/terminal", endpoint.baseUrl.replace(/\/$/, ""))
  url.searchParams.set("token", endpoint.token)
  url.searchParams.set("sessionId", sessionId)
  url.searchParams.set("resumeFrom", String(resumeFrom))
  return url.toString()
}

function waitForReady(ws: WebSocket, req: SpawnRequest): Promise<SessionInfo> {
  return new Promise<SessionInfo>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      ws.close()
      reject(new Error("transport-ws: ready frame timeout"))
    }, 10_000)

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return
      try {
        const frame = JSON.parse(event.data) as ControlFrame
        if (frame.kind === "ready") {
          settled = true
          clearTimeout(timeout)
          ws.removeEventListener("message", onMessage)
          resolve({
            id: frame.sessionId,
            projectId: req.projectId ?? null,
            extensionId: req.extensionId ?? null,
            origin: "remote",
            shell: frame.shell,
          })
        } else if (frame.kind === "error") {
          settled = true
          clearTimeout(timeout)
          ws.removeEventListener("message", onMessage)
          ws.close()
          reject(new Error(`transport-ws: server error — ${frame.message}`))
        }
      } catch {
        // ignore non-JSON
      }
    }
    ws.addEventListener("message", onMessage)
    ws.addEventListener("close", () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error("transport-ws: connection closed before ready"))
    })
    ws.addEventListener("error", () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error("transport-ws: connection error"))
    })
  })
}

/**
 * Helper for `spawn-orchestrator`: picks the correct transport class
 * based on the runtime shell. The orchestrator calls this once at
 * spawn time and treats both classes as a unified `TerminalSession`.
 */
export function pickRemoteSpawn(): typeof RemoteTerminalSession.spawn | null {
  if (!isCapacitor()) return null
  return RemoteTerminalSession.spawn.bind(RemoteTerminalSession)
}
