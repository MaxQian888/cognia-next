import type {
  McpCapabilityCacheRow,
  McpRuntimeStatusSnapshot,
  McpServer,
} from "@cognia/agent-config-types"

import { getDb } from "@/lib/db/schema"
import { fingerprintMcpDefinition } from "./server-definition"
import { openMcpClient, type McpClientInfo, type OpenedMcp } from "./transport"
import type { McpExecutionGrant, McpExecutionSurface } from "./policy"
import { appendMcpAuditLog } from "@/lib/db/mcp-audit-log"

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_TOOL_TIMEOUT_MS = 60_000
const DEFAULT_CAPABILITY_TTL_MS = 5 * 60_000

interface Lease {
  key: string
  scopeId: string
  serverId: string
  fingerprint: string
  opened: OpenedMcp
}

interface CircuitState {
  failures: number
  openUntil: number
  cooldownMs: number
}

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active += 1
    try {
      return await operation()
    } finally {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

export interface RuntimeGatewayOptions {
  open?: typeof openMcpClient
  now?: () => number
  maxConcurrentConnects?: number
  connectTimeoutMs?: number
  toolTimeoutMs?: number
  capabilityTtlMs?: number
  connectAttempts?: number
  retryDelayMs?: number
}

export interface RuntimeInvokeInput {
  scopeId: string
  server: McpServer
  toolName: string
  args?: Record<string, unknown>
  signal?: AbortSignal
  deadlineMs?: number
  surface: McpExecutionSurface
  interactive?: boolean
  grant?: McpExecutionGrant
  authProvider?: unknown
  clientInfo?: McpClientInfo
}

export interface RuntimeDiscoveryResult {
  tools: McpCapabilityCacheRow["tools"]
  resources: McpCapabilityCacheRow["resources"]
  prompts: McpCapabilityCacheRow["prompts"]
  cacheHit: boolean
}

type StatusListener = (status: McpRuntimeStatusSnapshot) => void

export interface McpRuntimeMetricsSnapshot {
  connectionAttempts: number
  successfulConnections: number
  failedConnections: number
  connectionLatencyMs: number
  warmReuses: number
  capabilityCacheHits: number
  retries: number
  toolCalls: number
  timeouts: number
  policyDenials: number
}

type MetricsListener = (metrics: McpRuntimeMetricsSnapshot) => void

function emptyMetrics(): McpRuntimeMetricsSnapshot {
  return {
    connectionAttempts: 0,
    successfulConnections: 0,
    failedConnections: 0,
    connectionLatencyMs: 0,
    warmReuses: 0,
    capabilityCacheHits: 0,
    retries: 0,
    toolCalls: 0,
    timeouts: 0,
    policyDenials: 0,
  }
}

export class McpRuntimeGateway {
  private readonly open: typeof openMcpClient
  private readonly now: () => number
  private readonly connectTimeoutMs: number
  private readonly toolTimeoutMs: number
  private readonly capabilityTtlMs: number
  private readonly connectAttempts: number
  private readonly retryDelayMs: number
  private readonly semaphore: Semaphore
  private readonly leases = new Map<string, Promise<Lease>>()
  private readonly circuits = new Map<string, CircuitState>()
  private readonly statuses = new Map<string, McpRuntimeStatusSnapshot>()
  private readonly listeners = new Set<StatusListener>()
  private metrics = emptyMetrics()
  private readonly metricsListeners = new Set<MetricsListener>()

  constructor(options: RuntimeGatewayOptions = {}) {
    this.open = options.open ?? openMcpClient
    this.now = options.now ?? (() => Date.now())
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    this.capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS
    this.connectAttempts = Math.max(1, options.connectAttempts ?? 2)
    this.retryDelayMs = options.retryDelayMs ?? 300
    this.semaphore = new Semaphore(options.maxConcurrentConnects ?? 4)
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getStatusSnapshot(): McpRuntimeStatusSnapshot[] {
    return [...this.statuses.values()]
  }

  subscribeMetrics(listener: MetricsListener): () => void {
    this.metricsListeners.add(listener)
    return () => this.metricsListeners.delete(listener)
  }

  getMetricsSnapshot(): McpRuntimeMetricsSnapshot {
    return { ...this.metrics }
  }

  async invoke(input: RuntimeInvokeInput): Promise<{
    isError: boolean
    content: unknown[]
    structuredContent?: unknown
  }> {
    const startedAt = this.now()
    this.bumpMetric("toolCalls")
    try {
      const lease = await this.getLease(input)
      const timeoutMs = Math.min(input.deadlineMs ?? this.toolTimeoutMs, this.toolTimeoutMs)
      const result = await callToolWithTimeout(
        lease.opened.client,
        { name: input.toolName, arguments: input.args ?? {} },
        timeoutMs,
        input.signal,
        "MCP tool call timed out"
      )
      void auditOutbound(input, startedAt, this.now(), result.isError ? "tool-error" : undefined)
      return {
        isError: result.isError ?? false,
        content: result.content ?? [],
        structuredContent: result.structuredContent,
      }
    } catch (error) {
      this.recordOperationError(error)
      void auditOutbound(input, startedAt, this.now(), classifyError(error, "call-failed"))
      throw error
    }
  }

  async discover(
    input: Omit<RuntimeInvokeInput, "toolName" | "args" | "deadlineMs">
  ): Promise<RuntimeDiscoveryResult> {
    const startedAt = this.now()
    try {
      const fingerprint = runtimeFingerprint(input.server)
      const cacheId = `${input.server.id}:${fingerprint}`
      const cached = await readCapabilityCache(cacheId, this.now())
      if (cached) {
        this.bumpMetric("capabilityCacheHits")
        void auditOutbound(input, startedAt, this.now(), undefined, "discover", "capabilities/list")
        return { ...cached, cacheHit: true }
      }

      const lease = await this.getLease({ ...input, toolName: "tools/list" })
      const [tools, resources, prompts] = await this.semaphore.run(async () =>
        withTimeout(
          Promise.all([
            lease.opened.client.listTools(),
            optionalCapability(() => lease.opened.client.listResources(), { resources: [] }),
            optionalCapability(() => lease.opened.client.listPrompts(), { prompts: [] }),
          ]),
          this.connectTimeoutMs,
          input.signal,
          "MCP capability discovery timed out"
        )
      )
      const row: McpCapabilityCacheRow = {
        id: cacheId,
        serverId: input.server.id,
        fingerprint,
        tools: tools.tools ?? [],
        resources: resources.resources ?? [],
        prompts: (prompts.prompts ?? []).map(({ name, description }) => ({ name, description })),
        expiresAt: this.now() + this.capabilityTtlMs,
        updatedAt: this.now(),
      }
      await writeCapabilityCache(row)
      void auditOutbound(input, startedAt, this.now(), undefined, "discover", "capabilities/list")
      return { tools: row.tools, resources: row.resources, prompts: row.prompts, cacheHit: false }
    } catch (error) {
      this.recordOperationError(error)
      void auditOutbound(
        input,
        startedAt,
        this.now(),
        classifyError(error, "discovery-failed"),
        "discover",
        "capabilities/list"
      )
      throw error
    }
  }

  async closeScope(scopeId: string): Promise<void> {
    const entries = [...this.leases.entries()].filter(([key]) => key.startsWith(`${scopeId}:`))
    await Promise.all(
      entries.map(async ([key, leasePromise]) => {
        this.leases.delete(key)
        try {
          const lease = await leasePromise
          this.emit(scopeId, lease.serverId, "closing")
          await lease.opened.close()
          this.emit(scopeId, lease.serverId, "idle")
        } catch {
          // Failed/late connects already clean themselves up.
        }
      })
    )
  }

  async reconnect(scopeId: string, serverId: string): Promise<void> {
    this.circuits.delete(serverId)
    const matching = [...this.leases.keys()].filter((key) =>
      key.startsWith(`${scopeId}:${serverId}:`)
    )
    await Promise.all(
      matching.map(async (key) => {
        const lease = this.leases.get(key)
        this.leases.delete(key)
        if (lease) await lease.then((value) => value.opened.close()).catch(() => undefined)
      })
    )
  }

  async invalidateCapabilities(serverId: string): Promise<void> {
    try {
      await getDb().mcpCapabilityCache.where("serverId").equals(serverId).delete()
    } catch {
      // Non-browser runtimes may use only the live connection cache.
    }
  }

  private async getLease(input: RuntimeInvokeInput): Promise<Lease> {
    const fingerprint = runtimeFingerprint(input.server)
    const key = `${input.scopeId}:${input.server.id}:${fingerprint}`
    const existing = this.leases.get(key)
    if (existing) {
      this.bumpMetric("warmReuses")
      return existing
    }

    const pending = this.connect(input, key, fingerprint)
    this.leases.set(key, pending)
    try {
      return await pending
    } catch (error) {
      if (this.leases.get(key) === pending) this.leases.delete(key)
      throw error
    }
  }

  private async connect(
    input: RuntimeInvokeInput,
    key: string,
    fingerprint: string
  ): Promise<Lease> {
    const startedAt = this.now()
    const circuit = this.circuits.get(input.server.id)
    if (circuit && circuit.openUntil > this.now()) {
      this.emit(input.scopeId, input.server.id, "degraded", "circuit-open")
      void auditOutbound(input, startedAt, this.now(), "circuit-open", "connect", "initialize")
      throw new Error(`MCP circuit open until ${circuit.openUntil}`)
    }
    this.emit(input.scopeId, input.server.id, "connecting")
    let lastError: unknown
    for (let attempt = 0; attempt < this.connectAttempts; attempt += 1) {
      this.bumpMetric("connectionAttempts")
      if (attempt > 0) {
        this.bumpMetric("retries")
        if (this.retryDelayMs > 0) await delay(this.retryDelayMs * 2 ** (attempt - 1))
      }
      if (input.signal?.aborted) {
        lastError = new Error("MCP connect aborted")
        break
      }
      try {
        const opened = await this.semaphore.run(() =>
          withTimeout(
            this.open(input.server, {
              signal: input.signal,
              authProvider: input.authProvider,
              clientInfo: input.clientInfo,
              surface: input.surface,
              interactive: input.interactive ?? false,
              grant: input.grant,
              toolName: input.toolName,
              fingerprint: fingerprintMcpDefinition(input.server),
              onToolsChanged: () => this.invalidateCapabilities(input.server.id),
            }),
            this.connectTimeoutMs,
            input.signal,
            "MCP connect timed out",
            (late) => void late.close()
          )
        )
        this.circuits.delete(input.server.id)
        this.bumpMetric("successfulConnections")
        this.bumpMetric("connectionLatencyMs", this.now() - startedAt)
        this.emit(input.scopeId, input.server.id, "ready")
        void auditOutbound(input, startedAt, this.now(), undefined, "connect", "initialize")
        return { key, scopeId: input.scopeId, serverId: input.server.id, fingerprint, opened }
      } catch (error) {
        lastError = error
        if (input.signal?.aborted) break
      }
    }
    const errorCode = classifyError(lastError)
    this.bumpMetric("failedConnections")
    if (errorCode !== "blocked" && errorCode !== "needs-auth") this.recordFailure(input.server.id)
    this.emit(
      input.scopeId,
      input.server.id,
      errorCode === "needs-auth" ? "needs-auth" : errorCode === "blocked" ? "blocked" : "failed",
      errorCode
    )
    void auditOutbound(input, startedAt, this.now(), errorCode, "connect", "initialize")
    throw lastError
  }

  private recordFailure(serverId: string): void {
    const prior = this.circuits.get(serverId) ?? { failures: 0, openUntil: 0, cooldownMs: 30_000 }
    const failures = prior.failures + 1
    const cooldownMs = Math.min(failures > 3 ? prior.cooldownMs * 2 : 30_000, 300_000)
    this.circuits.set(serverId, {
      failures,
      cooldownMs,
      openUntil: failures >= 3 ? this.now() + cooldownMs : 0,
    })
  }

  private emit(
    scopeId: string,
    serverId: string,
    state: McpRuntimeStatusSnapshot["state"],
    errorCode?: string
  ): void {
    const status = { scopeId, serverId, state, updatedAt: this.now(), errorCode }
    this.statuses.set(`${scopeId}:${serverId}`, status)
    this.listeners.forEach((listener) => listener(status))
  }

  private bumpMetric(key: keyof McpRuntimeMetricsSnapshot, by = 1): void {
    this.metrics = { ...this.metrics, [key]: this.metrics[key] + by }
    const snapshot = this.getMetricsSnapshot()
    this.metricsListeners.forEach((listener) => listener(snapshot))
  }

  private recordOperationError(error: unknown): void {
    const code = classifyError(error)
    if (code === "timeout") this.bumpMetric("timeouts")
    if (code === "blocked") this.bumpMetric("policyDenials")
  }
}

function runtimeFingerprint(server: McpServer): string {
  return `${server.revision ?? 1}:${server.credentialVersion ?? 0}:${fingerprintMcpDefinition(server)}`
}

async function readCapabilityCache(id: string, now: number): Promise<McpCapabilityCacheRow | null> {
  try {
    const row = await getDb().mcpCapabilityCache.get(id)
    return row && row.expiresAt > now ? row : null
  } catch {
    return null
  }
}

async function writeCapabilityCache(row: McpCapabilityCacheRow): Promise<void> {
  try {
    await getDb().mcpCapabilityCache.put(row)
  } catch {
    // Persistence is best-effort in CLI/tests; the scoped connection is still valid.
  }
}

function classifyError(error: unknown, fallback = "connect-failed"): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/auth|unauthorized|401/i.test(message)) return "needs-auth"
  if (/execution (?:deny|ask)|trust is blocked|pending MCP/i.test(message)) return "blocked"
  if (/timeout/i.test(message)) return "timeout"
  if (/abort/i.test(message)) return "aborted"
  return fallback
}

