export type ServerHealth = "healthy" | "degraded" | "unavailable" | "unknown"
export type OperationState =
  | "queued"
  | "validating"
  | "preparing"
  | "executing"
  | "verifying"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "rollback_failed"
  | "cancelled"

export interface ServerSummary {
  id: string
  label: string
  topology: string
  publicUrl: string
  health: ServerHealth
  releaseDigest: string | null
  lastSeenAt: string | null
}

export interface ProviderCapabilities {
  topologies: string[]
  snapshotProviders: string[]
  secretProviders: string[]
  tlsProviders: string[]
  objectStoreProtocols: string[]
  requiresProviderCredentials: boolean
}

export interface ServerDetail extends ServerSummary {
  targetRevision: number
  productionCertified: boolean
  certificationIssues: string[]
  capabilities: ProviderCapabilities
}

export interface RecoveryPoint {
  id: string
  serverId: string
  createdAt: string
  kind: "snapshot" | "object-store"
  manifestSha256: string
  sizeBytes: number
  verified: boolean
}

export interface ServerLogEntry {
  id: number
  serverId: string
  timestamp: string
  level: string
  component: string
  message: string
}

export interface Operation {
  id: string
  targetId: string
  kind: string
  state: OperationState
  request: unknown
  result: unknown | null
  error: { code: string; message: string; details?: unknown } | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

/**
 * A single-use agent enrollment grant, as returned by the controller. The
 * target it is bound to is not echoed back — the caller named it in the
 * request, and the controller stores the binding server-side.
 */
export interface EnrollmentToken {
  token: string
  expiresAt: string
}

export interface OperationEvent {
  id: number
  operationId: string
  targetId: string
  state: OperationState
  timestamp: string
  message: string
}

export class OpsError extends Error {
  readonly name = "OpsError"

  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
  }
}

/**
 * The subset of `fetch` the controller client uses. Declared rather than
 * reusing `typeof fetch` so the platform transports in `./transport` — which
 * take narrower init objects — stay assignable under `strictFunctionTypes`.
 */
export type OpsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Reads `/v1/events` as an async stream of operation events.
 *
 * Injectable because no single implementation works on every shell: the desktop
 * one crosses a native command (the WebView cannot reach an arbitrary
 * controller host at all), while the web one reads the `fetch` body directly.
 * See `./transport`.
 */
export type OpsEventStream = (options: {
  lastEventId?: number
  signal?: AbortSignal
}) => AsyncGenerator<OperationEvent>

export interface OpsClientOptions {
  baseUrl: string
  accessToken: () => Promise<string>
  fetchImpl?: OpsFetch
  sleep?: (milliseconds: number) => Promise<void>
  /**
   * Overrides the built-in `fetch`-body SSE reader. Omit on the web, where
   * reading the response body directly is exactly right; supply the native
   * stream on desktop, where a renderer `fetch` never reaches the controller.
   */
  eventStream?: OpsEventStream
}

const GET_RETRY_DELAYS = [0, 250, 750] as const
const MUTATION_RETRY_DELAYS = [0, 250] as const

export class OpsClient {
  private readonly baseUrl: URL
  private readonly fetchImpl: OpsFetch
  private readonly accessToken: () => Promise<string>
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly eventStream: OpsEventStream | null

