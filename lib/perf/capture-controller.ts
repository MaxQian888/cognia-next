import { loadOrCreateAccountArtifactKey } from "@/lib/ai/eval/artifact-crypto"
import { getDb, type CogniaDB } from "@/lib/db/schema"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { useAccountStore } from "@/stores/account/account-store"
import {
  perfCloseLease,
  perfLeaseSnapshot,
  perfOpenLease,
  perfReadSystemDetails,
  perfRenewLease,
  subscribePerfFrame,
} from "./backend/commands"
import type { PerfFrame, PerfGap, PerfSourceKind } from "./backend/types"
import type { PerformanceCaptureStopReason } from "./capture-types"
import {
  getActivePerformanceCaptureCoordinator,
  type PerformanceCaptureSession,
} from "./capture-service"
import { PerformanceQuotaManager } from "./quota"
import { getRendererPerformanceCollector } from "./renderer-collector"
import { subscribePerformanceSecurityBarrier } from "./security-generation"

const HEARTBEAT_MS = 5_000

export interface StartPerformanceCaptureInput {
  sourceKind: PerfSourceKind
  cadenceMs: number
  durationMs?: number
}

export interface PerformanceCaptureControllerState {
  captureId: string | null
  sourceKind: PerfSourceKind | null
  targetId: string | null
  startedAt: number | null
  active: boolean
  gapCount: number
  error: string | null
}

interface CaptureControllerDependencies {
  getDb(): CogniaDB
  getScope(): ReturnType<typeof getActiveRuntimeTargetContext>
  getAccountId(): string | null
  loadKey(accountId: string): Promise<Uint8Array>
  createQuota(): PerformanceQuotaManager
  coordinator(): Pick<ReturnType<typeof getActivePerformanceCaptureCoordinator>, "start" | "stop">
  now(): number
}

const DEFAULT_STATE: PerformanceCaptureControllerState = {
  captureId: null,
  sourceKind: null,
  targetId: null,
  startedAt: null,
  active: false,
  gapCount: 0,
  error: null,
}

export class PerformanceCaptureController {
  private state: PerformanceCaptureControllerState = DEFAULT_STATE
  private readonly listeners = new Set<(state: PerformanceCaptureControllerState) => void>()
  private unsubscribeFrames: (() => void) | null = null
  private closeDemand: (() => void) | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private leaseId: string | null = null
  private session: PerformanceCaptureSession | null = null
  private quota: PerformanceQuotaManager | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private lastSequence: number | null = null
  private accountId: string | null = null
  private expectedSourceId: string | null = null
  private expectedHostInstanceId: string | null = null
  private expectedCadenceMs: number | null = null
  private lastAcceptedWallMs = 0
  private readonly unsubscribeSecurity: () => void

  constructor(
    private readonly dependencies: CaptureControllerDependencies = {
      getDb,
      getScope: getActiveRuntimeTargetContext,
      getAccountId: () => useAccountStore.getState().unlockedAccountId,
      loadKey: (accountId) => loadOrCreateAccountArtifactKey(accountId, "performance"),
      createQuota: () => new PerformanceQuotaManager(),
      coordinator: getActivePerformanceCaptureCoordinator,
      now: Date.now,
    }
  ) {
    this.unsubscribeSecurity = subscribePerformanceSecurityBarrier((event) => {
      if (!this.state.active || event.accountId !== this.accountId) return
      this.completeSession(`account-locked:${event.accountId}`)
    })
  }

  get snapshot(): PerformanceCaptureControllerState {
    // useSyncExternalStore requires referential stability until publish replaces
    // the state object. Consumers receive a read-only conventionally-owned view.
    return this.state
  }

