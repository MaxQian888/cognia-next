import {
  PERF_WIRE_VERSION,
  type PerfFrame,
  type PerfLease,
  type PerfOpenLeaseRequest,
  type PerfOpenLeaseResult,
  type PerfSnapshot,
  type PerfSourceDescriptor,
  type RuntimeSample,
} from "./backend/types"
import type { PerformanceHostAdapter } from "./host-adapter"

const MIN_CADENCE_MS = 500
const MAX_CADENCE_MS = 10_000
const LEASE_TTL_MS = 15_000
const MAX_LEASES = 16
const OPEN_RATE_LIMIT_MS = 100
const RING_CAPACITY = 120

interface NodeCounters {
  cpuUserMicros: number
  cpuSystemMicros: number
  rssBytes: number
  heapTotalBytes: number
  heapUsedBytes: number
  externalBytes: number
  arrayBuffersBytes: number
  eventLoopUtilization: number | null
  eventLoopDelayP95Ms: number | null
}

export interface NodePerformanceProvider {
  nowWallMs(): number
  nowMonotonicMs(): number
  collect(): Promise<NodeCounters>
  dispose?(): void
}

export interface NodePerformanceEventSink {
  emit(deviceId: string, frame: PerfFrame): Promise<void> | void
}

interface LeaseState {
  lease: PerfLease
  deliveredSequences: number[]
  lastDeliveredAtMs: number
}

const EMPTY_RUNTIME: RuntimeSample = {
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
}

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

export class NodePerformanceHost implements PerformanceHostAdapter {
  private readonly leases = new Map<string, LeaseState>()
  private readonly lastOpenByDevice = new Map<string, number>()
  private readonly lastRenewByDevice = new Map<string, number>()
  private readonly frames: PerfFrame[] = []
  private readonly source: PerfSourceDescriptor
  private timer: ReturnType<typeof setTimeout> | null = null
  private samplingSessionId = id("session")
  private sequence = 0
  private targetId = ""
  private routingGeneration = 0
  private previousCounters: NodeCounters | null = null
  private previousMonotonicMs = 0
  private activeCadenceMs = 0
  private collecting = false

  constructor(
    private readonly provider: NodePerformanceProvider,
    private readonly sink: NodePerformanceEventSink,
    build: PerfSourceDescriptor["build"] = {
      version: "unknown",
      commit: null,
      profile: process.env.NODE_ENV === "production" ? "production" : "development",
    }
  ) {
    const now = provider.nowWallMs()
    const hostInstanceId = id("node-host")
    this.source = {
      wireVersion: PERF_WIRE_VERSION,
      sourceId: `host:${hostInstanceId}`,
      kind: "host",
      hostInstanceId,
      runtimeKind: "node-headless",
      build,
      metricSchemaVersion: 1,
      capabilities: [
        "host.processes",
        "host.system-memory-utilization",
        "runtime.node",
        "runtime.node-heap",
        "runtime.node-event-loop",
        "host.managed-workers",
      ],
      clock: { kind: "host-monotonic", originWallMs: now - provider.nowMonotonicMs() },
      connection: { state: "live", changedAtMs: now, detail: null },
    }
  }

  async open(input: PerfOpenLeaseRequest): Promise<PerfOpenLeaseResult> {
    const now = this.provider.nowWallMs()
    this.expire(now)
    if (input.requestedCadenceMs < MIN_CADENCE_MS) {
      return this.reject("cadence-too-fast", "remote cadence must be at least 500 ms")
    }
    if (input.requestedCadenceMs > MAX_CADENCE_MS) {
      return this.reject("unsupported", "requested cadence exceeds 10000 ms")
    }
    if (this.leases.size >= MAX_LEASES) {
      return this.reject("host-lease-limit", "host lease limit reached")
    }
    if (
      [...this.leases.values()].some(
        ({ lease }) => lease.deviceId === input.deviceId && lease.purpose === input.purpose
      )
    ) {
      return this.reject("device-purpose-limit", "device already owns this lease purpose")
    }
    const lastOpen = this.lastOpenByDevice.get(input.deviceId)
    if (lastOpen !== undefined && now - lastOpen < OPEN_RATE_LIMIT_MS) {
      return this.reject("rate-limited", "lease open is rate limited")
    }
    this.lastOpenByDevice.set(input.deviceId, now)
    if (this.leases.size === 0) {
      this.targetId = input.targetId
      this.routingGeneration = input.routingGeneration
      this.samplingSessionId = id("session")
      this.sequence = 0
      this.previousCounters = null
      this.frames.length = 0
    } else if (this.targetId !== input.targetId) {
      return this.reject("target-mismatch", "active leases bind another target")
    } else if (this.routingGeneration !== input.routingGeneration) {
      return this.reject(
        "routing-generation-mismatch",
        "active leases bind another routing generation"
      )
    }
    const lease: PerfLease = {
      wireVersion: PERF_WIRE_VERSION,
      leaseId: id("lease"),
      clientId: input.clientId,
      deviceId: input.deviceId,
      targetId: input.targetId,
      routingGeneration: input.routingGeneration,
      sourceId: input.sourceId ?? null,
      purpose: input.purpose,
      requestedCadenceMs: input.requestedCadenceMs,
      samplingSessionId: this.samplingSessionId,
      openedAtMs: now,
      heartbeatAtMs: now,
      expiresAtMs: now + LEASE_TTL_MS,
    }
    this.leases.set(lease.leaseId, {
      lease,
      deliveredSequences: [],
      lastDeliveredAtMs: 0,
    })
    this.ensureLoop()
    return { accepted: true, lease, source: this.source }
  }

