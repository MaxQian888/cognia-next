"use client"

import { type CompanionConfig, companionStorage } from "./companion-storage"
import type { Transport } from "./transport-types"

export type { CompanionConfig } from "./companion-storage"

// ---------------------------------------------------------------------------
// Read-only command set — mirrors READ_ONLY_COMMANDS in rpc.rs exactly.
// These skip the Idempotency-Key header (they are structurally idempotent).
// ---------------------------------------------------------------------------

const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "claude_sidecar_status",
  "claude_sub_load_token",
  "claude_has_api_key",
  "claude_has_oauth_bearer",
  "skills_load_registry",
  "skills_scan_native",
  "mcp_server_status",
  "read_agent_config",
])

// ---------------------------------------------------------------------------
// Config storage
//
// Backed by lib/tauri/companion-storage.ts — picks LocalStorage on web /
// jsdom and SecureStorage (Keychain / Android Keystore) on Capacitor.
//
// The on-disk backends are async (SecureStorage has no sync API), but
// reads happen on every RPC call so we keep them sync via a module-level
// cache. The cache is primed by:
//   - explicit hydration at app boot (`hydrateCompanionConfig()`), or
//   - any successful `saveCompanionConfig()` (writes update the cache
//     synchronously before the storage round-trip).
// ---------------------------------------------------------------------------

let cachedConfig: CompanionConfig | null = null

/** Synchronous read used on the hot path (every `call()` / WS open). */
export function loadCompanionConfig(): CompanionConfig | null {
  return cachedConfig
}

/** Read storage and prime the cache. Call once at app boot. Idempotent. */
export async function hydrateCompanionConfig(): Promise<CompanionConfig | null> {
  cachedConfig = await companionStorage().load()
  return cachedConfig
}

export async function saveCompanionConfig(config: CompanionConfig): Promise<void> {
  // Cache update must run before the await so any synchronous reader (a
  // `transport.call()` chained right after) sees the new config.
  cachedConfig = config
  await companionStorage().save(config)
}

export async function clearCompanionConfig(): Promise<void> {
  cachedConfig = null
  await companionStorage().clear()
}

/** Test-only — reset the cache between cases. */
export function __resetCompanionConfigCacheForTests(): void {
  cachedConfig = null
}

// ---------------------------------------------------------------------------
// CompanionError
// ---------------------------------------------------------------------------

export type CompanionErrorCode = "network" | "timeout" | "server_error" | string

export class CompanionError extends Error {
  readonly code: CompanionErrorCode
  readonly retryable: boolean

  constructor({
    code,
    message,
    retryable,
  }: {
    code: CompanionErrorCode
    message: string
    retryable: boolean
  }) {
    super(message)
    this.name = "CompanionError"
    this.code = code
    this.retryable = retryable
  }
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionState = "connected" | "reconnecting" | "offline" | "unauthenticated"

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type Handler<T = unknown> = (payload: T) => void

/** Backoff delays for WS reconnect (ms). Capped at 30 000 ms. */
const WS_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const

/** Backoff delays for HTTP call retries (ms). */
const HTTP_BACKOFF_MS = [250, 500, 1000] as const

/** Grace period before tearing down an idle WS (ms). */
const WS_CLOSE_GRACE_MS = 30_000

/** HTTP call timeout (ms). */
const CALL_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// CompanionTransport
// ---------------------------------------------------------------------------

/**
 * Real transport for Capacitor mobile mode.
 *
 * Talks to the desktop's axum companion server via:
 * - `POST /api/v1/_rpc/<name>` for `call()`
 * - `GET  /ws/v1/events?token=<jwt>&since=<seq>` for `subscribe()`
 *
 * Config is stored in localStorage under `cognia.companion.config.v1`.
 * M3.4 will migrate that to @capacitor-community/secure-storage-plugin.
 */
export class CompanionTransport implements Transport {
  // ── WebSocket state ────────────────────────────────────────────────────────
  private ws: WebSocket | null = null
  private wsState: "idle" | "connecting" | "connected" | "reconnecting" | "closed" = "idle"
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private wsReconnectAttempt = 0
  private wsCloseGraceTimer: ReturnType<typeof setTimeout> | null = null
  private wsDestroyed = false

  /** Per-channel cursor: highest seq number seen from the server. */
  private highestSeq: Map<string, number> = new Map()

  /** Per-channel subscriber sets. */
  private channelHandlers: Map<string, Set<Handler>> = new Map()

  // ── Connection state observable ────────────────────────────────────────────
  private connectionState: ConnectionState = "offline"
  private connectionStateHandlers: Set<(state: ConnectionState) => void> = new Set()

  // ── Network awareness ──────────────────────────────────────────────────────
  private onlineListener: (() => void) | null = null
  private offlineListener: (() => void) | null = null
  private networkListenersAttached = false

  constructor() {
    this.attachNetworkListeners()
  }

  // ── Public: connection state observable ────────────────────────────────────

  public getConnectionState(): ConnectionState {
    return this.connectionState
  }

