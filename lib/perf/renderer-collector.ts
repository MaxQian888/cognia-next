import {
  PERF_WIRE_VERSION,
  type PerfFrame,
  type PerfLeasePurpose,
  type PerfSourceDescriptor,
} from "./backend/types"
import { PERF_NAMESPACE } from "./perf-marker"

const MAX_ENTRIES_PER_NAME = 60

/**
 * The fields {@link RendererPerformanceCollector.ingestPerformanceEntries}
 * actually reads. Narrower than the DOM's `PerformanceEntry` on purpose: a real
 * entry satisfies it, and a caller (or a test) with a plain object no longer has
 * to fabricate `toJSON` and the rest of an interface nothing here touches.
 */
export interface PerformanceEntryLike {
  name: string
  entryType: string
  duration: number
  startTime: number
}

/**
 * The timer seams, declared as the single call shape this class uses rather
 * than as the full overloaded `typeof globalThis.setInterval`. The globals
 * remain assignable; a test stub finally is too.
 */
export type IntervalScheduler = (
  handler: () => void,
  timeoutMs: number
) => ReturnType<typeof setInterval>
export type IntervalCanceller = (handle: ReturnType<typeof setInterval>) => void

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

/** `performance.memory` — Chromium-only, absent in WebKit (Tauri on macOS, iOS). */
export interface RendererHeapReading {
  usedJSHeapSize: number
  jsHeapSizeLimit: number
}

interface RendererCollectorDependencies {
  documentId?: string
  timeOrigin?: number
  now?: () => number
  wallNow?: () => number
  setInterval?: IntervalScheduler
  clearInterval?: IntervalCanceller
  /** Frame-callback seam for FPS. `null` = the engine has none (no FPS capability). */
  requestAnimationFrame?: ((callback: () => void) => number) | null
  cancelAnimationFrame?: (handle: number) => void
  /** `null` = the engine exposes no heap reading (no js-heap capability). */
  readHeap?: (() => RendererHeapReading | null) | null
  /** `PerformanceObserver.supportedEntryTypes`; long tasks are Chromium-only. */
  supportedEntryTypes?: readonly string[]
  /** Measures already on the global timeline when sampling starts. */
  bufferedMeasures?: () => ArrayLike<PerformanceEntryLike>
  /** A hidden document gets no frame callbacks, so its FPS is unmeasured, not 0. */
  isHidden?: () => boolean
}

function defaultRequestAnimationFrame(): ((callback: () => void) => number) | null {
  if (typeof requestAnimationFrame !== "function") return null
  return (callback) => requestAnimationFrame(() => callback())
}

function defaultReadHeap(): (() => RendererHeapReading | null) | null {
  if (typeof performance === "undefined") return null
  const memory = (performance as Performance & { memory?: RendererHeapReading }).memory
  if (!memory || typeof memory.usedJSHeapSize !== "number") return null
  return () => {
    const current = (performance as Performance & { memory?: RendererHeapReading }).memory
    // Read the fields by name: `MemoryInfo` exposes them as prototype getters,
    // so a spread copies nothing and the heap read as "not measured".
    return current
      ? { usedJSHeapSize: current.usedJSHeapSize, jsHeapSizeLimit: current.jsHeapSizeLimit }
      : null
  }
}

function defaultSupportedEntryTypes(): readonly string[] {
  if (typeof PerformanceObserver === "undefined") return []
  return PerformanceObserver.supportedEntryTypes ?? []
}

