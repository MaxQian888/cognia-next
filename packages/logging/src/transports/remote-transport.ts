/**
 * Remote Transport
 * Ships logs to remote endpoints with batching, durable retry queue, and health telemetry.
 */

import type {
  StructuredLogEntry,
  Transport,
  TransportDiagnosticEvent,
  TransportHealthSnapshot,
  LogLevel,
} from "../types"
import { createRemoteRetryQueueStore, type RemoteRetryQueueStore } from "./remote-retry-queue-store"

/**
 * Remote transport options
 */
export interface RemoteTransportOptions {
  /** Remote endpoint URL */
  endpoint: string
  /** Batch size before sending */
  batchSize?: number
  /** Flush interval in milliseconds */
  flushInterval?: number
  /** Maximum retry attempts */
  maxRetries?: number
  /** Retry delay in milliseconds */
  retryDelay?: number
  /** Request timeout in milliseconds */
  timeout?: number
  /** Transform entries before sending */
  transform?: (entries: StructuredLogEntry[]) => unknown
  /** Dominating privacy gate applied to the final serialized request body. */
  privacyPredicate: (serializedBody: string) => boolean
  /** Durable retry queue max entries */
  maxQueueEntries?: number
  /** Durable retry queue max serialized bytes */
  maxQueueBytes?: number
  /** Diagnostics emission cooldown for identical codes */
  diagnosticRateLimitMs?: number
  /** Optional diagnostic event emitter */
  diagnosticEmitter?: (event: TransportDiagnosticEvent) => void
  /** Optional custom queue store (primarily for testing) */
  queueStore?: RemoteRetryQueueStore
  /** Platform-owned sender (Rust Host on Tauri, credentialless Collector on web/mobile). */
  fetchImpl?: typeof fetch
}

const DEFAULT_OPTIONS: Omit<
  Required<
    Pick<
      RemoteTransportOptions,
      | "batchSize"
      | "flushInterval"
      | "maxRetries"
      | "retryDelay"
      | "timeout"
      | "maxQueueEntries"
      | "maxQueueBytes"
      | "diagnosticRateLimitMs"
    >
  >,
  never
> = {
  batchSize: 50,
  flushInterval: 5000,
  maxRetries: 3,
  retryDelay: 1000,
  timeout: 10000,
  maxQueueEntries: 5000,
  maxQueueBytes: 10 * 1024 * 1024,
  diagnosticRateLimitMs: 2000,
}

/**
 * Remote transport implementation
 */
export class RemoteTransport implements Transport {
  name = "remote"
  private readonly options: RemoteTransportOptions & typeof DEFAULT_OPTIONS
  private readonly queueStore: RemoteRetryQueueStore
  private readonly fetchImpl: typeof fetch
  private readonly diagnosticCooldown = new Map<string, number>()
  private readonly ready: Promise<void>

