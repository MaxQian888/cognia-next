import {
  PERF_WIRE_VERSION,
  type PerfFrame,
  type PerfLeasePurpose,
  type PerfSourceDescriptor,
} from "./backend/types"
import { PERF_NAMESPACE } from "./perf-marker"

const MAX_ENTRIES_PER_NAME = 60

export interface RendererMeasurementEntry {
  name: string
  duration: number
  startTime: number
}

interface Demand {
  id: string
  purpose: PerfLeasePurpose
  cadenceMs: number
}

interface RendererCollectorDependencies {
  documentId?: string
  timeOrigin?: number
  now?: () => number
  wallNow?: () => number
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function defaultDocumentId(): string {
  if (typeof window === "undefined") return "server"
  const slot = window as typeof window & { __COGNIA_PERF_DOCUMENT_ID__?: string }
  slot.__COGNIA_PERF_DOCUMENT_ID__ ??= randomId()
  return slot.__COGNIA_PERF_DOCUMENT_ID__
}

export class RendererPerformanceCollector {
  readonly source: PerfSourceDescriptor
  private readonly measurements = new Map<string, RendererMeasurementEntry[]>()
  private readonly pendingMeasurements = new Map<string, RendererMeasurementEntry[]>()
  private readonly demands = new Map<string, Demand>()
  private readonly listeners = new Set<(frame: PerfFrame) => void>()
  private readonly now: () => number
  private readonly wallNow: () => number
  private readonly schedule: typeof globalThis.setInterval
  private readonly cancel: typeof globalThis.clearInterval
  private timer: ReturnType<typeof setInterval> | null = null
  private timerCadenceMs = 0
  private targetId = "web-standalone"
  private routingGeneration = 0
  private samplingSessionId = randomId()
  private sequence = 0
  private lastMonotonicMs: number
  private observer: PerformanceObserver | null = null

  constructor(dependencies: RendererCollectorDependencies = {}) {
    const documentId = dependencies.documentId ?? defaultDocumentId()
    const timeOrigin =
      dependencies.timeOrigin ??
      (typeof performance === "undefined" ? Date.now() : performance.timeOrigin)
    this.now = dependencies.now ?? (() => performance.now())
    this.wallNow = dependencies.wallNow ?? (() => Date.now())
    this.schedule = dependencies.setInterval ?? globalThis.setInterval.bind(globalThis)
    this.cancel = dependencies.clearInterval ?? globalThis.clearInterval.bind(globalThis)
    this.lastMonotonicMs = this.now()
    this.source = {
      wireVersion: PERF_WIRE_VERSION,
      sourceId: `renderer:${documentId}`,
      kind: "renderer",
      hostInstanceId: documentId,
      runtimeKind: "browser",
      build: {
        version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
        commit: process.env.NEXT_PUBLIC_GIT_COMMIT || null,
        profile:
          process.env.NEXT_PUBLIC_COGNIA_PROFILE_BUILD === "1"
            ? "profiling"
            : process.env.NODE_ENV === "production"
              ? "production"
              : "development",
      },
      metricSchemaVersion: 1,
      capabilities: [
        "renderer.fps",
        "renderer.long-task",
        "renderer.user-timing",
        "renderer.chat-latency",
      ],
      clock: { kind: "performance-time-origin", originWallMs: timeOrigin },
      connection: { state: "live", changedAtMs: this.wallNow(), detail: null },
    }
  }

  setScope(scope: { targetId: string; routingGeneration: number }): void {
    if (scope.targetId === this.targetId && scope.routingGeneration === this.routingGeneration)
      return
    this.targetId = scope.targetId
    this.routingGeneration = scope.routingGeneration
    this.samplingSessionId = randomId()
    this.sequence = 0
    this.lastMonotonicMs = this.now()
    this.pendingMeasurements.clear()
  }

  openDemand(input: { purpose: PerfLeasePurpose; cadenceMs: number }): string {
    const id = randomId()
    this.demands.set(id, { id, purpose: input.purpose, cadenceMs: Math.max(250, input.cadenceMs) })
    this.reconcileSampling()
    return id
  }

  closeDemand(id: string): void {
    this.demands.delete(id)
    this.reconcileSampling()
  }

