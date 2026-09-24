/**
 * One host `live` performance lease per renderer document, shared by every
 * consumer that wants host frames.
 *
 * # Why this exists
 *
 * The host admits ONE live lease per device (`device-purpose-limit` in
 * `src-tauri/src/perf/sampler.rs` and `lib/perf/node-host.ts`), and a renderer
 * identifies itself with a single device id — its document id. Every
 * `usePerfStream()` used to open its own lease, so the moment the status-bar
 * perf segment and the `/performance` dashboard were mounted together the
 * second open was refused and the dashboard reported
 * `device-purpose-limit: device already owns a lease for this purpose` as its
 * "Latest error". React's double-invoked mount effect and a cadence change did
 * the same thing with ONE consumer: the next open was sent while the previous
 * lease's fire-and-forget close was still in flight.
 *
 * Here there is exactly one lease at a time, opened at the fastest cadence any
 * subscriber asked for, and every open/close is serialized, so a renderer can
 * no longer conflict with itself. Each subscriber still sees frames at its own
 * cadence (down-sampled on the same rule the host uses for its deliveries).
 *
 * # What is still a conflict
 *
 * A different client on the same device — two windows of one paired device —
 * genuinely contends for the lease. That is reported as a typed
 * {@link PerfHostIssue} of kind `contended`, the state stays `connecting`, and
 * the open is retried automatically: the holder may be a closed window whose
 * lease the host reclaims when its heartbeat TTL runs out.
 */

import {
  perfCloseLease,
  perfLeaseSnapshot,
  perfOpenLease,
  perfRenewLease,
  subscribePerfFrame,
} from "./backend/commands"
import type {
  PerfConnectionState,
  PerfFrame,
  PerfGap,
  PerfLeaseRejectionCode,
  PerfOpenLeaseRequest,
  PerfOpenLeaseResult,
  PerfSnapshot,
  PerfSourceDescriptor,
} from "./backend/types"
import { mergePerfFrames } from "./frame-merge"
import { getRendererPerformanceCollector } from "./renderer-collector"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

export const PERF_HOST_HISTORY_LIMIT = 120
export const PERF_LEASE_HEARTBEAT_MS = 5_000
/** Back-off before re-asking for a lease someone else holds. */
export const PERF_LEASE_CONTENDED_RETRY_MS = 5_000
/** The host's open rate limit is 100 ms; one retry past it is enough. */
export const PERF_LEASE_RATE_LIMIT_RETRY_MS = 250

/**
 * Why the host lease is not live. Typed so the UI can say what happened in the
 * reader's language instead of printing the host's `code: detail` string.
 */
export type PerfHostIssue =
  /** Someone else holds what we asked for. Retried automatically. */
  | { kind: "contended"; code: PerfLeaseRejectionCode; detail: string }
  /** The host refused for a reason retrying cannot fix. */
  | { kind: "rejected"; code: PerfLeaseRejectionCode; detail: string }
  /** The heartbeat failed on a lease we held. */
  | { kind: "renew-failed"; detail: string }
  /** The host could not be reached at all (no native host, IPC failure). */
  | { kind: "unreachable"; detail: string }

/** Rejections that describe another holder, not a fault in the request. */
const CONTENDED_CODES: ReadonlySet<PerfLeaseRejectionCode> = new Set([
  "device-purpose-limit",
  "host-lease-limit",
  "rate-limited",
  "target-mismatch",
  "routing-generation-mismatch",
])

export function isContendedPerfRejection(code: PerfLeaseRejectionCode): boolean {
  return CONTENDED_CODES.has(code)
}

/** What one subscriber sees. `frames` is already at that subscriber's cadence. */
export interface PerfHostLeaseView {
  state: PerfConnectionState
  issue: PerfHostIssue | null
  source: PerfSourceDescriptor | null
  frames: PerfFrame[]
  gaps: PerfGap[]
}

export interface PerfHostLeaseSubscription {
  /** Drop this subscriber's history — the dashboard's "reset baseline". */
  resetHistory(): void
  unsubscribe(): void
}

