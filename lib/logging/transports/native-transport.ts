import type {
  LogLevel,
  StructuredLogEntry,
  Transport,
  TransportHealthSnapshot,
} from "@/types/logging"
import { forwardPlatformLoggingEntries } from "@/lib/native/native-logging"
import { isTauri } from "@/lib/tauri"

export interface NativeTransportOptions {
  minLevel?: LogLevel
  batchSize?: number
  flushInterval?: number
}

const DEFAULT_OPTIONS: Required<NativeTransportOptions> = {
  minLevel: "warn",
  batchSize: 10,
  flushInterval: 2000,
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

export class NativeTransport implements Transport {
  name = "native"

  private readonly options: Required<NativeTransportOptions>
  private buffer: StructuredLogEntry[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private health: TransportHealthSnapshot = {
    transport: "native",
    status: isTauri() ? "healthy" : "offline",
    queueDepth: 0,
    retryCount: 0,
    droppedEntries: 0,
    updatedAt: new Date().toISOString(),
  }

  constructor(options: NativeTransportOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    }
    this.startFlushTimer()
  }

  log(entry: StructuredLogEntry): void {
    if (!isTauri()) {
      return
    }

    if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[this.options.minLevel]) {
      return
    }

    this.buffer.push(entry)
    this.updateHealth({
      queueDepth: this.buffer.length,
    })

    if (this.buffer.length >= this.options.batchSize) {
      void this.flush()
    }
  }

  async flush(): Promise<void> {
    if (!isTauri() || this.buffer.length === 0) {
      return
    }

    const entries = [...this.buffer]
    this.buffer = []

    const forwarded = await forwardPlatformLoggingEntries(
      entries.map((entry) => ({
        level: entry.level,
        module: entry.module,
        message: entry.message,
        timestamp: entry.timestamp,
        traceId: entry.traceId,
        sessionId: entry.sessionId,
        data: normalizeEntryData(entry),
      }))
    )

    if (!forwarded) {
      this.buffer.unshift(...entries.slice(0, this.options.batchSize))
      this.updateHealth({
        status: "degraded",
        queueDepth: this.buffer.length,
        retryCount: this.health.retryCount + 1,
        lastFailureAt: new Date().toISOString(),
        lastError: "native_transport_forward_failed",
      })
      return
    }

    this.updateHealth({
      status: "healthy",
      queueDepth: this.buffer.length,
      retryCount: 0,
      lastSuccessAt: new Date().toISOString(),
      lastError: undefined,
    })
  }

  close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    return this.flush()
  }

  getHealth(): TransportHealthSnapshot {
    return this.health
  }

  getPendingCount(): number {
    return this.buffer.length
  }

  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
    }

    this.flushTimer = setInterval(() => {
      void this.flush()
    }, this.options.flushInterval)
  }

  private updateHealth(partial: Partial<TransportHealthSnapshot>): void {
    this.health = {
      ...this.health,
      ...partial,
      updatedAt: new Date().toISOString(),
    }
  }
}

function normalizeEntryData(entry: StructuredLogEntry): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = {
    ...(entry.data || {}),
  }

  if (entry.stack) {
    data.stack = entry.stack
  }
  if (entry.source) {
    data.source = entry.source
  }
  if (entry.tags) {
    data.tags = entry.tags
  }
  if (entry.runtime) {
    data.runtime = entry.runtime
  }
  if (entry.origin) {
    data.origin = entry.origin
  }

  return Object.keys(data).length > 0 ? data : undefined
}

export function createNativeTransport(options?: NativeTransportOptions): NativeTransport {
  return new NativeTransport(options)
}