  async renew(leaseId: string, deviceId?: string): Promise<void> {
    const now = this.provider.nowWallMs()
    this.expire(now)
    const state = this.leases.get(leaseId)
    if (!state) throw new Error("lease-expired")
    this.assertOwner(state, deviceId)
    const lastRenew = this.lastRenewByDevice.get(state.lease.deviceId)
    if (lastRenew !== undefined && now - lastRenew < OPEN_RATE_LIMIT_MS) {
      throw new Error("rate-limited")
    }
    this.lastRenewByDevice.set(state.lease.deviceId, now)
    state.lease = { ...state.lease, heartbeatAtMs: now, expiresAtMs: now + LEASE_TTL_MS }
  }

  async close(leaseId: string, deviceId?: string): Promise<void> {
    const state = this.requireLease(leaseId, deviceId)
    this.leases.delete(state.lease.leaseId)
    if (this.leases.size === 0) this.cancelLoop()
  }

  async snapshot(leaseId: string, deviceId?: string): Promise<PerfSnapshot> {
    const state = this.requireLease(leaseId, deviceId)
    const sequences = new Set(state.deliveredSequences)
    const frames = this.frames.filter((frame) => sequences.has(frame.sequence))
    return {
      wireVersion: PERF_WIRE_VERSION,
      frames,
      oldestSequence: frames.at(0)?.sequence ?? null,
      latestSequence: frames.at(-1)?.sequence ?? null,
      sources: [this.source],
      leases: [state.lease],
      gaps: [],
      samples: frames,
      running: true,
      intervalMs: state.lease.requestedCadenceMs,
    }
  }

  async readObservations(
    leaseId: string,
    afterSequence?: number,
    deviceId?: string
  ): Promise<PerfFrame[]> {
    const snapshot = await this.snapshot(leaseId, deviceId)
    return snapshot.frames.filter(
      (frame) => afterSequence === undefined || frame.sequence > afterSequence
    )
  }

  async stop(): Promise<void> {
    this.leases.clear()
    this.cancelLoop()
    this.provider.dispose?.()
  }

  private reject(code: Exclude<PerfOpenLeaseResult, { accepted: true }>["code"], detail: string) {
    return { accepted: false as const, code, detail }
  }

  private requireLease(leaseId: string, deviceId?: string): LeaseState {
    this.expire(this.provider.nowWallMs())
    const state = this.leases.get(leaseId)
    if (!state) throw new Error("lease-expired")
    this.assertOwner(state, deviceId)
    return state
  }

  private assertOwner(state: LeaseState, deviceId?: string): void {
    if (deviceId !== undefined && state.lease.deviceId !== deviceId) {
      throw new Error("permission-denied")
    }
  }

  private expire(now: number): void {
    for (const [leaseId, state] of this.leases) {
      if (state.lease.expiresAtMs <= now) this.leases.delete(leaseId)
    }
    if (this.leases.size === 0) this.cancelLoop()
  }

  private fastestCadence(): number {
    return Math.min(...[...this.leases.values()].map(({ lease }) => lease.requestedCadenceMs))
  }

  private ensureLoop(): void {
    if (this.timer || this.collecting) return
    this.activeCadenceMs = this.fastestCadence()
    this.previousMonotonicMs = this.provider.nowMonotonicMs()
    this.timer = setTimeout(() => void this.tick(), this.activeCadenceMs)
  }