async function optionalCapability<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/method not found|unsupported|-32601/i.test(message)) return fallback
    throw error
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function callToolWithTimeout(
  client: OpenedMcp["client"],
  params: { name: string; arguments?: Record<string, unknown> },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  message: string
) {
  if (signal?.aborted) throw new Error("MCP operation aborted")
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = () => controller.abort()
  signal?.addEventListener("abort", forwardAbort, { once: true })
  const abortTimer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const operation = client.callTool(params, undefined, {
    signal: controller.signal,
    timeout: timeoutMs,
  })
  try {
    return await withTimeout(operation, timeoutMs, signal, message)
  } catch (error) {
    if (timedOut) throw new Error(message)
    throw error
  } finally {
    clearTimeout(abortTimer)
    signal?.removeEventListener("abort", forwardAbort)
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  message: string,
  onLate?: (value: T) => void
): Promise<T> {
  if (signal?.aborted) throw new Error("MCP operation aborted")
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const gate = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    if (signal) {
      abort = () => reject(new Error("MCP operation aborted"))
      signal.addEventListener("abort", abort, { once: true })
    }
  })
  try {
    return await Promise.race([operation, gate])
  } catch (error) {
    if (onLate) void operation.then(onLate).catch(() => undefined)
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    if (signal && abort) signal.removeEventListener("abort", abort)
  }
}

export const defaultMcpRuntimeGateway = new McpRuntimeGateway()

async function auditOutbound(
  input: Pick<RuntimeInvokeInput, "server" | "surface"> &
    Partial<Pick<RuntimeInvokeInput, "toolName">>,
  startedAt: number,
  completedAt: number,
  errorCode?: string,
  phase: "connect" | "discover" | "call" = "call",
  tool = input.toolName ?? "unknown"
): Promise<void> {
  try {
    const denied = errorCode === "blocked"
    await appendMcpAuditLog({
      ts: completedAt,
      tool,
      scope: "n/a",
      allowed: !denied,
      latencyMs: completedAt - startedAt,
      direction: "outbound",
      phase,
      serverId: input.server.id,
      executionSurface: input.surface,
      decision: denied ? "deny" : "allow",
      durationMs: completedAt - startedAt,
      errorCode,
    })
  } catch {
    // Audit storage must never change the tool result.
  }
}