export interface PerfHostLiveLeaseDeps {
  open(input: PerfOpenLeaseRequest): Promise<PerfOpenLeaseResult>
  renew(leaseId: string): Promise<void>
  close(leaseId: string): Promise<void>
  snapshot(leaseId: string): Promise<PerfSnapshot>
  subscribeFrames(handler: (frame: PerfFrame) => void): () => void
  identity(): { clientId: string; deviceId: string; sourceId: string }
  scope(): { targetId: string; routingGeneration: number }
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(handler: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

interface Subscriber {
  cadenceMs: number
  frames: PerfFrame[]
  lastDeliveredWallMs: number
  /** Gaps ending at or before this are behind the subscriber's reset baseline. */
  gapFloorWallMs: number
  onChange: (view: PerfHostLeaseView) => void
}

interface HeldLease {
  leaseId: string
  cadenceMs: number
  targetId: string
  routingGeneration: number
}

function frameKey(frame: PerfFrame): string {
  return `${frame.hostInstanceId}:${frame.samplingSessionId}:${frame.sequence}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function appendBounded(frames: PerfFrame[], frame: PerfFrame): PerfFrame[] {
  const key = frameKey(frame)
  if (frames.some((existing) => frameKey(existing) === key)) return frames
  return [...frames, frame]
    .sort((left, right) => left.wallEndMs - right.wallEndMs)
    .slice(-PERF_HOST_HISTORY_LIMIT)
}

export class PerfHostLiveLease {
  private readonly subscribers = new Map<number, Subscriber>()
  private nextSubscriberId = 1
  private state: PerfConnectionState = "connecting"
  private issue: PerfHostIssue | null = null
  private source: PerfSourceDescriptor | null = null
  private held: HeldLease | null = null
  /** Scope frames are accepted for while a lease is being opened or held. */
  private scope: { targetId: string; routingGeneration: number } | null = null
  /** Frames that arrived before the lease id was known. */
  private buffered: PerfFrame[] = []
  /** Every frame of the held lease, at the lease's cadence. */
  private ring: PerfFrame[] = []
  private gaps: PerfGap[] = []
  private unsubscribeFrames: (() => void) | null = null
  private heartbeat: unknown = null
  private retryTimer: unknown = null
  private releaseTimer: unknown = null
  private reconnectRequested = false
  /** Bumped by every connect and teardown; a stale async result checks it. */
  private generation = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: PerfHostLiveLeaseDeps) {}

  subscribe(input: {
    cadenceMs: number
    onChange: (view: PerfHostLeaseView) => void
  }): PerfHostLeaseSubscription {
    const id = this.nextSubscriberId++
    const subscriber: Subscriber = {
      cadenceMs: input.cadenceMs,
      frames: [],
      lastDeliveredWallMs: 0,
      gapFloorWallMs: 0,
      onChange: input.onChange,
    }
    this.subscribers.set(id, subscriber)
    // A remount inside the release grace (React's double-invoked effect) keeps
    // the lease rather than closing and reopening it.
    this.cancelTimer("releaseTimer")
    // Synchronously, before any open is sent: a frame emitted between the open
    // and its reply must already have somewhere to land.
    this.ensureFrameSubscription()
    if (!this.scope) this.scope = this.deps.scope()
    // History only survives when the lease does. A subscriber that changes the
    // fastest cadence forces a reopen, and replaying the outgoing lease's
    // frames would draw a series at the wrong cadence until it lands.
    if (this.held && this.fastestCadence() !== this.held.cadenceMs) this.notify(subscriber)
    else this.replay(subscriber)
    this.requestReconcile()
    let active = true
    return {
      resetHistory: () => {
        if (!active) return
        subscriber.frames = []
        subscriber.lastDeliveredWallMs = 0
        subscriber.gapFloorWallMs = this.ring.at(-1)?.wallEndMs ?? 0
        this.notify(subscriber)
      },
      unsubscribe: () => {
        if (!active) return
        active = false
        this.subscribers.delete(id)
        if (this.subscribers.size === 0) {
          // Deferred one macrotask: StrictMode unmounts and remounts inside a
          // single commit, and the remount must find the lease still open.
          this.releaseTimer = this.deps.setTimeout(() => {
            this.releaseTimer = null
            this.requestReconcile()
          }, 0)
        } else {
          this.requestReconcile()
        }
      },
    }
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  private requestReconcile(): void {
    this.chain = this.chain
      .then(() => this.reconcile())
      .catch((error: unknown) => {
        // `reconcile` settles its own failures into state; reaching here means
        // a dependency threw synchronously. Say so rather than going quiet.
        this.setStatus("error", { kind: "unreachable", detail: messageOf(error) })
      })
  }

  private fastestCadence(): number | null {
    let fastest: number | null = null
    for (const subscriber of this.subscribers.values()) {
      if (fastest === null || subscriber.cadenceMs < fastest) fastest = subscriber.cadenceMs
    }
    return fastest
  }

  private async reconcile(): Promise<void> {
    const desired = this.fastestCadence()
    if (desired === null) {
      if (this.releaseTimer === null) await this.teardown()
      return
    }
    const scope = this.deps.scope()
    const current = this.held
    const upToDate =
      current !== null &&
      !this.reconnectRequested &&
      current.cadenceMs === desired &&
      current.targetId === scope.targetId &&
      current.routingGeneration === scope.routingGeneration
    if (upToDate) return
    // A retry is already scheduled for an open the host refused; a subscriber
    // joining in the meantime must not bypass the back-off.
    if (current === null && this.retryTimer !== null && !this.reconnectRequested) return
    this.reconnectRequested = false
    this.cancelTimer("retryTimer")
    if (current) await this.release(current)
    await this.connect(desired, scope)
  }

  private async connect(
    cadenceMs: number,
    scope: { targetId: string; routingGeneration: number }
  ): Promise<void> {
    const generation = ++this.generation
    if (
      !this.scope ||
      this.scope.targetId !== scope.targetId ||
      this.scope.routingGeneration !== scope.routingGeneration
    ) {
      this.buffered = []
    }
    this.scope = scope
    this.ring = []
    this.gaps = []
    for (const subscriber of this.subscribers.values()) {
      subscriber.frames = []
      subscriber.lastDeliveredWallMs = 0
      subscriber.gapFloorWallMs = 0
    }
    this.setStatus("connecting", this.issue?.kind === "contended" ? this.issue : null)

    const identity = this.deps.identity()
    let result: PerfOpenLeaseResult
    try {
      result = await this.deps.open({
        clientId: identity.clientId,
        deviceId: identity.deviceId,
        targetId: scope.targetId,
        routingGeneration: scope.routingGeneration,
        purpose: "live",
        requestedCadenceMs: cadenceMs,
        sourceId: identity.sourceId,
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.setStatus("unsupported", { kind: "unreachable", detail: messageOf(error) })
      return
    }
    if (generation !== this.generation) {
      // Torn down or superseded while the open was in flight: the lease the
      // host just granted has no owner left, so hand it straight back.
      if (result.accepted) await this.deps.close(result.lease.leaseId).catch(() => undefined)
      return
    }
    if (!result.accepted) {
      if (isContendedPerfRejection(result.code)) {
        this.setStatus("connecting", {
          kind: "contended",
          code: result.code,
          detail: result.detail,
        })
        this.scheduleRetry(
          result.code === "rate-limited"
            ? PERF_LEASE_RATE_LIMIT_RETRY_MS
            : PERF_LEASE_CONTENDED_RETRY_MS
        )
      } else {
        this.setStatus(result.code === "unsupported" ? "unsupported" : "error", {
          kind: "rejected",
          code: result.code,
          detail: result.detail,
        })
      }
      return
    }

    const held: HeldLease = {
      leaseId: result.lease.leaseId,
      cadenceMs,
      targetId: scope.targetId,
      routingGeneration: scope.routingGeneration,
    }
    this.held = held
    this.source = result.source
    let snapshot: PerfSnapshot
    try {
      snapshot = await this.deps.snapshot(held.leaseId)
    } catch (error) {
      if (generation !== this.generation) return
      // A lease with no readable history is not a live stream. Return it
      // rather than leaving the host sampling for a panel showing an error.
      this.held = null
      await this.deps.close(held.leaseId).catch(() => undefined)
      this.setStatus("error", { kind: "unreachable", detail: messageOf(error) })
      return
    }
    if (generation !== this.generation) return
    const merged = mergePerfFrames(
      snapshot,
      this.buffered.filter((frame) => !frame.leaseId || frame.leaseId === held.leaseId),
      scope
    )
    this.buffered = []
    this.ring = merged.frames.slice(-PERF_HOST_HISTORY_LIMIT)
    this.gaps = merged.gaps
    this.state = "live"
    this.issue = null
    this.startHeartbeat(generation, held)
    for (const subscriber of this.subscribers.values()) this.replay(subscriber)
  }

  /** Close a lease this manager holds. Awaited so the next open cannot race it. */
  private async release(held: HeldLease): Promise<void> {
    this.cancelTimer("heartbeat", true)
    if (this.held === held) this.held = null
    await this.deps.close(held.leaseId).catch(() => undefined)
  }

  private async teardown(): Promise<void> {
    this.generation += 1
    this.cancelTimer("retryTimer")
    const held = this.held
    if (held) await this.release(held)
    if (this.subscribers.size > 0) return
    this.unsubscribeFrames?.()
    this.unsubscribeFrames = null
    this.scope = null
    this.buffered = []
    this.ring = []
    this.gaps = []
    this.source = null
    this.state = "connecting"
    this.issue = null
  }

  private scheduleRetry(delayMs: number): void {
    this.cancelTimer("retryTimer")
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = null
      this.reconnectRequested = true
      this.requestReconcile()
    }, delayMs)
  }

  private startHeartbeat(generation: number, held: HeldLease): void {
    this.cancelTimer("heartbeat", true)
    this.heartbeat = this.deps.setInterval(() => {
      if (generation !== this.generation || this.held !== held) return
      void this.deps.renew(held.leaseId).catch((error: unknown) => {
        if (generation !== this.generation || this.held !== held) return
        const detail = messageOf(error)
        if (/lease-expired/.test(detail)) {
          // The host already dropped it (a suspended laptop outlived the TTL).
          // Nothing is holding the lease any more, so take a fresh one.
          this.held = null
          this.cancelTimer("heartbeat", true)
          this.setStatus("connecting", { kind: "renew-failed", detail })
          this.reconnectRequested = true
          this.requestReconcile()
          return
        }
        this.setStatus("stale", { kind: "renew-failed", detail })
      })
    }, PERF_LEASE_HEARTBEAT_MS)
  }

  private cancelTimer(name: "heartbeat" | "retryTimer" | "releaseTimer", interval = false): void {
    const handle = this[name]
    if (handle === null) return
    if (interval) this.deps.clearInterval(handle)
    else this.deps.clearTimeout(handle)
    this[name] = null
  }

  // ── Frames ─────────────────────────────────────────────────────────────────

  private ensureFrameSubscription(): void {
    if (this.unsubscribeFrames) return
    this.unsubscribeFrames = this.deps.subscribeFrames((frame) => this.onFrame(frame))
  }

  private onFrame(frame: PerfFrame): void {
    const scope = this.scope
    if (
      !scope ||
      frame.targetId !== scope.targetId ||
      frame.routingGeneration !== scope.routingGeneration
    ) {
      return
    }
    const held = this.held
    if (!held || this.state !== "live") {
      this.buffered = appendBounded(this.buffered, frame)
      return
    }
    // Another lease's delivery (a capture, another window) rides the same
    // event channel; only ours, or an untargeted legacy frame, is kept.
    if (frame.leaseId && frame.leaseId !== held.leaseId) return
    const nextRing = appendBounded(this.ring, frame)
    if (nextRing === this.ring) return
    this.ring = nextRing
    for (const subscriber of this.subscribers.values()) {
      if (this.deliver(subscriber, frame, held.cadenceMs)) this.notify(subscriber)
    }
  }

  /**
   * The host's own delivery rule (`SamplerHandle::deliveries`), with half a
   * lease period of tolerance so a jittery 1 s tick still counts toward a 2 s
   * subscriber instead of skipping every other window.
   */
  private deliver(subscriber: Subscriber, frame: PerfFrame, leaseCadenceMs: number): boolean {
    const due =
      subscriber.lastDeliveredWallMs === 0 ||
      frame.wallEndMs - subscriber.lastDeliveredWallMs >= subscriber.cadenceMs - leaseCadenceMs / 2
    if (!due) return false
    const next = appendBounded(subscriber.frames, frame)
    if (next === subscriber.frames) return false
    subscriber.frames = next
    subscriber.lastDeliveredWallMs = frame.wallEndMs
    return true
  }

  private replay(subscriber: Subscriber): void {
    subscriber.frames = []
    subscriber.lastDeliveredWallMs = 0
    const leaseCadence = this.held?.cadenceMs ?? subscriber.cadenceMs
    for (const frame of this.ring) this.deliver(subscriber, frame, leaseCadence)
    this.notify(subscriber)
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  private setStatus(state: PerfConnectionState, issue: PerfHostIssue | null): void {
    this.state = state
    this.issue = issue
    for (const subscriber of this.subscribers.values()) this.notify(subscriber)
  }

  private notify(subscriber: Subscriber): void {
    subscriber.onChange({
      state: this.state,
      issue: this.issue,
      source: this.source,
      frames: subscriber.frames,
      gaps:
        subscriber.gapFloorWallMs === 0
          ? this.gaps
          : this.gaps.filter((gap) => gap.wallEndMs > subscriber.gapFloorWallMs),
    })
  }
}

function defaultDeps(): PerfHostLiveLeaseDeps {
  return {
    open: perfOpenLease,
    renew: perfRenewLease,
    close: perfCloseLease,
    snapshot: perfLeaseSnapshot,
    subscribeFrames: subscribePerfFrame,
    identity: () => {
      const { source } = getRendererPerformanceCollector()
      return {
        clientId: source.sourceId,
        deviceId: source.hostInstanceId,
        sourceId: source.sourceId,
      }
    },
    scope: () => {
      const context = getActiveRuntimeTargetContext()
      return {
        targetId: context?.targetId ?? "web-standalone",
        routingGeneration: context?.routingGeneration ?? 0,
      }
    },
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  }
}

let shared: PerfHostLiveLease | null = null

/** The renderer's one host live lease. */
export function getPerfHostLiveLease(): PerfHostLiveLease {
  shared ??= new PerfHostLiveLease(defaultDeps())
  return shared
}

/** Drop the shared instance (tests only). */
export function __resetPerfHostLiveLeaseForTesting(): void {
  shared = null
}
