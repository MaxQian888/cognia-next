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
 *   * `?sessionId=<id>` — reconnect to an existing session.
 *
 * Frame conventions after the first text:
 *   * Binary frames Server→Client = PTY stdout.
 *   * Binary frames Client→Server = PTY stdin.
 *   * Text frames carry control envelopes (integration events,
 *     resize, kill, exit). Each control frame is `{ "kind": "…", … }`
 *     with the same tagged-enum shape as `TerminalEvent` minus the
 *     `data` variant (which uses binary frames).
 *
 * This file mirrors the public surface of `lib/terminal/session.ts` so
 * `spawn-orchestrator` can swap transports without conditionals.
 */

import { isCapacitor } from "@/lib/tauri"

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
const defaultResolver: CompanionEndpointResolver = async () => {
  if (!isCapacitor()) return null
  const { pickCompanionStorage } = await import("@/lib/tauri/companion-storage")
  const config = await pickCompanionStorage().load()
  if (!config) return null
  return {
    // Companion `baseUrl` is `https://…`; flip to `wss://…` for the
    // WS upgrade. Plain `ws://` is preserved if used (mostly dev).
    baseUrl: config.baseUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://"),
    token: config.deviceJwt,
  }
}

let endpointResolver: CompanionEndpointResolver = defaultResolver

export function configureCompanionEndpointResolver(resolver: CompanionEndpointResolver): void {
  endpointResolver = resolver
}

export function __resetEndpointResolverForTesting(): void {
  endpointResolver = defaultResolver
}

type DataListener = (bytes: Uint8Array) => void
type IntegrationListener = (event: IntegrationEvent) => void
type ExitListener = (code: number | null) => void

type ControlFrame =
  | { kind: "ready"; sessionId: string; shell: string }
  | { kind: "integration"; event: IntegrationEvent }
  | { kind: "exit"; code: number | null }
  | { kind: "error"; message: string }

/**
 * Server-side companion that owns the actual `PtySession`. From the
 * renderer's POV this class is API-compatible with `TerminalSession`
 * from `session.ts`.
 */
export class RemoteTerminalSession {
  readonly info: SessionInfo

  private readonly ws: WebSocket
  private readonly dataListeners = new Set<DataListener>()
  private readonly integrationListeners = new Set<IntegrationListener>()
  private readonly exitListeners = new Set<ExitListener>()
  private exited = false
  private exitCode: number | null = null

  private constructor(info: SessionInfo, ws: WebSocket) {
    this.info = info
    this.ws = ws
    this.wireListeners()
  }

  static async spawn(req: SpawnRequest): Promise<RemoteTerminalSession> {
    const endpoint = await endpointResolver()
    if (!endpoint) {
      throw new Error("transport-ws: companion endpoint not configured")
    }
    const url = buildSpawnUrl(endpoint, req)
    const ws = new WebSocket(url)
    ws.binaryType = "arraybuffer"
    const info = await waitForReady(ws, req)
    return new RemoteTerminalSession(info, ws)
  }

  get id(): string {
    return this.info.id
  }

  async write(data: Uint8Array | string): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    this.ws.send(bytes)
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
    if (this.exited) return
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ kind: "kill" }))
    }
    try {
      this.ws.close()
    } catch {
      /* noop */
    }
  }

  get isExited(): boolean {
    return this.exited
  }

  get lastExitCode(): number | null {
    return this.exitCode
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onIntegration(listener: IntegrationListener): () => void {
    this.integrationListeners.add(listener)
    return () => this.integrationListeners.delete(listener)
  }

  onExit(listener: ExitListener): () => void {
    if (this.exited) {
      queueMicrotask(() => listener(this.exitCode))
      return () => undefined
    }
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  private wireListeners(): void {
    this.ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const frame = JSON.parse(event.data) as ControlFrame
          this.dispatchControl(frame)
        } catch {
          // Ignore non-JSON text frames — protocol drift, server should
          // emit only valid JSON.
        }
        return
      }
      const buf = new Uint8Array(event.data as ArrayBuffer)
      for (const listener of this.dataListeners) {
        try {
          listener(buf)
        } catch (err) {
          console.warn(`remote-terminal(${this.info.id}): data listener threw:`, err)
        }
      }
    })
    this.ws.addEventListener("close", (event) => {
      this.handleExit(event.code === 1000 ? 0 : null)
    })
    this.ws.addEventListener("error", () => {
      this.handleExit(null)
    })
  }

  private dispatchControl(frame: ControlFrame): void {
    switch (frame.kind) {
      case "integration":
        for (const listener of this.integrationListeners) {
          try {
            listener(frame.event)
          } catch (err) {
            console.warn(`remote-terminal(${this.info.id}): integration listener threw:`, err)
          }
        }
        break
      case "exit":
        this.handleExit(frame.code)
        break
      case "error":
        console.warn(`remote-terminal(${this.info.id}): server error:`, frame.message)
        break
      default:
        break
    }
  }

  private handleExit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    for (const listener of this.exitListeners) {
      try {
        listener(code)
      } catch (err) {
        console.warn(`remote-terminal(${this.info.id}): exit listener threw:`, err)
      }
    }
    this.exitListeners.clear()
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