function defaultBufferedMeasures(): ArrayLike<PerformanceEntryLike> {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") {
    return []
  }
  return performance.getEntriesByType("measure")
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
  private readonly schedule: IntervalScheduler
  private readonly cancel: IntervalCanceller
  private timer: ReturnType<typeof setInterval> | null = null
  private timerCadenceMs = 0
  private targetId = "web-standalone"
  private routingGeneration = 0
  private samplingSessionId = randomId()
  private sequence = 0
  private lastMonotonicMs: number
  private observer: PerformanceObserver | null = null
  private readonly requestFrame: ((callback: () => void) => number) | null
  private readonly cancelFrame: (handle: number) => void
  private readonly readHeap: (() => RendererHeapReading | null) | null
  private readonly bufferedMeasures: () => ArrayLike<PerformanceEntryLike>
  private readonly isHidden: () => boolean
  private frameHandle: number | null = null
  private framesInInterval = 0
  /** Entries older than the last explicit clear stay cleared, even when re-seeded. */
  private clearedBeforeMs = Number.NEGATIVE_INFINITY

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
    this.requestFrame =
      dependencies.requestAnimationFrame === undefined
        ? defaultRequestAnimationFrame()
        : dependencies.requestAnimationFrame
    this.cancelFrame =
      dependencies.cancelAnimationFrame ??
      ((handle) => {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle)
      })
    this.readHeap = dependencies.readHeap === undefined ? defaultReadHeap() : dependencies.readHeap
    this.bufferedMeasures = dependencies.bufferedMeasures ?? defaultBufferedMeasures
    this.isHidden =
      dependencies.isHidden ??
      (() => typeof document !== "undefined" && document.visibilityState === "hidden")
    const supportedEntryTypes = dependencies.supportedEntryTypes ?? defaultSupportedEntryTypes()
    // Advertise only what this engine can measure. The list used to be fixed,
    // so WebKit (no long tasks, no heap) claimed metrics it always reported
    // as zero, and "renderer.fps" was claimed with nothing measuring it.
    const capabilities = [
      ...(this.requestFrame ? ["renderer.fps"] : []),
      ...(supportedEntryTypes.includes("longtask") ? ["renderer.long-task"] : []),
      "renderer.user-timing",
      "renderer.chat-latency",
      ...(this.readHeap ? ["renderer.js-heap"] : []),
    ]
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
      capabilities,
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

  /**
   * Drop every retained measurement.
   *
   * Exists so the HUD's "clear" button has something to call. It used to cast
   * the `ReadonlyMap` from `getMeasurements()` to a mutable `Map` and clear it
   * through that handle, which worked only because the two share one object —
   * a lie the type system stopped accepting.
   */
  clearMeasurements(): void {
    this.measurements.clear()
    this.clearedBeforeMs = this.now()
  }

  ingestPerformanceEntries(entries: ArrayLike<PerformanceEntryLike>): boolean {
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
    const longTaskTotalMs = longTasks.reduce((sum, entry) => sum + entry.duration, 0)
    const measuresLongTasks = this.source.capabilities.includes("renderer.long-task")
    const frames = this.framesInInterval
    this.framesInInterval = 0
    const heap = this.readHeap?.() ?? null
    const observations: Record<string, number | null> = {
      "renderer.long-task.count": measuresLongTasks ? longTasks.length : null,
      "renderer.long-task.total-ms": measuresLongTasks ? longTaskTotalMs : null,
      // Share of the interval the main thread spent inside long tasks (>50 ms
      // each). A long task can straddle the boundary, so it is clamped.
      "renderer.main-thread-blocked.pct":
        measuresLongTasks && actualIntervalMs > 0
          ? Math.min(100, (longTaskTotalMs / actualIntervalMs) * 100)
          : null,
      "renderer.user-timing.count": userTimings.length,
      // Frame callbacks stop while the document is hidden; that interval did
      // not measure FPS, it did not render at 0 FPS.
      "renderer.fps":
        this.requestFrame && actualIntervalMs > 0 && !this.isHidden()
          ? (frames * 1000) / actualIntervalMs
          : null,
      "renderer.js-heap.used.bytes": heap ? heap.usedJSHeapSize : null,
      "renderer.js-heap.limit.bytes": heap ? heap.jsHeapSizeLimit : null,
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
      this.stopFrameLoop()
      return
    }
    this.ensureObserver()
    this.startFrameLoop()
    if (this.timer !== null && this.timerCadenceMs === cadence) return
    if (this.timer !== null) this.cancel(this.timer)
    this.timerCadenceMs = cadence
    this.lastMonotonicMs = this.now()
    this.timer = this.schedule(() => {
      const frame = this.collectNow()
      for (const listener of this.listeners) listener(frame)
    }, cadence)
  }

  /** Counts frame callbacks only while someone is sampling. */
  private startFrameLoop(): void {
    const request = this.requestFrame
    if (!request || this.frameHandle !== null) return
    this.framesInInterval = 0
    const tick = () => {
      this.framesInInterval += 1
      this.frameHandle = request(tick)
    }
    this.frameHandle = request(tick)
  }

  private stopFrameLoop(): void {
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle)
    this.frameHandle = null
    this.framesInInterval = 0
  }

  /**
   * Pull in measures written before sampling began — the observer only sees
   * entries created after it subscribes, so a chat turn finished before
   * `/performance` opened was invisible to it. Seeded entries go to the
   * retained history only: they belong to no live interval.
   */
  private seedBufferedMeasures(): void {
    const entries = this.bufferedMeasures()
    const touched = new Set<string>()
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      if (entry.entryType !== "measure" || !entry.name.startsWith(PERF_NAMESPACE)) continue
      if (entry.startTime < this.clearedBeforeMs) continue
      const retained = this.measurements.get(entry.name) ?? []
      // Already ingested live (the same entry seen by an earlier observer).
      if (
        retained.some(
          (item) => item.startTime === entry.startTime && item.duration === entry.duration
        )
      ) {
        continue
      }
      // Older than everything a full history keeps: it would be evicted at once.
      if (retained.length >= MAX_ENTRIES_PER_NAME && entry.startTime < retained[0].startTime) {
        continue
      }
      this.appendMeasurement(this.measurements, {
        name: entry.name,
        duration: entry.duration,
        startTime: entry.startTime,
      })
      touched.add(entry.name)
    }
    // Seeds can predate live entries; keep each history chronological so the
    // bound keeps evicting the oldest.
    for (const name of touched) {
      const values = this.measurements.get(name)
      if (!values) continue
      values.sort((left, right) => left.startTime - right.startTime)
      if (values.length > MAX_ENTRIES_PER_NAME) {
        values.splice(0, values.length - MAX_ENTRIES_PER_NAME)
      }
    }
  }

  private ensureObserver(): void {
    if (this.observer) return
    this.seedBufferedMeasures()
    if (typeof PerformanceObserver === "undefined") return
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
