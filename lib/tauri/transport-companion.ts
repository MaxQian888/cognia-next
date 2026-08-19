"use client"

import { classifyWsHost } from "@/lib/connectivity/lan-classify"
import { isCapacitor, isTauri } from "@/lib/platform/detect"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { getCommandDescriptor } from "./command-descriptors"
import { type CompanionConfig, companionStorage } from "./companion-storage"
import type {
  Transport,
  TransportBinaryResource,
  TransportBinaryResponse,
  TransportCallOptions,
} from "./transport-types"
import { pinnedFetch } from "./pinned-fetch"
import {
  companionAuthorizationHeaders,
  invalidateCompanionAccessToken,
  issueSocketTicket,
  type SocketTicketRequest,
} from "./companion-auth"
import { remoteEventResyncCoordinator } from "./resync-coordinator"
import { TransportRtc, type TransportRtcOptions } from "./transport-rtc"

export type { CompanionConfig } from "./companion-storage"

export interface ManagedIdeContentContext {
  root: string
  generation: number
  pluginId: string
  providerId: string
  permission: string | null
  mediaType?: string
}

function encodeContentContext(context: ManagedIdeContentContext): string {
  const bytes = new TextEncoder().encode(JSON.stringify(context))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

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
//   - any successful `saveCompanionConfig()` (writes update the cache only
//     after secure persistence succeeds).
// ---------------------------------------------------------------------------

let cachedConfig: CompanionConfig | null = null
let runtimeTargetRegistrarOverride: ((config: CompanionConfig) => Promise<void>) | null = null

/** Synchronous read used on the hot path (every `call()` / WS open). */
export function loadCompanionConfig(): CompanionConfig | null {
  return cachedConfig
}

/** Issue a canonical socket ticket for the active paired Companion target. */
export async function issueCompanionSocketTicket(
  request: SocketTicketRequest
): Promise<{ ticket: string; expiresAt: number }> {
  const config = loadCompanionConfig()
  if (!config) throw new Error("companion device identity is unavailable; pair this device again")
  return issueSocketTicket(config, request)
}

/** Read storage and prime the cache. Call once at app boot. Idempotent. */
export async function hydrateCompanionConfig(): Promise<CompanionConfig | null> {
  const stored = await companionStorage().load()
  cachedConfig = stored ? await attachWebRuntimeTarget(stored, true) : null
  // `pickTransport()` decides at module load, before the Vault is unlocked and
  // before any runtime target is active, so a browser that IS paired can boot
  // holding the honest-but-useless `WebStubTransport`. Once a pairing has
  // actually resolved, upgrade — otherwise every consumer of the hydrated
  // config dispatches into the stub and the session looks unpaired.
  //
  // Deliberately one-way: downgrading to the stub belongs to the explicit
  // owners (`clearCompanionConfig`, `reloadCompanionConfigForActiveTarget`,
  // `suspendCompanionTransport`). Mid-session callers re-hydrate for their own
  // reasons and must not tear down a live transport on a transient null.
  if (cachedConfig) await ensureWebCompanionTransport()
  return cachedConfig
}

export async function saveCompanionConfig(config: CompanionConfig): Promise<void> {
  const storage = companionStorage()
  const previousStored = isPlainBrowser() ? await storage.load() : null
  const nextConfig = await attachWebRuntimeTarget(config, false, false)
  await storage.save(nextConfig)
  try {
    await registerWebRuntimeTarget(nextConfig)
  } catch (error) {
    // Secure persistence and the runtime target registry live in different
    // stores. Compensate the first write if the second cannot commit so a
    // failed pair never appears as a target with unusable runtime state.
    if (storage.remove) await storage.remove(nextConfig)
    if (previousStored) await storage.save(previousStored)
    else if (!storage.remove) await storage.clear()
    throw error
  }
  cachedConfig = nextConfig
  await activateWebCompanionTransport()
  notifyCompanionConfigChanged()
}

export async function clearCompanionConfig(): Promise<void> {
  cachedConfig = null
  await companionStorage().clear()
  if (isPlainBrowser()) {
    const [{ detachActiveCompanionRuntimeTarget }, { setTransport }, { WebStubTransport }] =
      await Promise.all([
        import("@/lib/runtime/account-runtime-target"),
        import("./transport-instance"),
        import("./transport-web"),
      ])
    await detachActiveCompanionRuntimeTarget()
    setTransport(new WebStubTransport())
  }
  notifyCompanionConfigChanged()
}

/**
 * Rebind the process transport after the active Web runtime target changes.
 * The target registry/database pointer must already be switched. Companion
 * credentials are resolved by targetId from the unlocked Vault; standalone
 * targets deliberately resolve to null and install the honest Web stub.
 */
export async function reloadCompanionConfigForActiveTarget(options?: {
  notify?: boolean
}): Promise<CompanionConfig | null> {
  if (isTauri()) return loadCompanionConfig()
  cachedConfig = await companionStorage().load()
  if (isPlainBrowser()) {
    if (cachedConfig) {
      await activateWebCompanionTransport()
    } else {
      const [{ setTransport }, { WebStubTransport }] = await Promise.all([
        import("./transport-instance"),
        import("./transport-web"),
      ])
      setTransport(new WebStubTransport())
    }
  }
  if (options?.notify !== false) notifyCompanionConfigChanged()
  return cachedConfig
}

/**
 * Fail closed after an incomplete target rollback. Persisted pairings remain
 * available for recovery, but the process cache cannot dispatch until a
 * later explicit activation succeeds.
 */
export async function suspendCompanionTransport(): Promise<void> {
  cachedConfig = null
  if (isPlainBrowser()) {
    const [{ setTransport }, { WebStubTransport }] = await Promise.all([
      import("./transport-instance"),
      import("./transport-web"),
    ])
    setTransport(new WebStubTransport())
  }
  notifyCompanionConfigChanged()
}

/** Test-only — reset the cache between cases. */
export function __resetCompanionConfigCacheForTests(): void {
  cachedConfig = null
}

/** Test-only — seed the active config without touching secure storage. */
export function __setCompanionConfigCacheForTests(config: CompanionConfig | null): void {
  cachedConfig = config
}

/** Test-only seam for cross-store compensation failures. */
export function __setRuntimeTargetRegistrarForTests(
  registrar: ((config: CompanionConfig) => Promise<void>) | null
): void {
  runtimeTargetRegistrarOverride = registrar
}

async function attachWebRuntimeTarget(
  config: CompanionConfig,
  persistAssignedTarget: boolean,
  registerTarget = true
): Promise<CompanionConfig> {
  if (!isPlainBrowser() || !getActiveRuntimeTargetContext()) return config
  const { deriveCompanionRuntimeTargetId } = await import("@/lib/runtime/account-runtime-target")
  const targetId = config.targetId ?? (await deriveCompanionRuntimeTargetId(config))
  const nextConfig = {
    ...config,
    targetId,
    accountId: getActiveRuntimeTargetContext()!.accountId,
  }
  if (persistAssignedTarget && config.targetId !== targetId) {
    await companionStorage().save(nextConfig)
  }
  if (registerTarget) await registerWebRuntimeTarget(nextConfig)
  return nextConfig
}

async function registerWebRuntimeTarget(config: CompanionConfig): Promise<void> {
  if (!isPlainBrowser()) return
  if (runtimeTargetRegistrarOverride) return runtimeTargetRegistrarOverride(config)
  const { registerCompanionRuntimeTarget } = await import("@/lib/runtime/account-runtime-target")
  await registerCompanionRuntimeTarget(config)
}

async function activateWebCompanionTransport(): Promise<void> {
  if (!isPlainBrowser()) return
  const { setTransport } = await import("./transport-instance")
  setTransport(new CompanionTransport())
}

/**
 * Install the companion transport only if the stub is still in place.
 *
 * The unconditional {@link activateWebCompanionTransport} is right after a
 * pair or a target switch — the identity underneath changed, so a clean
 * instance is wanted. Boot-time hydration is the opposite case: it can run
 * mid-session (fleet, remote sessions, the signaling controller all re-hydrate),
 * and rebuilding a live transport there would drop its open subscriptions.
 */
async function ensureWebCompanionTransport(): Promise<void> {
  if (!isPlainBrowser()) return
  const instance = await import("./transport-instance")
  if (instance.transport instanceof CompanionTransport) return
  instance.setTransport(new CompanionTransport())
}

function notifyCompanionConfigChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("cognia:companion-config-changed"))
  }
}