  private cancelLoop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.previousCounters = null
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (this.collecting || this.leases.size === 0) return
    this.collecting = true
    try {
      const started = this.provider.nowMonotonicMs()
      const counters = await this.provider.collect()
      const wallEndMs = this.provider.nowWallMs()
      const ended = this.provider.nowMonotonicMs()
      const elapsedMs = Math.max(1, started - this.previousMonotonicMs)
      const cadence = this.fastestCadence()
      const cadenceChanged = this.activeCadenceMs !== cadence
      const previous = cadenceChanged ? null : this.previousCounters
      this.activeCadenceMs = cadence
      this.previousMonotonicMs = started
      this.previousCounters = counters
      const cpuMicros = previous
        ? Math.max(
            0,
            counters.cpuUserMicros +
              counters.cpuSystemMicros -
              previous.cpuUserMicros -
              previous.cpuSystemMicros
          )
        : 0
      const cpuPct = previous ? Math.min(100, (cpuMicros / (elapsedMs * 1000)) * 100) : 0
      const sequence = ++this.sequence
      const frame: PerfFrame = {
        wireVersion: PERF_WIRE_VERSION,
        sourceId: this.source.sourceId,
        targetId: this.targetId,
        routingGeneration: this.routingGeneration,
        hostInstanceId: this.source.hostInstanceId,
        samplingSessionId: this.samplingSessionId,
        sequence,
        requestedIntervalMs: cadence,
        actualIntervalMs: elapsedMs,
        monotonicElapsedMs: elapsedMs,
        wallStartMs: wallEndMs - elapsedMs,
        wallEndMs,
        collectionDurationMs: Math.max(0, ended - started),
        missedTicks: Math.max(0, Math.floor(elapsedMs / cadence) - 1),
        flags: {
          reset: !previous,
          discontinuity: false,
          counterReset: !previous,
          sourceRestarted: sequence === 1,
        },
        tsMs: wallEndMs,
        intervalMs: elapsedMs,
        processes: [
          {
            pid: process.pid,
            parentPid: process.ppid || null,
            name: "cognia-agent",
            role: "main",
            cpuPct,
            cpuPctRaw: cpuPct,
            memBytes: counters.rssBytes,
            diskReadBps: 0,
            diskWriteBps: 0,
            runSecs: process.uptime(),
            incarnation: `${process.pid}:${Math.floor(wallEndMs - process.uptime() * 1000)}`,
          },
        ],
        runtime: EMPTY_RUNTIME,
        topSpans: [],
        systemMemory: null,
        managed: [],
        observations: {
          "node.cpu.utilization.pct": previous ? cpuPct : null,
          "node.memory.rss.bytes": counters.rssBytes,
          "node.heap.total.bytes": counters.heapTotalBytes,
          "node.heap.used.bytes": counters.heapUsedBytes,
          "node.memory.external.bytes": counters.externalBytes,
          "node.memory.array-buffers.bytes": counters.arrayBuffersBytes,
          "node.event-loop.utilization.pct":
            counters.eventLoopUtilization === null ? null : counters.eventLoopUtilization * 100,
          "node.event-loop.delay.p95.ms": counters.eventLoopDelayP95Ms,
        },
      }
      this.frames.push(frame)
      if (this.frames.length > RING_CAPACITY) this.frames.shift()
      const oldest = this.frames.at(0)?.sequence ?? sequence
      for (const state of this.leases.values()) {
        if (
          state.lastDeliveredAtMs !== 0 &&
          wallEndMs - state.lastDeliveredAtMs < state.lease.requestedCadenceMs
        ) {
          continue
        }
        state.lastDeliveredAtMs = wallEndMs
        state.deliveredSequences.push(sequence)
        state.deliveredSequences = state.deliveredSequences.filter((value) => value >= oldest)
        await this.sink.emit(state.lease.deviceId, {
          ...frame,
          leaseId: state.lease.leaseId,
          requestedIntervalMs: state.lease.requestedCadenceMs,
        })
      }
    } finally {
      this.collecting = false
      this.expire(this.provider.nowWallMs())
      if (this.leases.size > 0) {
        this.timer = setTimeout(() => void this.tick(), this.fastestCadence())
      }
    }
  }
}

export async function createNativeNodePerformanceProvider(): Promise<NodePerformanceProvider> {
  // The Node-host provider itself. Its only importer is
  // lib/headless/runtimes/performance-runtime.ts, and the import is lazy, so
  // no renderer bundle ever evaluates it.
  // static-export-exempt: Node-host only, lazy import
  const { monitorEventLoopDelay, performance: nodePerformance } = await import("node:perf_hooks")
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  let priorEventLoop = nodePerformance.eventLoopUtilization()
  return {
    nowWallMs: Date.now,
    nowMonotonicMs: () => nodePerformance.now(),
    collect: async () => {
      const cpu = process.cpuUsage()
      const memory = process.memoryUsage()
      const eventLoop = nodePerformance.eventLoopUtilization(priorEventLoop)
      priorEventLoop = nodePerformance.eventLoopUtilization()
      const delayP95 = histogram.percentile(95) / 1_000_000
      histogram.reset()
      return {
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
        rssBytes: memory.rss,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        eventLoopUtilization: eventLoop.utilization,
        eventLoopDelayP95Ms: Number.isFinite(delayP95) ? delayP95 : null,
      }
    },
    dispose: () => histogram.disable(),
  }
}
