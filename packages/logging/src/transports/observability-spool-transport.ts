import type { ObservabilityEventScope } from "../observability-event"
import { structuredLogEntryToObservabilityEvent } from "../observability-event"
import {
  CLIENT_PRIVACY_MANIFEST_V1,
  applyObservabilityPrivacy,
  type LocalDebugCaptureSession,
} from "../privacy-manifest"
import type { ObservabilitySpool } from "../spool"
import type {
  StructuredLogEntry,
  Transport,
  TransportDiagnosticEvent,
  TransportHealthSnapshot,
} from "../types"

export interface ObservabilitySpoolTransportOptions {
  spool: ObservabilitySpool
  scope: ObservabilityEventScope | (() => ObservabilityEventScope)
  debugSession?: () => LocalDebugCaptureSession | undefined
  onDiagnostic?: (diagnostic: TransportDiagnosticEvent) => void
}

export class ObservabilitySpoolTransport implements Transport {
  readonly name = "observability-spool"
  private readonly pending = new Set<Promise<void>>()
  private droppedEntries = 0
  private lastSuccessAt?: string
  private lastFailureAt?: string
  private lastError?: string

  constructor(private readonly options: ObservabilitySpoolTransportOptions) {}

  private resolveScope(): ObservabilityEventScope {
    return typeof this.options.scope === "function" ? this.options.scope() : this.options.scope
  }

  log(entry: StructuredLogEntry): Promise<void> {
    const operation = this.persist(entry)
    this.pending.add(operation)
    void operation.finally(() => this.pending.delete(operation))
    return operation
  }

  private async persist(entry: StructuredLogEntry): Promise<void> {
    try {
      const compatible = structuredLogEntryToObservabilityEvent(entry, {
        scope: this.resolveScope(),
        redactionVersion: CLIENT_PRIVACY_MANIFEST_V1.version,
        spoolSequence: 0,
        flushWatermark: 0,
      })
      const event = applyObservabilityPrivacy(compatible, {
        debugSession: this.options.debugSession?.(),
      })
      const result = await this.options.spool.enqueue(event)
      if (result.status === "capacity-exhausted") {
        this.droppedEntries += 1
        this.lastFailureAt = new Date().toISOString()
        this.lastError = result.reason
        this.options.onDiagnostic?.({
          code: "observability.spool.capacity_exhausted",
          message: "The observability spool could not persist an event within its limits.",
          level:
            entry.level === "warn" || entry.level === "error" || entry.level === "fatal"
              ? "error"
              : "warn",
          sourceTransport: this.name,
          data: {
            reason: result.reason,
            eventId: entry.id,
            severity: entry.level,
            eventCount: result.stats.eventCount,
            totalBytes: result.stats.totalBytes,
          },
        })
        return
      }

      this.lastSuccessAt = new Date().toISOString()
      this.lastError = undefined
    } catch (error) {
      this.droppedEntries += 1
      this.lastFailureAt = new Date().toISOString()
      this.lastError = error instanceof Error ? error.message : String(error)
      this.options.onDiagnostic?.({
        code: "observability.spool.write_failed",
        message: "The observability spool failed to persist an event.",
        level: "error",
        sourceTransport: this.name,
        data: { eventId: entry.id, error: this.lastError },
      })
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending])
  }

  getPendingCount(): number {
    return this.pending.size
  }

  getSpool(): ObservabilitySpool {
    return this.options.spool
  }

  getHealth(): TransportHealthSnapshot {
    return {
      transport: this.name,
      status: this.lastError ? "degraded" : "healthy",
      queueDepth: this.pending.size,
      retryCount: 0,
      droppedEntries: this.droppedEntries,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
    }
  }

  async close(): Promise<void> {
    await this.flush()
    await this.options.spool.close()
  }
}

export function createObservabilitySpoolTransport(
  options: ObservabilitySpoolTransportOptions
): ObservabilitySpoolTransport {
  return new ObservabilitySpoolTransport(options)
}