  constructor(options: OpsClientOptions) {
    this.baseUrl = normalizeControllerUrl(options.baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.eventStream = options.eventStream ?? null
    this.accessToken = options.accessToken
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return this.request("/v1/providers/capabilities")
  }

  async validateTarget(target: unknown, idempotencyKey: string): Promise<unknown> {
    return this.mutation("/v1/targets/validate", idempotencyKey, target)
  }

  async registerTarget(target: unknown, idempotencyKey: string): Promise<ServerDetail> {
    return this.mutation("/v1/targets", idempotencyKey, target)
  }

  async listServers(): Promise<ServerSummary[]> {
    const response = await this.request<{ items: ServerSummary[] }>("/v1/servers")
    return response.items
  }

  async getServer(id: string): Promise<ServerDetail> {
    return this.request(`/v1/servers/${encodeURIComponent(id)}`)
  }

  async listLogs(id: string, limit = 200): Promise<ServerLogEntry[]> {
    const response = await this.request<{ items: ServerLogEntry[] }>(
      `/v1/servers/${encodeURIComponent(id)}/logs?limit=${Math.min(Math.max(limit, 1), 1000)}`
    )
    return response.items
  }

  async listBackups(id: string): Promise<RecoveryPoint[]> {
    const response = await this.request<{ items: RecoveryPoint[] }>(
      `/v1/servers/${encodeURIComponent(id)}/backups`
    )
    return response.items
  }

  async createBackup(id: string, idempotencyKey: string): Promise<Operation> {
    return this.mutation(`/v1/servers/${encodeURIComponent(id)}/backups`, idempotencyKey, {})
  }

  async deploy(
    id: string,
    parameters: {
      targetRevision: number
      release: {
        serverImage: string
        runnerImage: string
        workspaceRuntimeImage: string
        configRevision: string
      }
    },
    idempotencyKey: string
  ): Promise<Operation> {
    return this.mutation(`/v1/servers/${encodeURIComponent(id)}/deploy`, idempotencyKey, parameters)
  }

  async upgrade(
    id: string,
    parameters: {
      targetRevision: number
      release: {
        serverImage: string
        runnerImage: string
        workspaceRuntimeImage: string
        configRevision: string
      }
    },
    idempotencyKey: string
  ): Promise<Operation> {
    return this.mutation(
      `/v1/servers/${encodeURIComponent(id)}/upgrade`,
      idempotencyKey,
      parameters
    )
  }

  /**
   * Queue a read-only preflight of the target's current revision.
   *
   * Takes no parameters on purpose: the controller derives the revision and
   * topology from the registered target and rejects a client-supplied body, so
   * a tab left open across a re-registration cannot check a configuration that
   * no longer exists.
   */
  async preflight(id: string, idempotencyKey: string): Promise<Operation> {
    return this.mutation(`/v1/servers/${encodeURIComponent(id)}/preflight`, idempotencyKey, {})
  }

  /**
   * Ask the agent to report the target's live status. `includeRuntimeUsage`
   * adds per-container resource figures, which cost a slower probe on the host.
   */
  async collectStatus(
    id: string,
    idempotencyKey: string,
    options: { includeRuntimeUsage?: boolean } = {}
  ): Promise<Operation> {
    return this.mutation(
      `/v1/servers/${encodeURIComponent(id)}/collect-status`,
      idempotencyKey,
      options.includeRuntimeUsage === undefined
        ? {}
        : { includeRuntimeUsage: options.includeRuntimeUsage }
    )
  }

  /**
   * Pull fresh log lines from the target. The agent's result is materialized
   * into the controller's log store, so the Logs tab reflects it on the next
   * refresh rather than through a second channel.
   */
  async collectLogs(
    id: string,
    idempotencyKey: string,
    options: { afterEventId?: number; limit?: number } = {}
  ): Promise<Operation> {
    const body =
      options.afterEventId === undefined && options.limit === undefined
        ? {}
        : {
            afterEventId: options.afterEventId ?? null,
            limit: Math.min(Math.max(options.limit ?? 200, 1), 1000),
          }
    return this.mutation(`/v1/servers/${encodeURIComponent(id)}/collect-logs`, idempotencyKey, body)
  }

  /**
   * Issue a single-use agent enrollment token for `targetId`.
   *
   * This is the step that makes a registered target executable: until an agent
   * enrolls against it and dials the controller, every operation queued for
   * that target sits at `queued` with nothing to claim it.
   */
  async createEnrollmentToken(
    targetId: string,
    idempotencyKey: string,
    ttlSeconds = 900
  ): Promise<EnrollmentToken> {
    return this.mutation("/v1/agents/enrollment-tokens", idempotencyKey, {
      targetId,
      ttlSeconds: Math.min(Math.max(Math.trunc(ttlSeconds), 60), 3600),
    })
  }

  async createAdminLease(
    targetId: string,
    operation: "restore" | "rollback" | "rotate-key",
    idempotencyKey: string
  ): Promise<{ token: string; expiresAt: string }> {
    return this.mutation("/v1/admin-leases", idempotencyKey, {
      targetId,
      operation,
      ttlSeconds: 300,
    })
  }

  async restore(
    id: string,
    recoveryPointId: string,
    adminLease: string,
    idempotencyKey: string
  ): Promise<Operation> {
    return this.mutation(
      `/v1/servers/${encodeURIComponent(id)}/restore`,
      idempotencyKey,
      { recoveryPointId },
      adminLease
    )
  }

  async rollback(id: string, adminLease: string, idempotencyKey: string): Promise<Operation> {
    return this.mutation(
      `/v1/servers/${encodeURIComponent(id)}/rollback`,
      idempotencyKey,
      {},
      adminLease
    )
  }

  async rotateKey(
    id: string,
    keyVersion: string,
    adminLease: string,
    idempotencyKey: string
  ): Promise<Operation> {
    return this.mutation(
      `/v1/servers/${encodeURIComponent(id)}/rotate-key`,
      idempotencyKey,
      { keyVersion },
      adminLease
    )
  }

  async getOperation(id: string): Promise<Operation> {
    return this.request(`/v1/operations/${encodeURIComponent(id)}`)
  }

  /**
   * Cancel a still-queued operation.
   *
   * Rejected with `operation_not_cancellable` once an agent has claimed it: past
   * that point the agent holds the target lock and is already changing the host,
   * and the agent protocol has no abort message, so the controller will not
   * report work as stopped that is still running.
   */
  async cancelOperation(id: string, idempotencyKey: string): Promise<Operation> {
    return this.mutation(`/v1/operations/${encodeURIComponent(id)}/cancel`, idempotencyKey, {})
  }

  /**
   * Follow `/v1/events`.
   *
   * Delegates to the injected transport when there is one — on desktop the
   * WebView cannot open this stream at all, so it lives behind a native
   * command. The inline reader below is the web path.
   */
  async *streamEvents(
    options: {
      lastEventId?: number
      signal?: AbortSignal
    } = {}
  ): AsyncGenerator<OperationEvent> {
    if (this.eventStream) {
      yield* this.eventStream(options)
      return
    }
    const token = await this.accessToken()
    const headers = new Headers({ Accept: "text/event-stream", Authorization: `Bearer ${token}` })
    if (options.lastEventId !== undefined) headers.set("Last-Event-ID", String(options.lastEventId))
    const response = await this.fetchImpl(new URL("/v1/events", this.baseUrl), {
      headers,
      signal: options.signal,
    })
    if (!response.ok) throw await responseError(response)
    if (!response.body)
      throw new OpsError("event_stream_unavailable", response.status, "Event stream is unavailable")

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let pending = ""
    while (!options.signal?.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      pending += value
      let boundary = pending.indexOf("\n\n")
      while (boundary >= 0) {
        const frame = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data) yield JSON.parse(data) as OperationEvent
        boundary = pending.indexOf("\n\n")
      }
    }
  }

