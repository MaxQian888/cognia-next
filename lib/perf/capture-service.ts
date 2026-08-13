import type { CogniaDB } from "@/lib/db/schema"
import type { PerfFrame, PerfGap, PerfSourceDescriptor } from "./backend/types"
import { encryptPerformanceArtifact } from "./capture-crypto"
import type {
  PerformanceCaptureAttachmentRow,
  PerformanceCaptureRow,
  PerformanceCaptureStopReason,
} from "./capture-types"
import { PerformanceQuotaExceededError, PerformanceQuotaManager } from "./quota"
import {
  assertPerformanceSecurityGeneration,
  getPerformanceSecurityGeneration,
  subscribePerformanceSecurityBarrier,
} from "./security-generation"
import { registerRuntimeTargetTransitionParticipant } from "@/lib/runtime/runtime-target-lifecycle"

export const PERFORMANCE_CAPTURE_DEFAULT_DURATION_MS = 10 * 60 * 1000
export const PERFORMANCE_CAPTURE_MAX_DURATION_MS = 60 * 60 * 1000
export const PERFORMANCE_CAPTURE_MAX_BYTES = 512 * 1024 * 1024
export const PERFORMANCE_ATTACHMENT_MAX_BYTES = 256 * 1024 * 1024
export const PERFORMANCE_CAPTURE_FLUSH_MS = 5000
export const PERFORMANCE_CAPTURE_FLUSH_FRAMES = 64
export const PERFORMANCE_CAPTURE_FLUSH_BYTES = 1024 * 1024
const PERFORMANCE_CAPTURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const PERFORMANCE_CAPTURE_RETENTION_COUNT = 20

export interface PerformanceCaptureSessionOptions {
  accountId: string
  targetDatabase: string
  targetId: string
  routingGeneration: number
  source: PerfSourceDescriptor
  requestedCadenceMs: number
  environmentSnapshot?: unknown
  budgetSnapshot?: unknown
  key: Uint8Array
  db: CogniaDB
  quota: PerformanceQuotaManager
  durationMs?: number
  now?: () => number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
  onDemandEnd?: () => void
  onStopped?: () => void
}