  subscribe(listener: (state: PerformanceCaptureControllerState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(input: StartPerformanceCaptureInput): Promise<string> {
    if (this.state.active || this.session) throw new Error("performance-capture-already-active")
    if (!Number.isSafeInteger(input.cadenceMs) || input.cadenceMs < 500) {
      throw new Error("performance-capture-cadence-invalid")
    }
    const scope = this.dependencies.getScope()
    const accountId = scope?.accountId ?? this.dependencies.getAccountId()
    if (!accountId) throw new Error("performance-capture-account-locked")
    if (this.dependencies.getAccountId() !== accountId) {
      throw new Error("performance-capture-account-locked")
    }
    const targetId = scope?.targetId ?? "web-standalone"
    const routingGeneration = scope?.routingGeneration ?? 0
    const db = this.dependencies.getDb()
    const key = await this.dependencies.loadKey(accountId)
    const quota = this.dependencies.createQuota()
    this.quota = quota
    this.accountId = accountId
    let source = getRendererPerformanceCollector().source
    let environmentSnapshot: unknown = null
    const bufferedFrames: PerfFrame[] = []

    if (input.sourceKind === "renderer") {
      const collector = getRendererPerformanceCollector()
      collector.setScope({ targetId, routingGeneration })
      source = collector.source
      const demandId = collector.openDemand({ purpose: "capture", cadenceMs: input.cadenceMs })
      this.closeDemand = () => collector.closeDemand(demandId)
      this.unsubscribeFrames = collector.subscribe((frame) => {
        if (!this.session) bufferedFrames.push(frame)
        else this.queueFrame(frame)
      })
      environmentSnapshot = {
        runtimeKind: source.runtimeKind,
        build: source.build,
        hardwareConcurrency:
          typeof navigator === "undefined" ? null : navigator.hardwareConcurrency || null,
        platform: typeof navigator === "undefined" ? null : navigator.platform || null,
      }
    } else {
      this.unsubscribeFrames = subscribePerfFrame((frame) => {
        if (this.leaseId && frame.leaseId && frame.leaseId !== this.leaseId) return
        if (!this.session) bufferedFrames.push(frame)
        else this.queueFrame(frame)
      })
      const opened = await perfOpenLease({
        clientId: `capture:${crypto.randomUUID()}`,
        deviceId: source.hostInstanceId,
        targetId,
        routingGeneration,
        purpose: "capture",
        requestedCadenceMs: input.cadenceMs,
        sourceId: source.sourceId,
      })
      if (!opened.accepted) {
        this.teardownDemand()
        throw new Error(`${opened.code}:${opened.detail}`)
      }
      this.leaseId = opened.lease.leaseId
      source = opened.source
      environmentSnapshot = await perfReadSystemDetails()
      const snapshot = await perfLeaseSnapshot(opened.lease.leaseId)
      bufferedFrames.push(...snapshot.frames)
      this.heartbeat = setInterval(() => {
        if (!this.leaseId) return
        void perfRenewLease(this.leaseId).catch(() => void this.stop("remote-timeout"))
      }, HEARTBEAT_MS)
    }

    try {
      this.session = await this.dependencies.coordinator().start({
        accountId,
        targetDatabase: db.name,
        targetId,
        routingGeneration,
        source,
        requestedCadenceMs: input.cadenceMs,
        environmentSnapshot,
        key,
        db,
        quota,
        durationMs: input.durationMs,
        onDemandEnd: () => this.endDemand(),
        onStopped: () => this.completeSession(),
      })
    } catch (error) {
      this.teardownDemand()
      quota.close()
      this.quota = null
      throw error
    }
    this.expectedSourceId = source.sourceId
    this.expectedHostInstanceId = source.hostInstanceId
    this.expectedCadenceMs = input.cadenceMs
    this.lastAcceptedWallMs = 0
    this.lastSequence = null
    this.publish({
      captureId: this.session.id,
      sourceKind: input.sourceKind,
      targetId,
      startedAt: this.dependencies.now(),
      active: true,
      gapCount: 0,
      error: null,
    })
    for (const frame of bufferedFrames) this.queueFrame(frame)
    return this.session.id
  }

  async stop(reason: PerformanceCaptureStopReason = "manual") {
    await this.dependencies.coordinator().stop(reason)
    await this.writeQueue
    this.completeSession()
  }

  dispose(): void {
    this.teardownDemand()
    this.unsubscribeSecurity()
    this.listeners.clear()
  }

  private queueFrame(frame: PerfFrame): void {
    const session = this.session
    if (!session || !this.state.active) return
    if (
      frame.sourceId !== this.expectedSourceId ||
      frame.hostInstanceId !== this.expectedHostInstanceId
    ) {
      return
    }
    if (
      this.lastAcceptedWallMs !== 0 &&
      frame.wallEndMs - this.lastAcceptedWallMs < (this.expectedCadenceMs ?? 0)
    ) {
      return
    }
    this.lastAcceptedWallMs = frame.wallEndMs
    const normalizedFrame = {
      ...frame,
      requestedIntervalMs: this.expectedCadenceMs ?? frame.requestedIntervalMs,
    }
    const currentScope = this.dependencies.getScope()
    if (
      frame.targetId !== this.state.targetId ||
      frame.routingGeneration !== (currentScope?.routingGeneration ?? 0)
    ) {
      void this.stop("target-switched")
      return
    }
    const gap = this.sequenceGap(normalizedFrame)
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (gap) {
          await session.appendGap(gap)
          this.publish({ ...this.state, gapCount: this.state.gapCount + 1 })
        }
        await session.append(normalizedFrame)
      })
      .catch((error: unknown) => {
        this.publish({
          ...this.state,
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  private sequenceGap(frame: PerfFrame): PerfGap | null {
    const previous = this.lastSequence
    this.lastSequence = frame.sequence
    if (previous === null || frame.sequence <= previous + 1) return null
    return {
      reason: "sequence-gap",
      sourceId: frame.sourceId,
      samplingSessionId: frame.samplingSessionId,
      sequenceStart: previous + 1,
      sequenceEnd: frame.sequence - 1,
      wallStartMs: frame.wallStartMs,
      wallEndMs: frame.wallEndMs,
      recoverable: false,
      clockUncertaintyMs: frame.actualIntervalMs,
      detail: "capture stream skipped one or more source sequences",
    }
  }

  private teardownDemand(): void {
    this.unsubscribeFrames?.()
    this.unsubscribeFrames = null
    this.closeDemand?.()
    this.closeDemand = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.leaseId) void perfCloseLease(this.leaseId)
    this.leaseId = null
  }

  private completeSession(error: string | null = this.state.error): void {
    this.session = null
    this.endDemand(error)
    this.quota?.close()
    this.quota = null
    this.accountId = null
    this.expectedSourceId = null
    this.expectedHostInstanceId = null
    this.expectedCadenceMs = null
  }

  private endDemand(error: string | null = this.state.error): void {
    this.teardownDemand()
    if (this.state.active || this.state.error !== error) {
      this.publish({ ...this.state, active: false, error })
    }
  }

  private publish(state: PerformanceCaptureControllerState): void {
    this.state = state
    for (const listener of this.listeners) listener(this.snapshot)
  }
}

let controller: PerformanceCaptureController | null = null

export function getPerformanceCaptureController(): PerformanceCaptureController {
  controller ??= new PerformanceCaptureController()
  return controller
}
