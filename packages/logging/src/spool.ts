import type { ObservabilityEventV1 } from "./observability-event"
import { LEVEL_PRIORITY } from "./types"

export interface ObservabilitySpoolLimits {
  maxEvents: number
  maxBytes: number
}

export interface ObservabilitySpoolRecord {
  sequence: number
  bytes: number
  event: ObservabilityEventV1
}

export interface ObservabilitySpoolStats {
  eventCount: number
  totalBytes: number
  lastSequence: number
  flushWatermark: number
  droppedLowSeverityEvents: number
  rejectedProtectedEvents: number
}

export type SpoolCapacityReason =
  "event-too-large" | "protected-severity-capacity" | "low-severity-capacity"

export type ObservabilitySpoolEnqueueResult =
  | {
      status: "stored"
      record: ObservabilitySpoolRecord
      evicted: ObservabilitySpoolRecord[]
      stats: ObservabilitySpoolStats
    }
  | {
      status: "capacity-exhausted"
      reason: SpoolCapacityReason
      evicted: ObservabilitySpoolRecord[]
      stats: ObservabilitySpoolStats
    }

export interface ObservabilitySpoolStore {
  enqueue(
    event: ObservabilityEventV1,
    limits: ObservabilitySpoolLimits
  ): Promise<ObservabilitySpoolEnqueueResult>
  list(options: { afterSequence?: number; limit: number }): Promise<ObservabilitySpoolRecord[]>
  ackThrough(sequence: number): Promise<ObservabilitySpoolStats>
  getStats(): Promise<ObservabilitySpoolStats>
  clear(): Promise<void>
  close?(): Promise<void>
}

interface MemoryState extends ObservabilitySpoolStats {
  records: ObservabilitySpoolRecord[]
}

function initialState(): MemoryState {
  return {
    records: [],
    eventCount: 0,
    totalBytes: 0,
    lastSequence: 0,
    flushWatermark: 0,
    droppedLowSeverityEvents: 0,
    rejectedProtectedEvents: 0,
  }
}

function cloneEvent(event: ObservabilityEventV1): ObservabilityEventV1 {
  return JSON.parse(JSON.stringify(event)) as ObservabilityEventV1
}

function serializedBytes(event: ObservabilityEventV1): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength
}

function snapshot(state: MemoryState): ObservabilitySpoolStats {
  const { records: _records, ...stats } = state
  return { ...stats }
}

function isProtected(event: ObservabilityEventV1): boolean {
  return LEVEL_PRIORITY[event.severity] >= LEVEL_PRIORITY.warn
}

/**
 * Deterministic store used by non-persistent runtimes and by contract tests.
 * Mutations are serialized so concurrent producers observe one sequence and
 * one capacity decision.
 */
export class MemoryObservabilitySpoolStore implements ObservabilitySpoolStore {
  private state = initialState()
  private mutationTail: Promise<void> = Promise.resolve()

  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async enqueue(
    sourceEvent: ObservabilityEventV1,
    limits: ObservabilitySpoolLimits
  ): Promise<ObservabilitySpoolEnqueueResult> {
    return this.exclusive(() => {
      const sequence = this.state.lastSequence + 1
      const event = cloneEvent({
        ...sourceEvent,
        delivery: {
          spoolSequence: sequence,
          flushWatermark: this.state.flushWatermark,
        },
      })
      const bytes = serializedBytes(event)
      const evicted: ObservabilitySpoolRecord[] = []

      if (bytes > limits.maxBytes || limits.maxEvents < 1) {
        if (isProtected(event)) this.state.rejectedProtectedEvents += 1
        return {
          status: "capacity-exhausted",
          reason: "event-too-large",
          evicted,
          stats: snapshot(this.state),
        }
      }

      while (
        this.state.eventCount + 1 > limits.maxEvents ||
        this.state.totalBytes + bytes > limits.maxBytes
      ) {
        const index = this.state.records.findIndex((record) => !isProtected(record.event))
        if (index < 0) break
        const [removed] = this.state.records.splice(index, 1)
        this.state.eventCount -= 1
        this.state.totalBytes -= removed.bytes
        this.state.droppedLowSeverityEvents += 1
        evicted.push(removed)
      }

      if (
        this.state.eventCount + 1 > limits.maxEvents ||
        this.state.totalBytes + bytes > limits.maxBytes
      ) {
        if (isProtected(event)) this.state.rejectedProtectedEvents += 1
        else this.state.droppedLowSeverityEvents += 1
        return {
          status: "capacity-exhausted",
          reason: isProtected(event) ? "protected-severity-capacity" : "low-severity-capacity",
          evicted,
          stats: snapshot(this.state),
        }
      }

      const record = { sequence, bytes, event }
      this.state.records.push(record)
      this.state.eventCount += 1
      this.state.totalBytes += bytes
      this.state.lastSequence = sequence
      return { status: "stored", record, evicted, stats: snapshot(this.state) }
    })
  }