function digestHex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", bytes)
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    )
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export class PerformanceCaptureSession {
  readonly id = randomId("capture")
  readonly startedAt: number
  private readonly securityGeneration = getPerformanceSecurityGeneration()
  private readonly now: () => number
  private readonly schedule: typeof globalThis.setTimeout
  private readonly cancel: typeof globalThis.clearTimeout
  private readonly durationMs: number
  private tail: PerfFrame[] = []
  private tailBytes = 0
  private ordinal = 0
  private payloadBytes = 0
  private attachmentBytes = 0
  private frameCount = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private flushing: Promise<void> = Promise.resolve()
  private unsubscribeSecurity: (() => void) | null = null
  private stoppedNotified = false

  private constructor(private readonly options: PerformanceCaptureSessionOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.setTimeout ?? globalThis.setTimeout.bind(globalThis)
    this.cancel = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
    this.durationMs = Math.min(
      Math.max(1, options.durationMs ?? PERFORMANCE_CAPTURE_DEFAULT_DURATION_MS),
      PERFORMANCE_CAPTURE_MAX_DURATION_MS
    )
    this.startedAt = this.now()
  }

  static async start(
    options: PerformanceCaptureSessionOptions
  ): Promise<PerformanceCaptureSession> {
    const session = new PerformanceCaptureSession(options)
    const metadataContentType = "application/vnd.cognia.perf-metadata+json" as const
    const metadataPlain = new TextEncoder().encode(
      JSON.stringify({
        source: options.source,
        environment: options.environmentSnapshot ?? null,
        requestedCadenceMs: options.requestedCadenceMs,
        budget: options.budgetSnapshot ?? null,
      })
    )
    const metadataEnvelope = await encryptPerformanceArtifact(
      options.key,
      metadataPlain,
      {
        accountId: options.accountId,
        targetDatabase: options.targetDatabase,
        captureId: session.id,
        ordinal: -1,
        contentType: metadataContentType,
      },
      session.securityGeneration
    )
    const metadataByteCount =
      metadataEnvelope.iv.byteLength + metadataEnvelope.ciphertext.byteLength
    const environmentDigest = await digestHex(
      new TextEncoder().encode(JSON.stringify(options.environmentSnapshot ?? options.source.build))
    )
    const row: PerformanceCaptureRow = {
      id: session.id,
      status: "recording",
      purpose: "capture",
      sourceKind: options.source.kind,
      sourceId: options.source.sourceId,
      hostInstanceId: options.source.hostInstanceId,
      targetId: options.targetId,
      routingGeneration: options.routingGeneration,
      wireVersion: options.source.wireVersion,
      metricSchemaVersion: options.source.metricSchemaVersion,
      capabilityBits: [...options.source.capabilities].sort().join(","),
      startedAt: session.startedAt,
      updatedAt: session.startedAt,
      pinned: 0,
      payloadBytes: metadataByteCount,
      attachmentBytes: 0,
      frameCount: 0,
      gapCount: 0,
      environmentDigest,
      metadataContentType,
      metadataByteCount,
      metadataDigest: await digestHex(metadataPlain),
      metadataIv: ownedBuffer(metadataEnvelope.iv),
      metadataCiphertext: ownedBuffer(metadataEnvelope.ciphertext),
    }
    assertPerformanceSecurityGeneration(session.securityGeneration)
    const reservation = await options.quota.reserve({
      accountId: options.accountId,
      targetDatabase: options.targetDatabase,
      captureId: session.id,
      worstCaseBytes: metadataPlain.byteLength + 256,
    })
    try {
      await options.db.transaction("rw", options.db.performanceCaptures, async () => {
        assertPerformanceSecurityGeneration(session.securityGeneration)
        await options.db.performanceCaptures.add(row)
      })
      await options.quota.commit(reservation.id, metadataByteCount)
      session.payloadBytes = metadataByteCount
    } catch (error) {
      await options.quota.abandon(reservation.id)
      throw error
    }
    session.unsubscribeSecurity = subscribePerformanceSecurityBarrier((event) => {
      if (event.accountId !== options.accountId || session.stopped) return
      session.stopped = true
      session.tail = []
      session.tailBytes = 0
      session.clearTimer()
      options.onDemandEnd?.()
      void options.db.performanceCaptures
        .update(session.id, {
          status: "ready",
          stopReason: "account-locked",
          stoppedAt: event.at,
          updatedAt: event.at,
        })
        .finally(() => session.notifyStopped())
    })
    session.armTimer()
    return session
  }

  get isActive(): boolean {
    return !this.stopped
  }

  async append(frame: PerfFrame): Promise<void> {
    if (this.stopped) throw new Error("performance-capture-stopped")
    if (
      frame.targetId !== this.options.targetId ||
      frame.routingGeneration !== this.options.routingGeneration
    ) {
      await this.stop("target-switched")
      throw new Error("performance-capture-target-mismatch")
    }
    if (
      frame.sourceId !== this.options.source.sourceId ||
      frame.hostInstanceId !== this.options.source.hostInstanceId ||
      frame.requestedIntervalMs !== this.options.requestedCadenceMs
    ) {
      throw new Error("performance-capture-source-mismatch")
    }
    if (this.now() - this.startedAt >= this.durationMs) {
      await this.stop("duration-limit")
      return
    }
    const encoded = new TextEncoder().encode(JSON.stringify(frame))
    this.tail.push(frame)
    this.tailBytes += encoded.byteLength
    if (
      this.tail.length >= PERFORMANCE_CAPTURE_FLUSH_FRAMES ||
      this.tailBytes >= PERFORMANCE_CAPTURE_FLUSH_BYTES
    ) {
      await this.flush()
    }
  }

  async flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushTail())
    return this.flushing
  }

  async addAttachment(contentType: string, bytes: Uint8Array): Promise<void> {
    if (this.stopped) throw new Error("performance-capture-stopped")
    if (bytes.byteLength > PERFORMANCE_ATTACHMENT_MAX_BYTES) {
      throw new Error("performance-attachment-too-large")
    }
    const ordinal = this.ordinal++
    const aad = {
      accountId: this.options.accountId,
      targetDatabase: this.options.targetDatabase,
      captureId: this.id,
      ordinal,
      contentType,
    }
    const envelope = await encryptPerformanceArtifact(
      this.options.key,
      bytes,
      aad,
      this.securityGeneration
    )
    const actualBytes = envelope.iv.byteLength + envelope.ciphertext.byteLength
    await this.assertCaptureCapacity(actualBytes)
    const reservation = await this.options.quota.reserve({
      accountId: this.options.accountId,
      targetDatabase: this.options.targetDatabase,
      captureId: this.id,
      worstCaseBytes: bytes.byteLength + 256,
    })
    const row: PerformanceCaptureAttachmentRow = {
      id: `${this.id}:attachment:${ordinal}`,
      captureId: this.id,
      ordinal,
      byteCount: actualBytes,
      contentType,
      iv: ownedBuffer(envelope.iv),
      ciphertext: ownedBuffer(envelope.ciphertext),
      digest: await digestHex(bytes),
    }
    try {
      await this.options.db.transaction(
        "rw",
        this.options.db.performanceCaptures,
        this.options.db.performanceCaptureAttachments,
        async () => {
          assertPerformanceSecurityGeneration(this.securityGeneration)
          await this.options.db.performanceCaptureAttachments.add(row)
          this.attachmentBytes += actualBytes
          await this.options.db.performanceCaptures.update(this.id, {
            attachmentBytes: this.attachmentBytes,
            updatedAt: this.now(),
          })
        }
      )
      await this.options.quota.commit(reservation.id, actualBytes)
    } catch (error) {
      if (!(
        error instanceof Error && error.message === "performance-security-generation-changed"
      )) {
        await this.options.quota.abandon(reservation.id)
      }
      throw error
    }
  }

  async appendGap(gap: PerfGap): Promise<void> {
    if (this.stopped) return
    const ordinal = this.ordinal++
    await this.options.db.transaction(
      "rw",
      this.options.db.performanceCaptures,
      this.options.db.performanceCaptureGaps,
      async () => {
        assertPerformanceSecurityGeneration(this.securityGeneration)
        await this.options.db.performanceCaptureGaps.add({
          id: `${this.id}:gap:${ordinal}`,
          captureId: this.id,
          ordinal,
          reason: gap.reason,
          recoverable: gap.recoverable ? 1 : 0,
          sequenceStart: gap.sequenceStart ?? undefined,
          sequenceEnd: gap.sequenceEnd ?? undefined,
          wallStartMs: gap.wallStartMs,
          wallEndMs: gap.wallEndMs,
          clockUncertaintyMs: gap.clockUncertaintyMs ?? undefined,
        })
        await this.options.db.performanceCaptures.update(this.id, {
          gapCount: await this.options.db.performanceCaptureGaps
            .where("captureId")
            .equals(this.id)
            .count(),
          updatedAt: this.now(),
        })
      }
    )
  }

  async stop(reason: PerformanceCaptureStopReason = "manual"): Promise<void> {
    if (this.stopped) return this.flushing
    this.stopped = true
    this.clearTimer()
    this.unsubscribeSecurity?.()
    this.unsubscribeSecurity = null
    this.options.onDemandEnd?.()
    try {
      if (reason !== "account-locked") await this.flush()
      const now = this.now()
      await this.options.db.performanceCaptures.update(this.id, {
        status: "ready",
        stopReason: reason,
        stoppedAt: now,
        updatedAt: now,
        payloadBytes: this.payloadBytes,
        attachmentBytes: this.attachmentBytes,
        frameCount: this.frameCount,
      })
    } finally {
      this.notifyStopped()
    }
  }

  private async flushTail(): Promise<void> {
    if (this.tail.length === 0) return
    const frames = this.tail
    this.tail = []
    this.tailBytes = 0
    this.clearTimer()
    const ordinal = this.ordinal++
    const contentType = "application/vnd.cognia.perf-frames+json" as const
    const plainText = new TextEncoder().encode(JSON.stringify(frames))
    const envelope = await encryptPerformanceArtifact(
      this.options.key,
      plainText,
      {
        accountId: this.options.accountId,
        targetDatabase: this.options.targetDatabase,
        captureId: this.id,
        ordinal,
        contentType,
      },
      this.securityGeneration
    )
    const actualBytes = envelope.iv.byteLength + envelope.ciphertext.byteLength
    const digest = await digestHex(plainText)
    try {
      await this.assertCaptureCapacity(actualBytes)
      const reservation = await this.options.quota.reserve({
        accountId: this.options.accountId,
        targetDatabase: this.options.targetDatabase,
        captureId: this.id,
        worstCaseBytes: plainText.byteLength + 256,
      })
      try {
        await this.options.db.transaction(
          "rw",
          this.options.db.performanceCaptures,
          this.options.db.performanceCaptureChunks,
          async () => {
            assertPerformanceSecurityGeneration(this.securityGeneration)
            await this.options.db.performanceCaptureChunks.add({
              id: `${this.id}:chunk:${ordinal}`,
              captureId: this.id,
              ordinal,
              frameCount: frames.length,
              firstSequence: frames[0].sequence,
              lastSequence: frames.at(-1)!.sequence,
              byteCount: actualBytes,
              contentType,
              iv: ownedBuffer(envelope.iv),
              ciphertext: ownedBuffer(envelope.ciphertext),
              digest,
            })
            this.payloadBytes += actualBytes
            this.frameCount += frames.length
            await this.options.db.performanceCaptures.update(this.id, {
              payloadBytes: this.payloadBytes,
              frameCount: this.frameCount,
              updatedAt: this.now(),
            })
          }
        )
        await this.options.quota.commit(reservation.id, actualBytes)
      } catch (error) {
        if (!(
          error instanceof Error && error.message === "performance-security-generation-changed"
        )) {
          await this.options.quota.abandon(reservation.id)
        }
        throw error
      }
    } catch (error) {
      if (error instanceof PerformanceQuotaExceededError || error instanceof CaptureCapacityError) {
        await this.finalizeAfterWriteFailure("quota-exceeded")
        return
      }
      throw error
    } finally {
      if (!this.stopped) this.armTimer()
    }
  }

  private async assertCaptureCapacity(nextBytes: number): Promise<void> {
    if (this.payloadBytes + this.attachmentBytes + nextBytes > PERFORMANCE_CAPTURE_MAX_BYTES) {
      throw new CaptureCapacityError()
    }
  }

  private async finalizeAfterWriteFailure(reason: PerformanceCaptureStopReason): Promise<void> {
    this.stopped = true
    this.tail = []
    this.tailBytes = 0
    this.clearTimer()
    this.options.onDemandEnd?.()
    try {
      const now = this.now()
      await this.options.db.performanceCaptures.update(this.id, {
        status: "ready",
        stopReason: reason,
        stoppedAt: now,
        updatedAt: now,
      })
    } finally {
      this.notifyStopped()
    }
  }

  private notifyStopped(): void {
    if (this.stoppedNotified) return
    this.stoppedNotified = true
    this.options.onStopped?.()
  }

  private armTimer(): void {
    if (this.stopped || this.timer !== null) return
    const remaining = Math.max(0, this.startedAt + this.durationMs - this.now())
    this.timer = this.schedule(
      () => {
        this.timer = null
        if (this.now() - this.startedAt >= this.durationMs) void this.stop("duration-limit")
        else void this.flush()
      },
      Math.min(PERFORMANCE_CAPTURE_FLUSH_MS, remaining)
    )
  }

  private clearTimer(): void {
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
  }
}