  private buffer: StructuredLogEntry[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  // Node 26 ships a global `navigator` WITHOUT `onLine`; the old
  // `typeof navigator === "undefined"` check therefore yielded `undefined` and
  // the transport started up permanently "offline" in CLI/sidecar/headless runs.
  private isOnline = typeof navigator?.onLine === "boolean" ? navigator.onLine : true
  private handleOnline: (() => void) | null = null
  private handleOffline: (() => void) | null = null
  private health: TransportHealthSnapshot = {
    transport: "remote",
    status: this.isOnline ? "healthy" : "offline",
    queueDepth: 0,
    retryCount: 0,
    droppedEntries: 0,
    updatedAt: new Date().toISOString(),
  }
  private hasPendingRecovery = false

  constructor(options: RemoteTransportOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    }

    this.queueStore =
      options.queueStore ||
      createRemoteRetryQueueStore({
        maxEntries: this.options.maxQueueEntries,
        maxBytes: this.options.maxQueueBytes,
      })
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))

    this.queueStore.updateLimits({
      maxEntries: this.options.maxQueueEntries,
      maxBytes: this.options.maxQueueBytes,
    })

    this.ready = this.initialize()
    this.startFlushTimer()
    this.setupOnlineListener()
  }

  /**
   * Setup online/offline listener
   */
  private setupOnlineListener(): void {
    if (typeof window === "undefined") {
      return
    }

    this.handleOnline = () => {
      this.isOnline = true
      this.updateHealth()
      void this.flushRetryQueue()
    }

    this.handleOffline = () => {
      this.isOnline = false
      this.updateHealth()
      this.emitDiagnostic(
        "logger.remote.offline",
        "Remote transport is offline; new batches will be queued for retry.",
        "warn"
      )
    }

    window.addEventListener("online", this.handleOnline)
    window.addEventListener("offline", this.handleOffline)
  }

  /**
   * Start flush timer
   */
  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
    }
    this.flushTimer = setInterval(() => {
      void this.flush()
    }, this.options.flushInterval)
  }

  private async initialize(): Promise<void> {
    try {
      const stats = await this.queueStore.getStats()
      this.updateHealth({
        queueDepth: stats.entryCount,
      })
      if (stats.entryCount > 0) {
        this.hasPendingRecovery = true
      }
      if (this.isOnline && stats.entryCount > 0) {
        await this.flushRetryQueue()
      }
    } catch (error) {
      this.emitDiagnostic(
        "logger.remote.queue_init_failed",
        "Failed to initialize remote retry queue.",
        "warn",
        {
          error: String(error),
        }
      )
    }
  }

  private updateHealth(partial?: Partial<TransportHealthSnapshot>): void {
    const next: TransportHealthSnapshot = {
      ...this.health,
      ...(partial || {}),
      status: this.resolveStatus(partial),
      updatedAt: new Date().toISOString(),
    }
    this.health = next
  }

  private resolveStatus(
    partial?: Partial<TransportHealthSnapshot>
  ): TransportHealthSnapshot["status"] {
    const queueDepth = partial?.queueDepth ?? this.health.queueDepth
    const retryCount = partial?.retryCount ?? this.health.retryCount
    if (!this.isOnline) {
      return "offline"
    }
    if (queueDepth > 0 || retryCount > 0) {
      return "degraded"
    }
    return "healthy"
  }

  private shouldEmitDiagnostic(code: string): boolean {
    const now = Date.now()
    const cooldown = Math.max(250, this.options.diagnosticRateLimitMs)
    const last = this.diagnosticCooldown.get(code)
    if (typeof last === "number" && now - last < cooldown) {
      return false
    }
    this.diagnosticCooldown.set(code, now)
    if (this.diagnosticCooldown.size > 200) {
      for (const [key, ts] of this.diagnosticCooldown.entries()) {
        if (now - ts > 5 * 60_000) {
          this.diagnosticCooldown.delete(key)
        }
      }
    }
    return true
  }

  private emitDiagnostic(
    code: string,
    message: string,
    level: LogLevel = "warn",
    data?: Record<string, unknown>
  ): void {
    if (!this.shouldEmitDiagnostic(code)) {
      return
    }

    this.options.diagnosticEmitter?.({
      code,
      message,
      level,
      data,
      sourceTransport: this.name,
    })
  }

  /**
   * Log entry to buffer
   */
  log(entry: StructuredLogEntry): void {
    this.buffer.push(entry)

    if (this.buffer.length >= this.options.batchSize) {
      void this.flush()
    }
  }

  /**
   * Flush buffer to remote
   */
  async flush(): Promise<void> {
    await this.ready

    await this.flushRetryQueue()

    if (this.buffer.length === 0) {
      return
    }

    const entries = [...this.buffer]
    this.buffer = []
    await this.send(entries, 0, { alreadyPersisted: false })
  }

  /**
   * Send entries to remote with retry
   */
  private async send(
    entries: StructuredLogEntry[],
    attempt = 0,
    options: { alreadyPersisted: boolean }
  ): Promise<boolean> {
    if (!entries.length) {
      return true
    }

    if (!this.isOnline) {
      if (!options.alreadyPersisted) {
        await this.enqueueForRetry(entries, "offline")
      }
      return false
    }

    try {
      const serializedBody = this.serializeSafely(entries)
      if (serializedBody === null) {
        // Treat the batch as consumed so an unsafe persisted replay is deleted
        // rather than retried forever.
        return true
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.options.timeout)

      const response = await this.fetchImpl(this.options.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: serializedBody,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      this.onSendSuccess()
      return true
    } catch (error) {
      const maxRetries = this.options.maxRetries

      if (attempt < maxRetries) {
        const delay = this.options.retryDelay * Math.pow(2, attempt)
        await new Promise((resolve) => setTimeout(resolve, delay))
        return this.send(entries, attempt + 1, options)
      }

      this.onSendFailure(error)
      if (!options.alreadyPersisted) {
        await this.enqueueForRetry(entries, "send-failed", error)
      }
      return false
    }
  }

  private onSendSuccess(): void {
    this.updateHealth({
      lastSuccessAt: new Date().toISOString(),
      lastError: undefined,
    })
  }

  /**
   * Serialize `entries` for the wire, or `null` when nothing survives the gate.
   *
   * The whole batch is checked first, which is one pass and the only cost while
   * nothing is leaking. Only when that fails is the offender worth isolating:
   * a single log line carrying an email address must not take up to `batchSize`
   * unrelated, PII-free entries down with it — and the batch is then permanently
   * deleted from the durable queue, so those entries would be gone for good.
   * `OtlpLogTransport` keeps the clean entries the same way.
   */
  private serializeSafely(entries: StructuredLogEntry[]): string | null {
    const serialize = (rows: StructuredLogEntry[]): string =>
      JSON.stringify(this.options.transform ? this.options.transform(rows) : rows)
    const isSafe = (candidate: string): boolean => {
      try {
        return this.options.privacyPredicate(candidate)
      } catch {
        // A broken gate must fail closed.
        return false
      }
    }

    const whole = serialize(entries)
    if (isSafe(whole)) return whole
    if (entries.length === 1) {
      this.onPrivacyRejected(1)
      return null
    }

    const safeEntries = entries.filter((entry) => isSafe(serialize([entry])))
    const rejected = entries.length - safeEntries.length
    if (rejected > 0) this.onPrivacyRejected(rejected)
    if (safeEntries.length === 0) return null

    // A pattern that only appears once the survivors are joined back together
    // still has to fail closed.
    const remainder = serialize(safeEntries)
    if (isSafe(remainder)) return remainder
    this.onPrivacyRejected(safeEntries.length)
    return null
  }

  private onPrivacyRejected(entryCount: number): void {
    this.updateHealth({
      droppedEntries: this.health.droppedEntries + entryCount,
      lastFailureAt: new Date().toISOString(),
      lastError: "Remote log payload rejected by privacy gate",
    })
    this.emitDiagnostic(
      "logger.remote.privacy_rejected",
      "Rejected remote logs at the outbound privacy gate.",
      "warn",
      { droppedEntries: entryCount }
    )
  }

  private onSendFailure(error: unknown): void {
    this.updateHealth({
      retryCount: this.health.retryCount + 1,
      lastFailureAt: new Date().toISOString(),
      lastError: String(error),
    })

    this.hasPendingRecovery = true
    this.emitDiagnostic(
      "logger.remote.send_failed",
      "Failed to send remote logs after retries.",
      "error",
      {
        error: String(error),
        retryCount: this.health.retryCount,
        queueDepth: this.health.queueDepth,
      }
    )
  }

  private async enqueueForRetry(
    entries: StructuredLogEntry[],
    reason: "offline" | "send-failed",
    error?: unknown
  ): Promise<void> {
    try {
      const result = await this.queueStore.enqueueBatch(entries)
      this.updateHealth({
        queueDepth: result.stats.entryCount,
      })

      this.hasPendingRecovery = true

      if (result.droppedEntries > 0) {
        this.updateHealth({
          droppedEntries: this.health.droppedEntries + result.droppedEntries,
        })

        this.emitDiagnostic(
          "logger.remote.queue_overflow",
          "Dropped queued remote logs due to retry queue capacity limits.",
          "warn",
          {
            droppedEntries: result.droppedEntries,
            droppedBatches: result.droppedBatches,
            maxQueueEntries: this.options.maxQueueEntries,
            maxQueueBytes: this.options.maxQueueBytes,
          }
        )
      }

      if (reason === "offline") {
        this.emitDiagnostic(
          "logger.remote.queued_offline",
          "Queued remote logs while offline.",
          "info",
          {
            queuedEntries: entries.length,
            queueDepth: result.stats.entryCount,
          }
        )
      } else {
        this.emitDiagnostic(
          "logger.remote.queued_after_failure",
          "Queued remote logs after send failures.",
          "warn",
          {
            queuedEntries: entries.length,
            queueDepth: result.stats.entryCount,
            error: String(error),
          }
        )
      }
    } catch (queueError) {
      this.emitDiagnostic(
        "logger.remote.queue_write_failed",
        "Failed to persist remote retry batch.",
        "error",
        {
          reason,
          error: String(queueError),
        }
      )
    }
  }

  /**
   * Flush retry queue when back online
   */
  private async flushRetryQueue(): Promise<void> {
    if (!this.isOnline) {
      return
    }

    const batches = await this.queueStore.listBatches()
    if (!batches.length) {
      this.updateHealth({ queueDepth: 0 })
      return
    }

    for (const batch of batches) {
      const success = await this.send(batch.entries, 0, { alreadyPersisted: true })
      if (!success) {
        const stats = await this.queueStore.getStats()
        this.updateHealth({ queueDepth: stats.entryCount })
        return
      }

      await this.queueStore.deleteBatch(batch.id)
      const stats = await this.queueStore.getStats()
      this.updateHealth({ queueDepth: stats.entryCount })
    }

    if (this.hasPendingRecovery) {
      this.hasPendingRecovery = false
      this.updateHealth({ retryCount: 0 })
      this.emitDiagnostic(
        "logger.remote.recovered",
        "Remote transport recovered and drained queued logs.",
        "info",
        {
          queueDepth: this.health.queueDepth,
        }
      )
    }
  }

  /**
   * Get pending count
   */
  getPendingCount(): number {
    return this.buffer.length + this.health.queueDepth
  }

  getHealth(): TransportHealthSnapshot {
    return {
      ...this.health,
      updatedAt: new Date().toISOString(),
    }
  }

  /**
   * Close transport
   */
  async close(): Promise<void> {
    await this.flush()

    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    if (typeof window !== "undefined") {
      if (this.handleOnline) {
        window.removeEventListener("online", this.handleOnline)
      }
      if (this.handleOffline) {
        window.removeEventListener("offline", this.handleOffline)
      }
    }

    await this.queueStore.close()
  }
}

/**
 * Create remote transport
 */
export function createRemoteTransport(options: RemoteTransportOptions): RemoteTransport {
  return new RemoteTransport(options)
}

/**
 * Sentry-compatible transform
 */
export function sentryTransform(entries: StructuredLogEntry[]): unknown {
  return entries.map((entry) => ({
    level: entry.level === "fatal" ? "fatal" : entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
    extra: {
      module: entry.module,
      traceId: entry.traceId,
      sessionId: entry.sessionId,
      ...entry.data,
    },
    tags: {
      module: entry.module,
      ...(entry.tags?.reduce((acc, tag) => ({ ...acc, [tag]: true }), {}) || {}),
    },
  }))
}

/**
 * Loggly-compatible transform
 */
export function logglyTransform(entries: StructuredLogEntry[]): unknown {
  return entries.map((entry) => ({
    level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
    tag: entry.module,
    traceId: entry.traceId,
    sessionId: entry.sessionId,
    data: entry.data,
  }))
}