  private async mutation<T>(
    path: string,
    idempotencyKey: string,
    body: unknown,
    adminLease?: string
  ): Promise<T> {
    if (!idempotencyKey.trim()) throw new Error("idempotencyKey is required")
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
      idempotencyKey,
      adminLease,
    })
  }

  private async request<T>(
    path: string,
    mutation?: {
      method: "POST"
      body: string
      idempotencyKey: string
      adminLease?: string
    }
  ): Promise<T> {
    const delays = mutation ? MUTATION_RETRY_DELAYS : GET_RETRY_DELAYS
    let lastNetworkError: unknown
    for (const delay of delays) {
      if (delay) await this.sleep(delay)
      try {
        const token = await this.accessToken()
        if (!token) throw new OpsError("authentication_required", 401, "Authentication is required")
        const headers = new Headers({
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        })
        if (mutation) {
          headers.set("content-type", "application/json")
          headers.set("idempotency-key", mutation.idempotencyKey)
          if (mutation.adminLease) headers.set("x-admin-lease", mutation.adminLease)
        }
        const response = await this.fetchImpl(new URL(path, this.baseUrl), {
          method: mutation?.method ?? "GET",
          headers,
          body: mutation?.body,
        })
        if (!response.ok) throw await responseError(response)
        if (response.status === 204) return undefined as T
        return (await response.json()) as T
      } catch (error) {
        if (error instanceof OpsError) throw error
        lastNetworkError = error
      }
    }
    throw new OpsError(
      "network_unavailable",
      0,
      lastNetworkError instanceof Error ? lastNetworkError.message : "Controller is unavailable"
    )
  }
}

function normalizeControllerUrl(value: string): URL {
  const url = new URL(value)
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Ops Controller must use HTTPS outside loopback development")
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  url.search = ""
  url.hash = ""
  return url
}

async function responseError(response: Response): Promise<OpsError> {
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown; details?: unknown }
    return new OpsError(
      typeof body.code === "string" ? body.code : "controller_error",
      response.status,
      typeof body.message === "string" ? body.message : `Controller returned ${response.status}`,
      body.details
    )
  } catch {
    return new OpsError(
      "controller_error",
      response.status,
      `Controller returned ${response.status}`
    )
  }
}

interface CacheStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const CACHE_PREFIX = "cognia.server-ops.v1"

export function saveCachedServerList(
  storage: CacheStorage,
  accountId: string,
  targetId: string,
  servers: readonly ServerSummary[]
): void {
  storage.setItem(cacheKey(accountId, targetId), JSON.stringify({ servers, savedAt: Date.now() }))
}

export function loadCachedServerList(
  storage: CacheStorage,
  accountId: string,
  targetId: string
): ServerSummary[] {
  try {
    const raw = storage.getItem(cacheKey(accountId, targetId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as { servers?: unknown }
    if (!Array.isArray(parsed.servers)) throw new Error("invalid cache")
    return parsed.servers.filter(isServerSummary)
  } catch {
    storage.removeItem(cacheKey(accountId, targetId))
    return []
  }
}

function cacheKey(accountId: string, targetId: string): string {
  return `${CACHE_PREFIX}.${encodeURIComponent(accountId)}.${encodeURIComponent(targetId)}`
}

function isServerSummary(value: unknown): value is ServerSummary {
  if (!value || typeof value !== "object") return false
  const server = value as Partial<ServerSummary>
  return (
    typeof server.id === "string" &&
    typeof server.label === "string" &&
    typeof server.topology === "string" &&
    typeof server.publicUrl === "string" &&
    ["healthy", "degraded", "unavailable", "unknown"].includes(server.health ?? "") &&
    (server.releaseDigest === null || typeof server.releaseDigest === "string") &&
    (server.lastSeenAt === null || typeof server.lastSeenAt === "string")
  )
}