class CaptureCapacityError extends Error {}

export async function deletePerformanceCapture(input: {
  db: CogniaDB
  quota: PerformanceQuotaManager
  accountId: string
  targetDatabase: string
  captureId: string
}): Promise<void> {
  await input.db.transaction(
    "rw",
    input.db.performanceCaptures,
    input.db.performanceCaptureChunks,
    input.db.performanceCaptureAttachments,
    input.db.performanceCaptureGaps,
    async () => {
      await input.db.performanceCaptureChunks.where("captureId").equals(input.captureId).delete()
      await input.db.performanceCaptureAttachments
        .where("captureId")
        .equals(input.captureId)
        .delete()
      await input.db.performanceCaptureGaps.where("captureId").equals(input.captureId).delete()
      await input.db.performanceCaptures.delete(input.captureId)
    }
  )
  await input.quota.releaseCapture(input.accountId, input.targetDatabase, input.captureId)
}

export async function prunePerformanceCaptures(input: {
  db: CogniaDB
  quota: PerformanceQuotaManager
  accountId: string
  targetDatabase: string
  now?: number
}): Promise<string[]> {
  const now = input.now ?? Date.now()
  const unpinned = await input.db.performanceCaptures.where("pinned").equals(0).sortBy("startedAt")
  const expired = unpinned.filter(
    (capture) => capture.startedAt < now - PERFORMANCE_CAPTURE_RETENTION_MS
  )
  const survivors = unpinned.filter((capture) => !expired.includes(capture))
  const overflow = survivors.slice(
    0,
    Math.max(0, survivors.length - PERFORMANCE_CAPTURE_RETENTION_COUNT)
  )
  const deleted = [
    ...new Map([...expired, ...overflow].map((capture) => [capture.id, capture])).values(),
  ]
  for (const capture of deleted) {
    await deletePerformanceCapture({ ...input, captureId: capture.id })
  }
  return deleted.map((capture) => capture.id)
}

export class ActivePerformanceCaptureCoordinator {
  private active: PerformanceCaptureSession | null = null

  constructor() {
    registerRuntimeTargetTransitionParticipant({
      id: "performance-capture",
      phase: "finalize-captures",
      priority: 0,
      run: async () => {
        await this.active?.stop("target-switched")
        this.active = null
      },
    })
  }

  get current(): PerformanceCaptureSession | null {
    return this.active
  }

  async start(options: PerformanceCaptureSessionOptions): Promise<PerformanceCaptureSession> {
    if (this.active?.isActive) throw new Error("performance-capture-already-active")
    this.active = await PerformanceCaptureSession.start(options)
    return this.active
  }

  async stop(reason: PerformanceCaptureStopReason = "manual"): Promise<void> {
    await this.active?.stop(reason)
    this.active = null
  }
}

let coordinator: ActivePerformanceCaptureCoordinator | null = null

export function getActivePerformanceCaptureCoordinator(): ActivePerformanceCaptureCoordinator {
  coordinator ??= new ActivePerformanceCaptureCoordinator()
  return coordinator
}