  async list(options: {
    afterSequence?: number
    limit: number
  }): Promise<ObservabilitySpoolRecord[]> {
    await this.mutationTail
    const after = options.afterSequence ?? 0
    return this.state.records
      .filter((record) => record.sequence > after)
      .slice(0, Math.max(0, options.limit))
      .map((record) => ({ ...record, event: cloneEvent(record.event) }))
  }

  async ackThrough(sequence: number): Promise<ObservabilitySpoolStats> {
    return this.exclusive(() => {
      const acknowledged = this.state.records.filter((record) => record.sequence <= sequence)
      this.state.records = this.state.records.filter((record) => record.sequence > sequence)
      this.state.eventCount -= acknowledged.length
      this.state.totalBytes -= acknowledged.reduce((sum, record) => sum + record.bytes, 0)
      this.state.flushWatermark = Math.max(this.state.flushWatermark, sequence)
      return snapshot(this.state)
    })
  }

  async getStats(): Promise<ObservabilitySpoolStats> {
    await this.mutationTail
    return snapshot(this.state)
  }

  async clear(): Promise<void> {
    await this.exclusive(() => {
      this.state = initialState()
    })
  }
}

export interface SpoolDrainOptions {
  batchSize: number
  timeoutMs: number
  now?: () => number
}

export interface SpoolDrainResult {
  acknowledged: number
  unfinished: number
  timedOut: boolean
}

export class ObservabilitySpool {
  constructor(
    private readonly store: ObservabilitySpoolStore,
    private readonly limits: ObservabilitySpoolLimits
  ) {}

  enqueue(event: ObservabilityEventV1): Promise<ObservabilitySpoolEnqueueResult> {
    return this.store.enqueue(event, this.limits)
  }

  readBatch(options: {
    afterSequence?: number
    limit: number
  }): Promise<ObservabilitySpoolRecord[]> {
    return this.store.list(options)
  }

  ackThrough(sequence: number): Promise<ObservabilitySpoolStats> {
    return this.store.ackThrough(sequence)
  }

  getStats(): Promise<ObservabilitySpoolStats> {
    return this.store.getStats()
  }

  async drain(
    sink: (records: ObservabilitySpoolRecord[]) => Promise<number>,
    options: SpoolDrainOptions
  ): Promise<SpoolDrainResult> {
    const now = options.now ?? Date.now
    const startedAt = now()
    let acknowledged = 0

    while (now() - startedAt < options.timeoutMs) {
      const records = await this.store.list({ limit: Math.max(1, options.batchSize) })
      if (records.length === 0) break
      const acknowledgedThrough = await sink(records)
      const count = records.filter((record) => record.sequence <= acknowledgedThrough).length
      if (count === 0) break
      await this.store.ackThrough(acknowledgedThrough)
      acknowledged += count
    }

    const stats = await this.store.getStats()
    return {
      acknowledged,
      unfinished: stats.eventCount,
      timedOut: stats.eventCount > 0 && now() - startedAt >= options.timeoutMs,
    }
  }

  async close(): Promise<void> {
    await this.store.close?.()
  }
}
