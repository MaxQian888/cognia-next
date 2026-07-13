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
  /** Custom headers */
  headers?: Record<string, string>
  /** Transform entries before sending */
  transform?: (entries: StructuredLogEntry[]) => unknown
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
  private readonly diagnosticCooldown = new Map<string, number>()
  private readonly ready: Promise<void>

  private buffer: StructuredLogEntry[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private isOnline = typeof navigator === "undefined" ? true : navigator.onLine
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
      const body = this.options.transform ? this.options.transform(entries) : entries

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.options.timeout)

      const response = await fetch(this.options.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.options.headers,
        },
        body: JSON.stringify(body),
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