function isPlainBrowser(): boolean {
  return typeof window !== "undefined" && !isTauri() && !isCapacitor()
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

export interface CompanionPlaneHealth {
  rpc: "unknown" | "ready" | "unavailable" | "unauthenticated"
  events: "idle" | "connecting" | "replaying" | "ready"
}

// ---------------------------------------------------------------------------
// Transport tier — ADR-0021
//
// A finer-grained view than `ConnectionState`: callers (the mobile settings
// panel, debug overlays) want to know **how** they're reaching the desktop,
// not just whether they're connected.
// ---------------------------------------------------------------------------

export type TransportTier =
  /** DataChannel open, no relay candidate selected (host / srflx / prflx). */
  | "rtc-direct"
  /** DataChannel open, ICE chose a TURN relay candidate. */
  | "rtc-relay"
  /** HTTPS+WS open, host resolves to a LAN/loopback address. */
  | "ws-lan"
  /** HTTPS+WS open, host is on the public internet (tunnel / forwarded). */
  | "ws-tunnel"
  /** Neither transport is connected. */
  | "offline"

// `classifyWsHost` moved to `lib/connectivity/lan-classify.ts` (ADR-0021) so
// the runtime LAN re-resolver can reuse it without importing this heavy
// `"use client"` module. Re-exported here so existing imports/tests are
// unaffected; the runtime caller is [`CompanionTransport.recomputeTier`].
export { classifyWsHost }

function requiresNativePinnedWebSocket(config: CompanionConfig): boolean {
  return Boolean(config.serverFingerprint) && classifyWsHost(config.baseUrl) === "ws-lan"
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type Handler<T = unknown> = (payload: T) => void

/** Backoff delays for WS reconnect (ms). Capped at 30 000 ms. */
const WS_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const

const HTTP_MAX_ATTEMPTS = 3
const HTTP_BACKOFF_BASE_MS = 250
const HTTP_BACKOFF_CAP_MS = 2_000
const HTTP_RETRY_AFTER_CAP_MS = 30_000
const BINARY_HTTP_BACKOFF_MS = [250, 500, 1_000] as const

/** Grace period before tearing down an idle WS (ms). */
const WS_CLOSE_GRACE_MS = 30_000

/** HTTP call timeout (ms). */
const CALL_TIMEOUT_MS = 30_000

/** Canonical chat images share the composer's existing 10 MiB input ceiling. */
const MAX_SESSION_MEDIA_BYTES = 10 * 1024 * 1024

type EventSocketTicket = { ticket: string; expiresAt: number }
type EventSocketTicketIssuer = (
  config: CompanionConfig,
  channel: "events"
) => EventSocketTicket | Promise<EventSocketTicket>
let eventSocketTicketIssuer: EventSocketTicketIssuer = issueSocketTicket
type AuthorizationHeadersProvider = (
  config: CompanionConfig,
  method: string,
  path: string
) => Promise<Record<string, string>>
let authorizationHeadersProvider: AuthorizationHeadersProvider = companionAuthorizationHeaders

export function __setEventSocketTicketIssuerForTests(issuer: EventSocketTicketIssuer | null): void {
  eventSocketTicketIssuer = issuer ?? issueSocketTicket
}

export function __setAuthorizationHeadersProviderForTests(
  provider: AuthorizationHeadersProvider | null
): void {
  authorizationHeadersProvider = provider ?? companionAuthorizationHeaders
}

/** Jitter randomness source — overridable so reconnect-timing tests stay
 * deterministic while production gets real spread. */
let backoffRandom: () => number = Math.random

/** Test seam: pin the jitter source. Pass `null` to restore `Math.random`. */
export function __setBackoffRandomForTests(fn: (() => number) | null): void {
  backoffRandom = fn ?? Math.random
}

/**
 * Spread a backoff delay by ±15% so a fleet of devices that all dropped on
 * the same Wi-Fi flap don't reconnect in lockstep and hammer the desktop in a
 * synchronized thundering herd.
 */
function withJitter(ms: number): number {
  return Math.round(ms * (0.85 + backoffRandom() * 0.3))
}

// ---------------------------------------------------------------------------
// CompanionTransport
// ---------------------------------------------------------------------------

/**
 * Real transport for Capacitor mobile mode.
 *
 * Talks to the desktop's axum companion server via:
 * - `POST /api/_rpc/<name>` for `call()`
 * - `GET  /ws/events?ticket=<single-use-ticket>&since=<seq>` for `subscribe()`
 *
 * Device private keys are persisted through the credential-book secure
 * storage adapter; short-lived access tokens remain memory-only.
 */
export class CompanionTransport implements Transport {
  // ── WebSocket state ────────────────────────────────────────────────────────
  private ws: WebSocket | null = null
  private wsState: "idle" | "connecting" | "connected" | "reconnecting" | "closed" = "idle"
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private wsReconnectAttempt = 0
  private wsCloseGraceTimer: ReturnType<typeof setTimeout> | null = null
  private wsDestroyed = false
  private wsResyncInFlight: Promise<void> | null = null

  /** Per-channel cursor: highest seq number seen from the server. */
  private highestSeq: Map<string, number> = new Map()

  /** Per-channel subscriber sets. */
  private channelHandlers: Map<string, Set<Handler>> = new Map()
  /** Channels the host refused on the last subscribe frame (diagnostics). */
  private lastRejectedChannels: string[] = []
  /** Last `subscribe_error` message from the host, if any (diagnostics). */
  private lastSubscribeError: string | null = null

  // ── Connection state observable ────────────────────────────────────────────
  private connectionState: ConnectionState = "offline"
  private connectionStateHandlers: Set<(state: ConnectionState) => void> = new Set()
  private planeHealth: CompanionPlaneHealth = { rpc: "unknown", events: "idle" }
  private planeHealthHandlers: Set<(health: CompanionPlaneHealth) => void> = new Set()

  // ── Network awareness ──────────────────────────────────────────────────────
  private onlineListener: (() => void) | null = null
  private offlineListener: (() => void) | null = null
  private networkListenersAttached = false

  // ── WebRTC tier (ADR-0021) ─────────────────────────────────────────────────
  /** Active `TransportRtc` once the DataChannel is open; null otherwise. */
  private rtc: TransportRtc | null = null
  /** Peer currently negotiating, retained so credential rotation can update it. */
  private rtcConnectingInstance: TransportRtc | null = null
  /** Tracks whether an upgrade attempt is currently in flight, so repeat
   *  calls to `enableWebRtcTier` don't stack. */
  private rtcConnecting: Promise<void> | null = null
  /** Unsubscribe handle for the rtc state listener. */
  private rtcDetach: (() => void) | null = null
  /**
   * Last options passed to `enableWebRtcTier`, retained so `reconnectRtc()`
   * can re-establish the tier after it dropped to `failed`/`closed` (which
   * nulls `this.rtc`). Without this the "Reconnect" button was a dead no-op
   * at exactly the moment the user reaches for it — see ADR-0021 F2. Cleared
   * by `disableWebRtcTier()` (an explicit teardown is not a candidate for
   * silent re-establishment).
   */
  private lastEnableOptions: Parameters<CompanionTransport["enableWebRtcTier"]>[0] | null = null

  // ── Transport-tier cache (ADR-0021 follow-up) ──────────────────────────────
  /**
   * Latest tier value emitted to subscribers. Mutated only by
   * [`setTier`](#setTier); never set directly.
   */
  private tierCache: TransportTier = "offline"
  /** Subscribers to tier-change notifications. */
  private tierListeners: Set<(t: TransportTier) => void> = new Set()
  /**
   * Cached `local-candidate.candidateType` for the currently-open RTC
   * peer. Refreshed asynchronously by [`recomputeTier`](#recomputeTier)
   * on every RTC state transition; `"unknown"` until the first sample
   * lands.
   */
  private rtcCandidateKind: "host" | "srflx" | "prflx" | "relay" | "unknown" = "unknown"

  /**
   * Optional config source override (ADR-0059 T-B2). When set, every config
   * read in this instance goes through it instead of the module-level
   * storage cache — the headless brain injects an in-memory
   * `{ baseUrl, serviceToken, deviceId: "brain-<id>" }` that is
   * never persisted (token refreshes just change the provider's return).
   * The wire shape is unchanged; mobile/web instances pass nothing.
   */
  private readonly configProvider: (() => CompanionConfig | null) | null
  private readonly rpcPath: string
  private readonly eventsPath: string

  constructor(
    opts: {
      configProvider?: () => CompanionConfig | null
      rpcPath?: string
      eventsPath?: string
    } = {}
  ) {
    this.configProvider = opts.configProvider ?? null
    this.rpcPath = opts.rpcPath ?? "/api/_rpc"
    this.eventsPath = opts.eventsPath ?? "/ws/events"
    this.attachNetworkListeners()
  }

  /** The active config: injected provider first, storage cache otherwise. */
  private config(): CompanionConfig | null {
    return this.configProvider ? this.configProvider() : loadCompanionConfig()
  }

  // ── Public: connection state observable ────────────────────────────────────

  public getConnectionState(): ConnectionState {
    return this.connectionState
  }

  /**
   * Fetch a session-scoped media variant as raw bytes. The endpoint performs
   * the session-to-hash authorization check; this client validates the opaque
   * identifiers and response budget before retaining anything in memory.
   */
  public async readBinary(resource: TransportBinaryResource): Promise<TransportBinaryResponse> {
    const config = this.config()
    if (!config) {
      throw new CompanionError({
        code: "not_paired",
        message: "companion not paired",
        retryable: false,
      })
    }
    if (
      resource.kind !== "session-media" ||
      resource.sessionId.length === 0 ||
      resource.sessionId.length > 512 ||
      !/^[a-f0-9]{64}$/.test(resource.hash) ||
      !["thumbnail", "canonical", "original"].includes(resource.variant)
    ) {
      throw new CompanionError({
        code: "invalid_binary_resource",
        message: "invalid session media resource",
        retryable: false,
      })
    }

    if (this.rtc && this.rtc.getState() === "open" && !this.isOnConnectedLan()) {
      try {
        return await this.rtc.readBinary(resource)
      } catch (error) {
        const code =
          error && typeof error === "object" ? String((error as { code?: unknown }).code ?? "") : ""
        if (
          [
            "INVALID_PARAMS",
            "MEDIA_NOT_FOUND",
            "device_revoked",
            "rate_limited",
            "binary_resource_too_large",
          ].includes(code)
        ) {
          throw error
        }
        // Read-only resource requests are safe to retry over authenticated
        // HTTPS. Do not log the session id, hash, or resource URL.
      }
    }

    const baseUrl = config.baseUrl.replace(/\/+$/, "")
    const url = `${baseUrl}/api/sessions/${encodeURIComponent(resource.sessionId)}/media/${resource.hash}?variant=${resource.variant}`
    return this.fetchBinaryWithRetry(url, config, new URL(url).pathname)
  }

  public onConnectionStateChange(handler: (state: ConnectionState) => void): () => void {
    this.connectionStateHandlers.add(handler)
    return () => {
      this.connectionStateHandlers.delete(handler)
    }
  }

  public getPlaneHealth(): CompanionPlaneHealth {
    return { ...this.planeHealth }
  }

  public onPlaneHealthChange(handler: (health: CompanionPlaneHealth) => void): () => void {
    this.planeHealthHandlers.add(handler)
    handler(this.getPlaneHealth())
    return () => {
      this.planeHealthHandlers.delete(handler)
    }
  }

  // ── Transport.call ─────────────────────────────────────────────────────────

  async call<T = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: TransportCallOptions
  ): Promise<T> {
    const config = this.config()
    if (!config) {
      return Promise.reject(
        new CompanionError({
          code: "not_paired",
          message: "companion not paired — open Mobile companion settings to scan a QR",
          retryable: false,
        })
      )
    }

    // ADR-0021 — route through the WebRTC DataChannel when it is open,
    // UNLESS we're on a connected LAN (mDNS HTTPS+WS is preferred when
    // available — WebRTC is consulted only when LAN is unavailable). The
    // TransportRtc surface returns the same `result` payload the HTTP path
    // would, so callers see no difference.
    const descriptor = getCommandDescriptor(name)
    const isReadOnly = descriptor?.operation === "read"
    // Mint the idempotency key once and reuse it across the RTC attempt and
    // the HTTPS fallback. If the DataChannel write reached the server and ran
    // before the channel hard-failed, the fallback request carrying the same
    // key lets the server dedupe instead of double-executing the command.
    const idempotencyKey = isReadOnly ? undefined : (options?.idempotencyKey ?? crypto.randomUUID())
    if (this.rtc && this.rtc.getState() === "open" && !this.isOnConnectedLan()) {
      try {
        const params = args ?? {}
        return await this.rtc.call<T>(name, params, { idempotencyKey })
      } catch (err) {
        // Hard-fail on the data channel → fall back to HTTPS. The data
        // channel teardown is handled by its own state listener; we just
        // proceed below and let the existing path run.
        console.warn("CompanionTransport: WebRTC RPC failed, falling back to HTTPS", err)
      }
    }

    const url = `${config.baseUrl}${this.rpcPath}/${encodeURIComponent(name)}`

    const path = `${this.rpcPath}/${encodeURIComponent(name)}`
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey
    }

    const retryable =
      descriptor?.operation === "read" ||
      (descriptor?.idempotency === "required" && idempotencyKey !== undefined)
    return this.fetchWithRetry<T>(url, config, path, headers, JSON.stringify(args ?? {}), retryable)
  }

  /**
   * One-shot raw content upload for the headless managed IDE broker. This is
   * intentionally not implemented through `call`: binary values must not be
   * expanded into JSON arrays/base64, and actions are never auto-retried.
   */
  async uploadManagedIdeContent<T>(
    context: ManagedIdeContentContext,
    bytes: Uint8Array
  ): Promise<T> {
    const config = this.config()
    if (!config) throw new Error("companion not paired")
    const body = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(body).set(bytes)
    const path = "/ide/content"
    const response = await pinnedFetch(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        ...(await authorizationHeadersProvider(config, "POST", path)),
        "Content-Type": context.mediaType ?? "application/octet-stream",
        "X-Cognia-Content-Context": encodeContentContext(context),
      },
      body,
      serverFingerprint: config.serverFingerprint,
    })
    if (!response.ok) {
      throw new Error(
        `managed IDE content upload failed (${response.status}): ${await response.text()}`
      )
    }
    return (await response.json()) as T
  }

  /** Redeem a one-shot generation-bound content handle as raw bytes. */
  async redeemManagedIdeContent(
    context: ManagedIdeContentContext,
    handleId: string
  ): Promise<Uint8Array> {
    const config = this.config()
    if (!config) throw new Error("companion not paired")
    const path = `/ide/content/${encodeURIComponent(handleId)}`
    const response = await pinnedFetch(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "GET",
      headers: {
        ...(await authorizationHeadersProvider(config, "GET", path)),
        "X-Cognia-Content-Context": encodeContentContext(context),
      },
      serverFingerprint: config.serverFingerprint,
    })
    if (!response.ok) {
      throw new Error(
        `managed IDE content redemption failed (${response.status}): ${await response.text()}`
      )
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  // ── Transport.subscribe ────────────────────────────────────────────────────

  subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void {
    // Cancel any pending close grace timer — a new subscriber is arriving.
    if (this.wsCloseGraceTimer !== null) {
      clearTimeout(this.wsCloseGraceTimer)
      this.wsCloseGraceTimer = null
    }

    const isNewChannel = !this.channelHandlers.has(event)
    if (isNewChannel) {
      this.channelHandlers.set(event, new Set())
    }
    this.channelHandlers.get(event)!.add(handler as Handler)
    // Channels that are not `default_on` in the host catalog (e.g.
    // `workflow:trigger`, `scheduler:task-due`) are only delivered after the
    // client asks for them; widen the live subscription when the socket is
    // already open (a fresh open re-sends the whole set in `onopen`).
    if (isNewChannel) this.sendSubscribeFrame("add", [event])

    // ADR-0021 — also wire the subscription on the WebRTC tier when it is
    // open AND we're not on a connected LAN (LAN-first: prefer the direct
    // WS path when available). We keep both paths active otherwise; the
    // WebRTC tier wins for ordering when both deliver the same
    // `(event, seq)` because the dispatcher only forwards once per
    // `EventBus` frame.
    const config = this.config()
    let rtcUnsub: (() => void) | null = null
    if (
      this.rtc &&
      this.rtc.getState() === "open" &&
      (!this.isOnConnectedLan() || (config !== null && requiresNativePinnedWebSocket(config)))
    ) {
      rtcUnsub = this.rtc.subscribe(event, handler as Handler)
    }

    // Open WS if not already open.
    if (this.ws === null && !this.wsDestroyed) {
      this.openWebSocket()
    }

    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true

      if (rtcUnsub) rtcUnsub()

      const set = this.channelHandlers.get(event)
      if (set) {
        set.delete(handler as Handler)
        if (set.size === 0) {
          this.channelHandlers.delete(event)
          this.sendSubscribeFrame("remove", [event])
        }
      }

      // If no channels remain, schedule WS close after grace period.
      if (this.channelHandlers.size === 0) {
        this.scheduleWsClose()
      }
    }
  }

  /**
   * Send a `subscribe` control frame on the open events socket. The host
   * replies with `subscribed` (accepted + rejected channels) or
   * `subscribe_error`. No-op while the socket is not open — `onopen`
   * re-sends the whole handler set. Exposed as `subscriptionDiagnostics()`
   * for tests / the connection panel.
   */
  private sendSubscribeFrame(mode: "add" | "remove" | "replace", channels: string[]): void {
    if (channels.length === 0) return
    // WebSocket.OPEN === 1 per the WS spec.
    if (!this.ws || this.ws.readyState !== 1) return
    try {
      this.ws.send(JSON.stringify({ type: "subscribe", mode, channels }))
    } catch {
      // A send failure surfaces through onclose → reconnect → onopen re-send.
    }
  }

  /** Diagnostics for the last subscribe control-frame exchange. */
  subscriptionDiagnostics(): {
    channels: string[]
    rejectedChannels: string[]
    lastError: string | null
  } {
    return {
      channels: Array.from(this.channelHandlers.keys()),
      rejectedChannels: [...this.lastRejectedChannels],
      lastError: this.lastSubscribeError,
    }
  }

  // ── ADR-0021: WebRTC tier upgrade ──────────────────────────────────────────

  /**
   * Opportunistically open a WebRTC `RTCDataChannel` to the paired
   * desktop and route subsequent RPCs / event subscriptions through it.
   *
   * Idempotent: re-calling while a connection is already open or in
   * progress is a no-op. Returns the promise of the in-flight attempt
   * so callers can `await` first-open without racing.
   *
   * Fails silently (returns without rejecting) when the connection
   * doesn't establish — the HTTPS+WS path stays the active transport.
   */
  public async enableWebRtcTier(
    options: Omit<
      TransportRtcOptions,
      "rendezvousId" | "signalingRoomDescriptor" | "signalingPrivateKey" | "deviceId"
    > & {
      /** Override the storage-loaded config (test injection). */
      configOverride?: CompanionConfig
    }
  ): Promise<void> {
    // Retain the options for `reconnectRtc()`'s re-establish path even when
    // this particular call short-circuits — the tier may already be open, but
    // a future failure still needs the config to rebuild.
    this.lastEnableOptions = options
    if (this.rtc) {
      this.rtc.updateRtcConfiguration(options.rtcConfiguration)
      return
    }
    if (this.rtcConnecting) {
      this.rtcConnectingInstance?.updateRtcConfiguration(options.rtcConfiguration)
      return this.rtcConnecting
    }
    const config = options.configOverride ?? this.config()
    if (!config) {
      console.warn("CompanionTransport.enableWebRtcTier: companion not paired")
      return
    }
    if (!config.rendezvousId || !config.signalingRoomDescriptor || !config.signalingPrivateKey) {
      return
    }

    const rtc = new TransportRtc({
      signalingUrl: options.signalingUrl,
      rendezvousId: config.rendezvousId,
      signalingRoomDescriptor: config.signalingRoomDescriptor,
      signalingPrivateKey: config.signalingPrivateKey,
      deviceId: config.deviceId,
      rtcConfiguration: options.rtcConfiguration,
      negotiationTimeoutMs: options.negotiationTimeoutMs,
      peerConnectionFactory: options.peerConnectionFactory,
      signalingClientFactory: options.signalingClientFactory,
    })
    this.rtcConnectingInstance = rtc

    this.rtcDetach = rtc.onStateChange((state) => {
      if (state === "closed" || state === "failed") {
        // Drop our reference so call() / subscribe() stop routing through it.
        if (this.rtc === rtc) {
          this.rtc = null
          if (this.rtcDetach) {
            this.rtcDetach()
            this.rtcDetach = null
          }
          this.rtcCandidateKind = "unknown"
        }
      }
      // Any RTC state transition can shift the tier (open → rtc-*,
      // closed → ws-* / offline). Re-run classification.
      void this.recomputeTier()
    })

    this.rtcConnecting = (async () => {
      try {
        await rtc.connect()
        this.rtc = rtc
        // Promote to rtc-* — recomputeTier will inspect candidate stats.
        void this.recomputeTier()
      } catch (err) {
        console.warn("CompanionTransport.enableWebRtcTier: connect failed", err)
        try {
          rtc.close()
        } catch {
          // ignored
        }
        if (this.rtcDetach) {
          this.rtcDetach()
          this.rtcDetach = null
        }
        // Failed upgrade — tier drops back to whatever the WS path says.
        void this.recomputeTier()
      } finally {
        if (this.rtcConnectingInstance === rtc) {
          this.rtcConnectingInstance = null
        }
        this.rtcConnecting = null
      }
    })()
    return this.rtcConnecting
  }

  /**
   * Force a fresh WebRTC handshake. Wired to the "Reconnect WebRTC" button
   * on the mobile settings panel.
   *
   * - `"ok"`         — handshake is being torn down + restarted, OR (when the
   *                    tier had dropped to `failed`/`closed` and `this.rtc` is
   *                    null) a fresh upgrade is being re-established from the
   *                    cached options. This is the ADR-0021 F2 path: the
   *                    button now works at exactly the moment a user reaches
   *                    for it — after a failure — instead of returning
   *                    `no-tier`.
   * - `"busy"`       — an action (connect / negotiate / await-peer / closing)
   *                    is already in flight; the click was acknowledged but is
   *                    a no-op. Distinct from `throttled` so the UI can say
   *                    "already reconnecting" rather than "slow down".
   * - `"no-tier"`    — never enabled this session; user must configure it.
   * - `"throttled"`  — called within 5 s of the previous successful call;
   *                    defends against an XSS-driven flood.
   */
  public reconnectRtc(): "ok" | "busy" | "no-tier" | "throttled" {
    if (this.rtc) {
      const outcome = this.rtc.reconnectNow()
      return outcome === "started" ? "ok" : outcome
    }
    // No live instance, but we know how to build one — re-establish rather
    // than reporting a dead tier.
    if (this.lastEnableOptions) {
      void this.enableWebRtcTier(this.lastEnableOptions)
      return "ok"
    }
    return "no-tier"
  }

  /**
   * Expose the terminal-only channel without widening the generic Transport
   * interface. The terminal subsystem feature-detects this capability on the
   * active Companion transport and applies its own canonical binary framing.
   */
  public getTerminalDataChannel(): RTCDataChannel | null {
    return (
      this.rtc?.getTerminalDataChannel() ??
      this.rtcConnectingInstance?.getTerminalDataChannel() ??
      null
    )
  }

  public getTerminalClientId(): string | null {
    const deviceId = this.config()?.deviceId
    return deviceId ? `companion:${deviceId}` : null
  }

  /** Tear down the WebRTC tier explicitly. Called from `destroy()`. */
  public disableWebRtcTier(): void {
    if (this.rtcDetach) {
      this.rtcDetach()
      this.rtcDetach = null
    }
    if (this.rtc) {
      try {
        this.rtc.close()
      } catch {
        // ignored
      }
      this.rtc = null
    }
    this.rtcConnecting = null
    this.rtcConnectingInstance = null
    this.rtcCandidateKind = "unknown"
    // An explicit teardown (settings toggle off, LAN reachable, destroy) is
    // NOT a candidate for `reconnectRtc()`'s silent re-establish — drop the
    // cached options so a later reconnect returns `no-tier` rather than
    // resurrecting a tier the caller deliberately disabled.
    this.lastEnableOptions = null
    // Falling back to the WS tier — recompute so subscribers see the
    // change immediately rather than on the next setConnectionState.
    void this.recomputeTier()
  }

  /**
   * ADR-0021 — force the events WebSocket to re-open against the current
   * `config.baseUrl`. Used by the mobile LAN re-resolver after it repoints
   * `baseUrl` to a freshly-discovered LAN address, so the socket binds to
   * the LAN host and `connectionState` / tier recompute against it.
   *
   * No-op when there are no active channels — the next `subscribe()` opens
   * a fresh socket against the new baseUrl on its own.
   */
  public reconnectWs(): void {
    if (this.wsDestroyed) return
    if (this.wsReconnectTimer !== null) {
      clearTimeout(this.wsReconnectTimer)
      this.wsReconnectTimer = null
    }
    if (this.wsCloseGraceTimer !== null) {
      clearTimeout(this.wsCloseGraceTimer)
      this.wsCloseGraceTimer = null
    }
    if (this.ws) {
      // Null the ref BEFORE closing so the stale-reference guard in
      // `onclose` (`if (this.ws !== ws) return`) suppresses the automatic
      // reconnect — we drive the re-open ourselves against the new baseUrl.
      const ws = this.ws
      this.ws = null
      try {
        ws.close()
      } catch {
        // ignored
      }
    }
    this.wsReconnectAttempt = 0
    if (this.channelHandlers.size > 0) {
      this.openWebSocket()
    } else {
      this.wsState = "idle"
      this.setPlaneHealth({ events: "idle" })
      this.setConnectionState("offline")
    }
  }

  /**
   * ADR-0021 — true when a live HTTPS+WS connection is open against a
   * LAN/loopback host. This is the LAN-first gate: when on a connected
   * LAN the mobile prefers the direct WS path and the WebRTC tier is
   * suppressed ("consulted only when LAN is unavailable").
   *
   * Only `connectionState === "connected"` implies a live socket — an
   * idle/reconnecting/offline LAN WS returns `false`, so the WAN WebRTC
   * path is never stranded behind a down LAN socket.
   */
  public isOnConnectedLan(): boolean {
    if (this.connectionState !== "connected") return false
    const config = this.config()
    return !!config && classifyWsHost(config.baseUrl) === "ws-lan"
  }

  /**
   * Surfaces the current transport tier — distinguishes WebRTC direct vs
   * TURN relay vs HTTPS+WS LAN vs HTTPS+WS tunnel. Synchronous: returns
   * the latest value cached by [`recomputeTier`](#recomputeTier).
   *
   * The cache is refreshed on every connection/RTC state change; callers
   * that need a guaranteed-fresh sample should subscribe via
   * [`onTierChange`](#onTierChange) rather than poll this method.
   */
  public getActiveTier(): TransportTier {
    return this.tierCache
  }

  /**
   * Subscribe to tier-change notifications. Fires once with the current
   * value on subscribe (seeded so the caller doesn't need to call
   * `getActiveTier` separately), and again on every distinct transition.
   * The returned function detaches the subscription.
   */
  public onTierChange(handler: (t: TransportTier) => void): () => void {
    this.tierListeners.add(handler)
    // Seed: emit the current tier so subscribers don't have to fetch + listen.
    try {
      handler(this.tierCache)
    } catch (err) {
      console.warn("CompanionTransport: tier listener threw on seed", err)
    }
    return () => {
      this.tierListeners.delete(handler)
    }
  }

  /**
   * Recompute the active tier from current WS / RTC state and emit a
   * change notification if it differs from the cached value. The RTC
   * direct-vs-relay distinction requires an async `getStats()` call; the
   * WS lan-vs-tunnel classification is synchronous (URL hostname).
   *
   * Safe to call concurrently — overlapping invocations may settle in
   * arbitrary order, but the cache is overwritten by the most recent
   * computation rather than blended.
   */
  private async recomputeTier(): Promise<void> {
    let next: TransportTier
    // ADR-0021 LAN-first: a connected LAN WS outranks an open WebRTC peer.
    // Evaluated before the rtc branch so a stale/torn-down-pending peer
    // can't mask the preferred `ws-lan` tier.
    if (this.isOnConnectedLan()) {
      next = "ws-lan"
    } else if (this.rtc && this.rtc.getState() === "open") {
      const kind = await this.rtc.getSelectedCandidateKind().catch(() => "unknown" as const)
      this.rtcCandidateKind = kind
      next = kind === "relay" ? "rtc-relay" : "rtc-direct"
    } else if (this.connectionState === "connected") {
      const config = this.config()
      next = config ? classifyWsHost(config.baseUrl) : "offline"
    } else {
      next = "offline"
    }
    this.setTier(next)
  }

  private setTier(next: TransportTier): void {
    if (this.tierCache === next) return
    this.tierCache = next
    for (const l of this.tierListeners) {
      try {
        l(next)
      } catch (err) {
        console.warn("CompanionTransport: tier listener threw", err)
      }
    }
  }

  // ── Private: HTTP fetch with retry ─────────────────────────────────────────

  private async fetchWithRetry<T>(
    url: string,
    initialConfig: CompanionConfig,
    path: string,
    baseHeaders: Record<string, string>,
    body: string,
    canRetryRequest: boolean
  ): Promise<T> {
    let lastError: CompanionError | null = null
    let authRetryUsed = false
    let retryAfterMs: number | null = null

    for (let attempt = 0; attempt < HTTP_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const ceiling = Math.min(HTTP_BACKOFF_CAP_MS, HTTP_BACKOFF_BASE_MS * 2 ** (attempt - 1))
        const delay = retryAfterMs ?? Math.floor(backoffRandom() * ceiling)
        retryAfterMs = null
        await sleep(delay)
      }

      // DPoP proofs are single-use replay tokens. Mint authorization headers
      // for every network attempt while keeping the request body and
      // Idempotency-Key stable across the logical call.
      const headers: Record<string, string> = {
        ...(await authorizationHeadersProvider(initialConfig, "POST", path)),
        ...baseHeaders,
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)

      let response: Response
      try {
        // Routed through `pinnedFetch` so Capacitor mobile can use the
        // native HTTP stack (CapacitorHttp) which knows how to trust the
        // desktop's self-signed cert. Web / dev builds fall through to
        // the platform `fetch`. The pinned fingerprint comes from
        // CompanionConfig.serverFingerprint (set at pair time from the
        // QR's `cgnp3|<base64>` invitation payload).
        response = await pinnedFetch(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
          serverFingerprint: initialConfig.serverFingerprint,
        })
      } catch (err: unknown) {
        clearTimeout(timeoutId)
        if (isAbortError(err)) {
          this.setPlaneHealth({ rpc: "unavailable" })
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
        this.setPlaneHealth({ rpc: "unavailable" })
        if (canRetryRequest && attempt + 1 < HTTP_MAX_ATTEMPTS) {
          continue
        }
        throw lastError
      } finally {
        clearTimeout(timeoutId)
      }

      if (response.ok) {
        this.setPlaneHealth({ rpc: "ready" })
        const envelope = (await response.json()) as unknown
        return (
          envelope !== null && typeof envelope === "object" && Object.hasOwn(envelope, "result")
            ? (envelope as Record<string, unknown>).result
            : envelope
        ) as T
      }

      if (response.status === 401) {
        if (!authRetryUsed && initialConfig.devicePrivateKeyJwk) {
          authRetryUsed = true
          invalidateCompanionAccessToken(initialConfig.deviceId)
          attempt--
          continue
        }
        // Device revoked / invalid after one refresh — surface as unauthenticated.
        this.setConnectionState("unauthenticated")
        this.setPlaneHealth({ rpc: "unauthenticated" })
        const body = await safeJson(response)
        const detail = nestedError(body)
        throw new CompanionError({
          code: detail?.code ?? "unauthenticated",
          message: detail?.message ?? "device unauthenticated",
          retryable: false,
        })
      }

      if (
        response.status >= 400 &&
        response.status < 500 &&
        ![408, 429].includes(response.status)
      ) {
        // 4xx — not retried.
        this.setPlaneHealth({ rpc: "ready" })
        const body = await safeJson(response)
        const detail = nestedError(body)
        throw new CompanionError({
          code: detail?.code ?? `http_${response.status}`,
          message: detail?.message ?? `HTTP ${response.status}`,
          retryable: false,
        })
      }

      // 408, 429 and 5xx are retryable only when the manifest permits it.
      const errBody = await safeJson(response)
      const detail = nestedError(errBody)
      // Prefer the host's own answer. A 503 covers both "still booting, try
      // again" and "this host will never serve that command"
      // (`headless_host_required`), and the status code alone cannot tell them
      // apart — retrying the latter just burns the attempt budget.
      const hostSaysRetryable = detail?.retryable
      lastError = new CompanionError({
        code: detail?.code ?? (response.status >= 500 ? "server_error" : `http_${response.status}`),
        message: detail?.message ?? `HTTP ${response.status}`,
        retryable: hostSaysRetryable ?? true,
      })
      this.setPlaneHealth({
        rpc: response.status === 503 || response.status === 504 ? "unavailable" : "ready",
      })
      if (hostSaysRetryable === false) throw lastError
      if (canRetryRequest && attempt + 1 < HTTP_MAX_ATTEMPTS) {
        retryAfterMs = parseRetryAfterMs(response.headers?.get("retry-after") ?? null)
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

  private async fetchBinaryWithRetry(
    url: string,
    initialConfig: CompanionConfig,
    path: string
  ): Promise<TransportBinaryResponse> {
    let lastError: CompanionError | null = null

    for (let attempt = 0; attempt <= BINARY_HTTP_BACKOFF_MS.length; attempt++) {
      if (attempt > 0) await sleep(BINARY_HTTP_BACKOFF_MS[attempt - 1])

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
      let response: Response
      try {
        const headers = await authorizationHeadersProvider(initialConfig, "GET", path)
        response = await pinnedFetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
          serverFingerprint: initialConfig.serverFingerprint,
        })
      } catch (err: unknown) {
        if (isAbortError(err)) {
          throw new CompanionError({
            code: "timeout",
            message: "session media request timed out",
            retryable: true,
          })
        }
        lastError = new CompanionError({
          code: "network",
          message: "session media network request failed",
          retryable: true,
        })
        if (attempt < BINARY_HTTP_BACKOFF_MS.length) continue
        throw lastError
      } finally {
        clearTimeout(timeoutId)
      }

      if (response.ok) {
        const declaredSize = Number(response.headers.get("content-length") ?? "0")
        if (Number.isFinite(declaredSize) && declaredSize > MAX_SESSION_MEDIA_BYTES) {
          throw new CompanionError({
            code: "binary_resource_too_large",
            message: "session media exceeds the 10 MiB response budget",
            retryable: false,
          })
        }
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength > MAX_SESSION_MEDIA_BYTES) {
          throw new CompanionError({
            code: "binary_resource_too_large",
            message: "session media exceeds the 10 MiB response budget",
            retryable: false,
          })
        }
        return {
          bytes,
          mediaType: response.headers.get("content-type") ?? "application/octet-stream",
          ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
        }
      }

      if (response.status === 401) this.setConnectionState("unauthenticated")
      if (response.status >= 400 && response.status < 500) {
        const body = await safeJson(response)
        throw new CompanionError({
          code: (body?.code as string) ?? `http_${response.status}`,
          message: (body?.message as string) ?? `HTTP ${response.status}`,
          retryable: false,
        })
      }

      const body = await safeJson(response)
      lastError = new CompanionError({
        code: "server_error",
        message: (body?.message as string) ?? `HTTP ${response.status}`,
        retryable: true,
      })
      if (attempt >= BINARY_HTTP_BACKOFF_MS.length) throw lastError
    }

    throw (
      lastError ??
      new CompanionError({ code: "network", message: "binary request failed", retryable: true })
    )
  }

  // ── Private: WebSocket lifecycle ───────────────────────────────────────────

  private openWebSocket(): void {
    const config = this.config()
    if (!config || this.wsDestroyed) return
    if (requiresNativePinnedWebSocket(config)) {
      // The browser WebSocket constructor cannot bind a connection to the
      // accepted SPKI. Keep the channel closed until a native pinned WS
      // transport exists; WebRTC remains eligible for subscriptions.
      this.wsState = "idle"
      this.setPlaneHealth({ events: "idle" })
      this.setConnectionState("offline")
      return
    }

    this.wsState = "connecting"
    this.setPlaneHealth({ events: "connecting" })
    this.setConnectionState("reconnecting")
    const internalServiceToken = this.eventsPath.startsWith("/internal/")
      ? config.serviceToken
      : null
    if (internalServiceToken) {
      this.openAuthenticatedWebSocket(config, internalServiceToken, true)
      return
    }
    try {
      const issued = eventSocketTicketIssuer(config, "events")
      if (isPromiseLike(issued)) {
        void issued
          .then(({ ticket }) => this.openAuthenticatedWebSocket(config, ticket, false))
          .catch(() => {
            this.wsState = "reconnecting"
            this.scheduleWsReconnect()
          })
      } else {
        this.openAuthenticatedWebSocket(config, issued.ticket, false)
      }
    } catch {
      this.wsState = "reconnecting"
      this.scheduleWsReconnect()
    }
  }

  private openAuthenticatedWebSocket(
    config: CompanionConfig,
    ticket: string,
    internalService: boolean
  ): void {
    if (this.wsDestroyed || this.wsState !== "connecting") return

    // Build ?since= from the highest cursor across all active channels.
    const maxSeq = this.globalMaxSeq()
    const since = maxSeq > 0 ? String(maxSeq) : ""
    const wsBase = config.baseUrl.replace(/^https?/, "wss")
    const query = new URLSearchParams(internalService ? { token: ticket } : { ticket })
    if (since) query.set("since", since)
    const wsUrl = `${wsBase}${this.eventsPath}?${query.toString()}`

    const ws = new WebSocket(wsUrl)
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return // stale reference
      this.wsState = "connected"
      this.wsReconnectAttempt = 0
      this.setPlaneHealth({ events: "replaying" })
      this.setConnectionState("connected")
      // Widen the server-side subscription to every channel we handle. The
      // socket starts on the catalog defaults only; `mode: "add"` keeps
      // those defaults and layers our explicit channels on top.
      this.sendSubscribeFrame("add", Array.from(this.channelHandlers.keys()))
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
        this.setPlaneHealth({ events: "connecting" })
        this.scheduleWsReconnect()
      } else {
        this.wsState = "idle"
        this.setPlaneHealth({ events: "idle" })
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

    if (type === "stream_ready") {
      const cursor = frame["cursor"]
      if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) return
      for (const event of this.channelHandlers.keys()) {
        this.highestSeq.set(event, Math.max(this.highestSeq.get(event) ?? 0, cursor as number))
      }
      this.setPlaneHealth({ events: "ready" })
      return
    }

    if (type === "resync_required") {
      this.setPlaneHealth({ events: "replaying" })
      this.startWsAuthoritativeResync(frame)
      return
    }

    if (type === "subscribed" || type === "subscribe_error") {
      // Acknowledgement of a subscribe control frame. Rejected channels are
      // surfaced for diagnostics; nothing else to do — delivery of accepted
      // channels starts with the next event frame.
      const rejected = frame["rejected"]
      if (Array.isArray(rejected) && rejected.length > 0) {
        this.lastRejectedChannels = rejected
          .map((r) => (r && typeof r === "object" ? (r as { channel?: string }).channel : null))
          .filter((c): c is string => typeof c === "string")
      }
      if (type === "subscribe_error") {
        this.lastSubscribeError =
          typeof frame["message"] === "string" ? (frame["message"] as string) : "subscribe_error"
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

    // ADR-0127 §2: several consecutive same-channel frames in one WS message
    // — `{ type: "event_batch", channel, seq_from, seq_to, frames: [...] }`.
    // Each inner frame keeps the plain shape, so it goes through the same
    // per-channel seq cursor + dispatch as a lone frame. `event_batch` cannot
    // collide with a channel name (real channels always contain `://`).
    if (type === "event_batch") {
      const frames = frame["frames"]
      if (!Array.isArray(frames)) return
      for (const inner of frames) {
        if (inner && typeof inner === "object") {
          this.dispatchEventFrame(inner as Record<string, unknown>)
        }
      }
      return
    }

    // Real event frame: { type, seq, payload, ts_ms }
    this.dispatchEventFrame(frame)
  }

  /** Apply one plain event frame to the per-channel cursor and its handlers. */
  private dispatchEventFrame(frame: Record<string, unknown>): void {
    const type = frame["type"] as string | undefined
    if (!type) return
    const seq = typeof frame["seq"] === "number" ? (frame["seq"] as number) : 0
    const payload = frame["payload"]

    // Update per-channel cursor.
    const prev = this.highestSeq.get(type) ?? 0
    if (!Number.isSafeInteger(seq) || seq <= prev) return
    this.highestSeq.set(type, seq)

    // Dispatch to handlers registered for this channel.
    const handlers = this.channelHandlers.get(type)
    if (handlers) {
      for (const h of handlers) {
        h(payload)
      }
    }
  }

  private startWsAuthoritativeResync(frame: Record<string, unknown>): void {
    if (this.wsResyncInFlight) return
    const domains = Array.isArray(frame["domains"])
      ? frame["domains"].filter((value): value is string => typeof value === "string")
      : ["*"]
    const cursor = frame["cursor"]
    this.wsResyncInFlight = remoteEventResyncCoordinator
      .resolve(domains)
      .then(() => {
        if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) {
          throw new Error("resync notice omitted a valid cursor")
        }
        for (const event of this.channelHandlers.keys()) {
          this.highestSeq.set(event, cursor as number)
        }
        for (const handlers of this.channelHandlers.values()) {
          for (const handler of handlers) {
            handler({ type: "resync_required", domains })
          }
        }
        if (this.ws) {
          const ws = this.ws
          this.ws = null
          ws.close()
        }
        if (!this.wsDestroyed && this.channelHandlers.size > 0) {
          this.openWebSocket()
        }
      })
      .catch((error) => {
        console.error("CompanionTransport: authoritative event resync failed", error)
        this.wsState = "idle"
        this.setPlaneHealth({ events: "idle" })
        this.setConnectionState("offline")
      })
      .finally(() => {
        this.wsResyncInFlight = null
      })
  }

  private scheduleWsReconnect(): void {
    if (this.wsReconnectTimer !== null) return
    // Don't schedule reconnect attempts while the OS reports no network: each
    // would just burn a 30s timeout failing to connect. The online listener
    // re-opens the socket (and resets the backoff) when connectivity returns.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.setConnectionState("offline")
      return
    }
    this.setConnectionState("reconnecting")
    this.setPlaneHealth({ events: "connecting" })

    const idx = Math.min(this.wsReconnectAttempt, WS_BACKOFF_MS.length - 1)
    const delay = withJitter(WS_BACKOFF_MS[idx])
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
    this.setPlaneHealth({ events: "idle" })
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
    // Connection state changes alter the tier (offline ↔ ws-*).
    void this.recomputeTier()
  }

  private setPlaneHealth(patch: Partial<CompanionPlaneHealth>): void {
    const next = { ...this.planeHealth, ...patch }
    if (next.rpc === this.planeHealth.rpc && next.events === this.planeHealth.events) return
    this.planeHealth = next
    for (const handler of this.planeHealthHandlers) {
      handler(this.getPlaneHealth())
    }
  }

  // ── Private: network awareness ─────────────────────────────────────────────

  private attachNetworkListeners(): void {
    // The headless brain's window shim is `globalThis` (no EventTarget API),
    // so require the method — network awareness is a browser concern.
    if (
      typeof window === "undefined" ||
      typeof window.addEventListener !== "function" ||
      this.networkListenersAttached
    ) {
      return
    }
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
      this.setPlaneHealth({ events: "idle" })
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
    this.disableWebRtcTier()
    this.closeWebSocket()
    if (typeof window !== "undefined") {
      if (this.onlineListener) window.removeEventListener("online", this.onlineListener)
      if (this.offlineListener) window.removeEventListener("offline", this.offlineListener)
    }
    this.channelHandlers.clear()
    this.connectionStateHandlers.clear()
    this.planeHealthHandlers.clear()
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (!trimmed) return null

  let delayMs: number
  if (/^\d+$/.test(trimmed)) {
    delayMs = Number(trimmed) * 1_000
  } else {
    const retryAt = Date.parse(trimmed)
    if (!Number.isFinite(retryAt)) return null
    delayMs = Math.max(0, retryAt - nowMs)
  }
  if (!Number.isFinite(delayMs)) return null
  return Math.min(delayMs, HTTP_RETRY_AFTER_CAP_MS)
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === "function"
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

function nestedError(
  body: Record<string, unknown> | null
): { code: string; message: string; retryable?: boolean } | null {
  if (!body) return null
  const candidate =
    body.error && typeof body.error === "object" && !Array.isArray(body.error)
      ? (body.error as Record<string, unknown>)
      : body
  return typeof candidate.code === "string" && typeof candidate.message === "string"
    ? {
        code: candidate.code,
        message: candidate.message,
        // The host now states this (RpcError.retryable). Absent on older
        // hosts, where the caller falls back to its status-code guess.
        ...(typeof candidate.retryable === "boolean" ? { retryable: candidate.retryable } : {}),
      }
    : null
}