  subscribe(listener: (frame: PerfFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getMeasurements(): ReadonlyMap<string, RendererMeasurementEntry[]> {
    return this.measurements
  }

  ingestPerformanceEntries(entries: ArrayLike<PerformanceEntry>): boolean {
    let changed = false
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      if (!entry.name.startsWith(PERF_NAMESPACE) && entry.entryType !== "longtask") continue
      const name = entry.entryType === "longtask" ? "renderer:long-task" : entry.name
      const measurement = { name, duration: entry.duration, startTime: entry.startTime }
      this.appendMeasurement(this.measurements, measurement)
      this.appendMeasurement(this.pendingMeasurements, measurement)
      changed = true
    }
    return changed
  }

  collectNow(): PerfFrame {
    const started = this.now()
    const requestedIntervalMs = this.fastestCadence()
    const actualIntervalMs = Math.max(0, started - this.lastMonotonicMs)
    this.lastMonotonicMs = started
    const wallEndMs = this.wallNow()
    const intervalMeasurements = [...this.pendingMeasurements.values()].flat()
    this.pendingMeasurements.clear()
    const longTasks = intervalMeasurements.filter((entry) => entry.name === "renderer:long-task")
    const userTimings = intervalMeasurements.filter((entry) => entry.name !== "renderer:long-task")
    const observations: Record<string, number | null> = {
      "renderer.long-task.count": longTasks.length,
      "renderer.long-task.total-ms": longTasks.reduce((sum, entry) => sum + entry.duration, 0),
      "renderer.user-timing.count": userTimings.length,
    }
    const collectionDurationMs = Math.max(0, this.now() - started)
    const missedTicks =
      requestedIntervalMs > 0
        ? Math.max(0, Math.floor(actualIntervalMs / requestedIntervalMs) - 1)
        : 0
    this.sequence += 1
    return {
      wireVersion: PERF_WIRE_VERSION,
      sourceId: this.source.sourceId,
      targetId: this.targetId,
      routingGeneration: this.routingGeneration,
      hostInstanceId: this.source.hostInstanceId,
      samplingSessionId: this.samplingSessionId,
      sequence: this.sequence,
      requestedIntervalMs,
      actualIntervalMs,
      monotonicElapsedMs: actualIntervalMs,
      wallStartMs: wallEndMs - actualIntervalMs,
      wallEndMs,
      collectionDurationMs,
      missedTicks,
      flags: {
        reset: this.sequence === 1,
        discontinuity: false,
        counterReset: false,
        sourceRestarted: this.sequence === 1,
      },
      tsMs: wallEndMs,
      intervalMs: actualIntervalMs,
      processes: [],
      runtime: {
        workers: 0,
        aliveTasks: 0,
        globalQueueDepth: 0,
        blockingThreads: 0,
        blockingQueueDepth: 0,
        spawnedTasksCount: 0,
        budgetForcedYieldCount: 0,
        workerStealCount: 0,
        workerParkCount: 0,
        workerOverflowCount: 0,
        busyPct: 0,
        perWorkerBusyPct: [],
      },
      topSpans: [],
      systemMemory: null,
      managed: [],
      observations,
    }
  }

  private fastestCadence(): number {
    return Math.min(...[...this.demands.values()].map((demand) => demand.cadenceMs), 1000)
  }

  private appendMeasurement(
    target: Map<string, RendererMeasurementEntry[]>,
    measurement: RendererMeasurementEntry
  ): void {
    const values = target.get(measurement.name) ?? []
    values.push(measurement)
    if (values.length > MAX_ENTRIES_PER_NAME) {
      values.splice(0, values.length - MAX_ENTRIES_PER_NAME)
    }
    target.set(measurement.name, values)
  }

  private reconcileSampling(): void {
    const cadence = this.fastestCadence()
    if (this.demands.size === 0) {
      if (this.timer !== null) this.cancel(this.timer)
      this.timer = null
      this.timerCadenceMs = 0
      this.observer?.disconnect()
      this.observer = null
      return
    }
    this.ensureObserver()
    if (this.timer !== null && this.timerCadenceMs === cadence) return
    if (this.timer !== null) this.cancel(this.timer)
    this.timerCadenceMs = cadence
    this.lastMonotonicMs = this.now()
    this.timer = this.schedule(() => {
      const frame = this.collectNow()
      for (const listener of this.listeners) listener(frame)
    }, cadence)
  }

  private ensureObserver(): void {
    if (this.observer || typeof PerformanceObserver === "undefined") return
    this.observer = new PerformanceObserver((list) =>
      this.ingestPerformanceEntries(list.getEntries())
    )
    try {
      this.observer.observe({ entryTypes: ["measure", "longtask"] })
    } catch {
      try {
        this.observer.observe({ entryTypes: ["measure"] })
      } catch {
        this.observer.disconnect()
        this.observer = null
      }
    }
  }
}

export function createRendererCollector(
  dependencies: RendererCollectorDependencies = {}
): RendererPerformanceCollector {
  return new RendererPerformanceCollector(dependencies)
}

let sharedCollector: RendererPerformanceCollector | null = null

export function getRendererPerformanceCollector(): RendererPerformanceCollector {
  sharedCollector ??= createRendererCollector()
  return sharedCollector
}

export const __test__ = { MAX_ENTRIES_PER_NAME }