  public onConnectionStateChange(handler: (state: ConnectionState) => void): () => void {
    this.connectionStateHandlers.add(handler)
    return () => {
      this.connectionStateHandlers.delete(handler)
    }
  }

  // ── Transport.call ─────────────────────────────────────────────────────────

  async call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T> {
    const config = loadCompanionConfig()
    if (!config) {
      return Promise.reject(
        new CompanionError({
          code: "not_paired",
          message: "companion not paired — open Mobile companion settings to scan a QR",
          retryable: false,
        })
      )
    }

    const url = `${config.baseUrl}/api/v1/_rpc/${encodeURIComponent(name)}`
    const isReadOnly = READ_ONLY_COMMANDS.has(name)

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.deviceJwt}`,
      "Content-Type": "application/json",
    }
    if (!isReadOnly) {
      headers["Idempotency-Key"] = crypto.randomUUID()
    }

    return this.fetchWithRetry<T>(url, headers, JSON.stringify(args ?? {}))
  }

  // ── Transport.subscribe ────────────────────────────────────────────────────

  subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void {
    // Cancel any pending close grace timer — a new subscriber is arriving.
    if (this.wsCloseGraceTimer !== null) {
      clearTimeout(this.wsCloseGraceTimer)
      this.wsCloseGraceTimer = null
    }

    if (!this.channelHandlers.has(event)) {
      this.channelHandlers.set(event, new Set())
    }
    this.channelHandlers.get(event)!.add(handler as Handler)

    // Open WS if not already open.
    if (this.ws === null && !this.wsDestroyed) {
      this.openWebSocket()
    }

    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true

      const set = this.channelHandlers.get(event)
      if (set) {
        set.delete(handler as Handler)
        if (set.size === 0) {
          this.channelHandlers.delete(event)
        }
      }

      // If no channels remain, schedule WS close after grace period.
      if (this.channelHandlers.size === 0) {
        this.scheduleWsClose()
      }
    }
  }

  // ── Private: HTTP fetch with retry ─────────────────────────────────────────

  private async fetchWithRetry<T>(
    url: string,
    headers: Record<string, string>,
    body: string
  ): Promise<T> {
    let lastError: CompanionError | null = null

    for (let attempt = 0; attempt <= HTTP_BACKOFF_MS.length; attempt++) {
      if (attempt > 0) {
        await sleep(HTTP_BACKOFF_MS[attempt - 1])
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)

      let response: Response
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        })
      } catch (err: unknown) {
        clearTimeout(timeoutId)
        if (isAbortError(err)) {
          lastError = new CompanionError({
            code: "timeout",
            message: `request timed out after ${CALL_TIMEOUT_MS}ms (${url})`,
            retryable: true,
          })
          // Timeout is not retried.
          throw lastError
        }
        // Network error — retryable.
        lastError = new CompanionError({
          code: "network",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        })
        if (attempt < HTTP_BACKOFF_MS.length) {
          continue
        }
        throw lastError
      } finally {
        clearTimeout(timeoutId)
      }

      if (response.ok) {
        return (await response.json()) as T
      }

      if (response.status === 401) {
        // Device revoked / invalid — surface as unauthenticated.
        this.setConnectionState("unauthenticated")
        const body = await safeJson(response)
        throw new CompanionError({
          code: (body?.code as string) ?? "unauthenticated",
          message: (body?.message as string) ?? "device unauthenticated",
          retryable: false,
        })
      }

      if (response.status >= 400 && response.status < 500) {
        // 4xx — not retried.
        const body = await safeJson(response)
        throw new CompanionError({
          code: (body?.code as string) ?? `http_${response.status}`,
          message: (body?.message as string) ?? `HTTP ${response.status}`,
          retryable: false,
        })
      }

      // 5xx — retryable.
      const errBody = await safeJson(response)
      lastError = new CompanionError({
        code: "server_error",
        message: (errBody?.message as string) ?? `HTTP ${response.status}`,
        retryable: true,
      })
      if (attempt < HTTP_BACKOFF_MS.length) {
        continue
      }
      throw lastError
    }

    // Should never reach here.
    throw (
      lastError ??
      new CompanionError({ code: "network", message: "unknown fetch error", retryable: true })
    )
  }

  // ── Private: WebSocket lifecycle ───────────────────────────────────────────

  private openWebSocket(): void {
    const config = loadCompanionConfig()
    if (!config || this.wsDestroyed) return

    // Build ?since= from the highest cursor across all active channels.
    const maxSeq = this.globalMaxSeq()
    const since = maxSeq > 0 ? String(maxSeq) : ""
    const wsBase = config.baseUrl.replace(/^https?/, "wss")
    const sinceParam = since ? `&since=${since}` : ""
    const wsUrl = `${wsBase}/ws/v1/events?token=${encodeURIComponent(config.deviceJwt)}${sinceParam}`

    this.wsState = "connecting"
    this.setConnectionState("reconnecting")

    const ws = new WebSocket(wsUrl)
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return // stale reference
      this.wsState = "connected"
      this.wsReconnectAttempt = 0
      this.setConnectionState("connected")
    }

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return
      this.handleWsMessage(String(event.data))
    }

    ws.onerror = () => {
      // onerror is always followed by onclose; let onclose drive reconnect.
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.wsState = "reconnecting"
      if (!this.wsDestroyed && this.channelHandlers.size > 0) {
        this.scheduleWsReconnect()
      } else {
        this.wsState = "idle"
        this.setConnectionState("offline")
      }
    }
  }

  private handleWsMessage(raw: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    const type = frame["type"] as string | undefined
    if (!type) return

    if (type === "resync_required") {
      // Clear all cursors and force a fresh reconnect.
      this.highestSeq.clear()
      // Dispatch synthetic event to all handlers.
      for (const [, handlers] of this.channelHandlers) {
        for (const h of handlers) {
          h({ type: "resync_required" })
        }
      }
      // Close current WS and reopen (openWebSocket handles since=0).
      if (this.ws) {
        const ws = this.ws
        this.ws = null
        ws.close()
      }
      if (!this.wsDestroyed && this.channelHandlers.size > 0) {
        this.openWebSocket()
      }
      return
    }

    if (type === "ping") {
      // Reply with pong. WebSocket.OPEN === 1 per the WS spec.
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ type: "pong" }))
      }
      return
    }

    // Real event frame: { type, seq, payload, ts_ms }
    const seq = typeof frame["seq"] === "number" ? (frame["seq"] as number) : 0
    const payload = frame["payload"]

    // Update per-channel cursor.
    const prev = this.highestSeq.get(type) ?? 0
    if (seq > prev) {
      this.highestSeq.set(type, seq)
    }

    // Dispatch to handlers registered for this channel.
    const handlers = this.channelHandlers.get(type)
    if (handlers) {
      for (const h of handlers) {
        h(payload)
      }
    }
  }

  private scheduleWsReconnect(): void {
    if (this.wsReconnectTimer !== null) return
    this.setConnectionState("reconnecting")

    const idx = Math.min(this.wsReconnectAttempt, WS_BACKOFF_MS.length - 1)
    const delay = WS_BACKOFF_MS[idx]
    this.wsReconnectAttempt++

    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null
      if (!this.wsDestroyed && this.channelHandlers.size > 0) {
        this.openWebSocket()
      }
    }, delay)
  }

  private scheduleWsClose(): void {
    if (this.wsCloseGraceTimer !== null) return
    this.wsCloseGraceTimer = setTimeout(() => {
      this.wsCloseGraceTimer = null
      // Only close if still no active channels.
      if (this.channelHandlers.size === 0) {
        this.closeWebSocket()
      }
    }, WS_CLOSE_GRACE_MS)
  }

  private closeWebSocket(): void {
    if (this.wsReconnectTimer !== null) {
      clearTimeout(this.wsReconnectTimer)
      this.wsReconnectTimer = null
    }
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      ws.close()
    }
    this.wsState = "idle"
    this.setConnectionState("offline")
  }

  /** Highest seq seen across all active channels (for WS reconnect since=). */
  private globalMaxSeq(): number {
    let max = 0
    for (const [, seq] of this.highestSeq) {
      if (seq > max) max = seq
    }
    return max
  }

  // ── Private: connection state ──────────────────────────────────────────────

  private setConnectionState(next: ConnectionState): void {
    if (this.connectionState === next) return
    this.connectionState = next
    for (const h of this.connectionStateHandlers) {
      h(next)
    }
  }

  // ── Private: network awareness ─────────────────────────────────────────────

  private attachNetworkListeners(): void {
    if (typeof window === "undefined" || this.networkListenersAttached) return
    this.networkListenersAttached = true

    this.onlineListener = () => {
      if (this.channelHandlers.size > 0 && this.ws === null && !this.wsDestroyed) {
        this.wsReconnectAttempt = 0
        this.openWebSocket()
      }
    }
    this.offlineListener = () => {
      // Cancel any pending reconnect; mark offline.
      if (this.wsReconnectTimer !== null) {
        clearTimeout(this.wsReconnectTimer)
        this.wsReconnectTimer = null
      }
      this.setConnectionState("offline")
    }

    window.addEventListener("online", this.onlineListener)
    window.addEventListener("offline", this.offlineListener)
  }

  /** Release all resources. Intended for cleanup in tests. */
  public destroy(): void {
    this.wsDestroyed = true
    if (this.wsReconnectTimer !== null) {
      clearTimeout(this.wsReconnectTimer)
      this.wsReconnectTimer = null
    }
    if (this.wsCloseGraceTimer !== null) {
      clearTimeout(this.wsCloseGraceTimer)
      this.wsCloseGraceTimer = null
    }
    this.closeWebSocket()
    if (typeof window !== "undefined") {
      if (this.onlineListener) window.removeEventListener("online", this.onlineListener)
      if (this.offlineListener) window.removeEventListener("offline", this.offlineListener)
    }
    this.channelHandlers.clear()
    this.connectionStateHandlers.clear()
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError"
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}
