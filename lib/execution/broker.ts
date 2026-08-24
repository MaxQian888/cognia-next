/**
 * Unified Execution Broker — admission + registration + cancellation.
 *
 * One global singleton governs every AI turn the app drives. Callers wrap the
 * thing that actually runs a turn with an admission lease:
 *
 * ```ts
 * const lease = await getExecutionBroker().acquire({
 *   kind: "connector",
 *   label: "WeCom auto-reply",
 *   sessionId,
 *   projectId,
 *   signal: callerSignal,
 * })
 * try {
 *   await runAndCaptureAssistantReply(sessionId, prompt, opts, { signal: lease.signal })
 *   lease.release("ok")
 * } catch (err) {
 *   lease.release("error")
 *   throw err
 * }
 * ```
 *
 * Three jobs:
 *  1. **Admission** — a weighted semaphore per {@link ExecutionResourceClass}
 *     (`ai-turn` today). A new leg waits until the pool has room, so the four
 *     subsystems that used to each cap independently now share one ceiling.
 *  2. **Registration** — every in-flight leg is observable via {@link list} /
 *     {@link subscribe}, so there is a single "what's running right now" view.
 *  3. **Cancellation** — by id, session, project, or globally; the lease's
 *     {@link ExecutionLease.signal} fires so the wrapped turn actually stops.
 *
 * Continuation exemption: a foreground chat turn that continues an
 * already-running session must never be blocked (replicates the
 * `selectIsAtStreamCap` / `use-claude-chat.ts` rule that an already-streaming
 * session is excluded from the cap). The broker detects this — when a lease
 * names a `sessionId` that already has an active leg, it is admitted
 * immediately and consumes no permit.
 */

import { createLogger } from "@cognia/logging"
import type {
  ExecutionBrokerEvent,
  ExecutionLease,
  ExecutionLeaseRequest,
  ExecutionLegOutcome,
  ExecutionLegSnapshot,
  ExecutionLegState,
  ExecutionResourceClass,
} from "./types"

const log = createLogger("execution")

/**
 * Default global `ai-turn` ceiling. Chosen to match the process-level workflow
 * gate (`lib/workflow/runtime/run-concurrency-gate.ts` defaults to 16) so
 * headless throughput does not regress, while still bounding the previously
 * unbounded headless legs that bypassed every cap. Configurable at runtime via
 * {@link ExecutionBroker.setLimit}.
 */
export const DEFAULT_AI_TURN_LIMIT = 16

/** AbortError surfaced when a queued lease is cancelled before it is admitted. */
export class ExecutionAbortError extends Error {
  constructor(message = "execution lease aborted") {
    super(message)
    this.name = "AbortError"
  }
}

interface ResourcePool {
  limit: number
  /** Sum of weights of currently-running, non-exempt leases. */
  inUse: number
  /** FIFO waiters that did not fit on acquire. */
  queue: ManagedLease[]
}

interface ManagedLease {
  id: string
  request: ExecutionLeaseRequest
  resource: ExecutionResourceClass
  weight: number
  exempt: boolean
  startedAt: number
  state: ExecutionLegState
  cancelled: boolean
  released: boolean
  controller: AbortController
  externalSignal?: AbortSignal
  externalAbortHandler?: () => void
  /** The execution slot this lease holds while running, if any. */
  heldSlot?: string
  /** Resolve/reject for a still-queued acquire. Cleared once admitted. */
  resolve?: (lease: ExecutionLease) => void
  reject?: (err: unknown) => void
  lease: ExecutionLease
}

export interface ExecutionBrokerOptions {
  /** Per-resource starting limits. Defaults to `{ "ai-turn": DEFAULT_AI_TURN_LIMIT }`. */
  limits?: Partial<Record<ExecutionResourceClass, number>>
  /** Injectable clock for deterministic tests. */
  now?: () => number
  /** Injectable id factory for deterministic tests. */
  idFactory?: () => string
}

type SnapshotListener = () => void
type EventListener = (event: ExecutionBrokerEvent) => void

const DEFAULT_RESOURCE: ExecutionResourceClass = "ai-turn"

export class ExecutionBroker {
  private readonly pools = new Map<ExecutionResourceClass, ResourcePool>()
  private readonly active = new Map<string, ManagedLease>()
  private readonly snapshotListeners = new Set<SnapshotListener>()
  private readonly eventListeners = new Set<EventListener>()
  private readonly now: () => number
  private readonly idFactory: () => string

  private cachedSnapshot: ExecutionLegSnapshot[] = []
  private snapshotDirty = true

  constructor(options: ExecutionBrokerOptions = {}) {
    this.now = options.now ?? Date.now
    this.idFactory = options.idFactory ?? (() => `leg_${crypto.randomUUID()}`)
    const limits = options.limits ?? { [DEFAULT_RESOURCE]: DEFAULT_AI_TURN_LIMIT }
    for (const [resource, limit] of Object.entries(limits)) {
      this.pools.set(resource as ExecutionResourceClass, {
        limit: Math.max(1, Math.floor(limit ?? DEFAULT_AI_TURN_LIMIT)),
        inUse: 0,
        queue: [],
      })
    }
    // Always guarantee the default pool exists.
    if (!this.pools.has(DEFAULT_RESOURCE)) {
      this.pools.set(DEFAULT_RESOURCE, { limit: DEFAULT_AI_TURN_LIMIT, inUse: 0, queue: [] })
    }
  }

  // ── Admission ───────────────────────────────────────────────────────────

  /**
   * Request admission for one execution leg. Resolves with a lease once a
   * permit is available (immediately for exempt / continuation legs). Rejects
   * with an {@link ExecutionAbortError} if the caller's `signal` is already
   * aborted, or if the lease is cancelled while still queued.
   */
  /**
   * Which lease currently holds each execution slot, and who is waiting.
   *
   * Separate from the resource pool because they answer different questions:
   * the pool caps HOW MUCH runs at once, the slot decides whether two legs may
   * touch the SAME working tree. A leg can be admitted by one and blocked by
   * the other, and the slot is claimed only at admission so a slot-holding leg
   * can never sit idle waiting for a permit.
   */
  private slotHolders = new Map<string, string>()
  private slotQueues = new Map<string, ManagedLease[]>()

  /** The lease holding `slotKey`, or null. */
  slotHolder(slotKey: string): string | null {
    return this.slotHolders.get(slotKey) ?? null
  }

  /** How many legs are waiting for `slotKey`. */
  slotQueueLength(slotKey: string): number {
    return this.slotQueues.get(slotKey)?.length ?? 0
  }

  acquire(request: ExecutionLeaseRequest): Promise<ExecutionLease> {
    const resource = request.resource ?? DEFAULT_RESOURCE
    const pool = this.poolFor(resource)
    const weight = normalizeWeight(request.weight)

    if (request.signal?.aborted) {
      return Promise.reject(new ExecutionAbortError("aborted before acquire"))
    }

    const id = this.idFactory()
    const controller = new AbortController()
    // Continuation exemption: an already-active session is never blocked.
    const exempt = Boolean(request.exempt) || this.hasActiveSession(request.sessionId, resource)

    const managed: ManagedLease = {
      id,
      request,
      resource,
      weight,
      exempt,
      startedAt: this.now(),
      state: "queued",
      cancelled: false,
      released: false,
      controller,
      lease: undefined as unknown as ExecutionLease,
    }
    managed.lease = this.makeLease(managed)

    // Chain the caller's signal: aborting it cancels the lease.
    if (request.signal) {
      const handler = () => this.cancel(id)
      managed.externalSignal = request.signal
      managed.externalAbortHandler = handler
      request.signal.addEventListener("abort", handler, { once: true })
    }

    this.active.set(id, managed)

    if (exempt) {
      this.admit(managed, pool, /* consumePermit */ false)
      return Promise.resolve(managed.lease)
    }

    // Slot before pool: a leg blocked on the tree it wants is not competing
    // for a permit, and letting it queue on the pool instead would let a
    // second leg into the same directory the moment a permit freed.
    const slotKey = request.slotKey
    if (slotKey && this.slotHolders.has(slotKey)) {
      this.markDirty()
      return new Promise<ExecutionLease>((resolve, reject) => {
        managed.resolve = resolve
        managed.reject = reject
        this.queueForSlot(slotKey, managed)
      })
    }

    if (pool.inUse + weight <= pool.limit) {
      this.admit(managed, pool, /* consumePermit */ true)
      return Promise.resolve(managed.lease)
    }

    // No room — register as queued (observable) and resolve when drained.
    this.markDirty()
    return new Promise<ExecutionLease>((resolve, reject) => {
      managed.resolve = resolve
      managed.reject = reject
      pool.queue.push(managed)
    })
  }

  private queueForSlot(slotKey: string, managed: ManagedLease): void {
    const queue = this.slotQueues.get(slotKey)
    if (queue) queue.push(managed)
    else this.slotQueues.set(slotKey, [managed])
  }

  /**
   * Hand `slotKey` to the next waiter, if any.
   *
   * The waiter re-enters the ordinary admission path, so it can still end up
   * on the pool queue — which is right: freeing a directory does not create a
   * permit.
   */
  private drainSlot(slotKey: string): void {
    const queue = this.slotQueues.get(slotKey)
    if (!queue) return
    while (queue.length > 0) {
      const head = queue.shift()!
      if (queue.length === 0) this.slotQueues.delete(slotKey)
      if (head.cancelled || head.released) continue
      const pool = this.poolFor(head.resource)
      if (pool.inUse + head.weight <= pool.limit) {
        this.admit(head, pool, /* consumePermit */ true)
      } else {
        pool.queue.push(head)
        this.markDirty()
      }
      return
    }
    this.slotQueues.delete(slotKey)
  }

  private admit(managed: ManagedLease, pool: ResourcePool, consumePermit: boolean): void {
    managed.state = "running"
    if (consumePermit) pool.inUse += managed.weight
    // Claimed here, not at acquire: a leg that is only pool-queued must not
    // hold a directory nobody is working in.
    const slotKey = managed.request.slotKey
    if (slotKey && !managed.exempt && !this.slotHolders.has(slotKey)) {
      this.slotHolders.set(slotKey, managed.id)
      managed.heldSlot = slotKey
    }
    const resolve = managed.resolve
    managed.resolve = undefined
    managed.reject = undefined
    this.markDirty()
    this.emit({ type: "leg-started", snapshot: this.snapshotOf(managed) })
    resolve?.(managed.lease)
  }

  private makeLease(managed: ManagedLease): ExecutionLease {
    return {
      id: managed.id,
      request: managed.request,
      resource: managed.resource,
      weight: managed.weight,
      exempt: managed.exempt,
      startedAt: managed.startedAt,
      get signal() {
        return managed.controller.signal
      },
      get cancelled() {
        return managed.cancelled
      },
      // Arrow captures the broker instance lexically (no `this` aliasing).
      release: (outcome?: ExecutionLegOutcome) => this.release(managed, outcome),
    }
  }

  private release(managed: ManagedLease, outcome?: ExecutionLegOutcome): void {
    if (managed.released) return
    managed.released = true

    if (managed.externalSignal && managed.externalAbortHandler) {
      try {
        managed.externalSignal.removeEventListener("abort", managed.externalAbortHandler)
      } catch {
        /* DOM-shim differences — swallow */
      }
    }

    const pool = this.poolFor(managed.resource)
    if (managed.state === "running" && !managed.exempt) {
      pool.inUse = Math.max(0, pool.inUse - managed.weight)
    } else if (managed.state === "queued") {
      // Defensive: a still-queued lease released directly — drop it from the
      // waiter list so the queue can't resurrect it.
      const idx = pool.queue.indexOf(managed)
      if (idx >= 0) pool.queue.splice(idx, 1)
      this.dropFromSlotQueue(managed)
    }

    const heldSlot = managed.heldSlot
    if (heldSlot && this.slotHolders.get(heldSlot) === managed.id) {
      this.slotHolders.delete(heldSlot)
      managed.heldSlot = undefined
    }

    this.active.delete(managed.id)
    const finalOutcome: ExecutionLegOutcome = managed.cancelled ? "cancelled" : (outcome ?? "ok")
    this.markDirty()
    this.emit({ type: "leg-completed", snapshot: this.snapshotOf(managed), outcome: finalOutcome })

    // A freed permit may let queued waiters in.
    if (managed.state === "running" && !managed.exempt) this.drain(pool)
    // A freed directory may let the next leg into it — after the pool drain,
    // so a waiter that has been queued longer keeps its place.
    if (heldSlot) this.drainSlot(heldSlot)
  }

  private dropFromSlotQueue(managed: ManagedLease): void {
    const slotKey = managed.request.slotKey
    if (!slotKey) return
    const queue = this.slotQueues.get(slotKey)
    if (!queue) return
    const idx = queue.indexOf(managed)
    if (idx >= 0) queue.splice(idx, 1)
    if (queue.length === 0) this.slotQueues.delete(slotKey)
  }

  private drain(pool: ResourcePool): void {
    // FIFO with head-of-line blocking: if the head doesn't fit, stop (keeps
    // admission order deterministic and starvation-free for equal weights).
    while (pool.queue.length > 0) {
      const head = pool.queue[0]
      if (head.cancelled) {
        pool.queue.shift()
        continue
      }
      if (pool.inUse + head.weight > pool.limit) break
      pool.queue.shift()
      this.admit(head, pool, /* consumePermit */ true)
    }
  }

  // ── Cancellation ────────────────────────────────────────────────────────

  /**
   * Cancel a single leg by id. Aborts its {@link ExecutionLease.signal} so the
   * wrapped turn stops; a still-queued leg is dropped and its acquire promise
   * rejects. Returns `true` when the leg transitioned to cancelled.
   */
  cancel(id: string): boolean {
    const managed = this.active.get(id)
    if (!managed || managed.released || managed.cancelled) return false
    managed.cancelled = true

    // Fire the abort so a running turn's `cap.signal` aborts.
    try {
      managed.controller.abort()
    } catch {
      /* already aborted — swallow */
    }

    if (managed.state === "queued") {
      // Never admitted — no release() will ever come, so finalize here. It may
      // have been waiting on a permit OR on a directory; drop it from both.
      const pool = this.poolFor(managed.resource)
      const idx = pool.queue.indexOf(managed)
      if (idx >= 0) pool.queue.splice(idx, 1)
      this.dropFromSlotQueue(managed)
      const reject = managed.reject
      managed.resolve = undefined
      managed.reject = undefined
      this.active.delete(id)
      this.markDirty()
      this.emit({ type: "leg-completed", snapshot: this.snapshotOf(managed), outcome: "cancelled" })
      reject?.(new ExecutionAbortError("lease cancelled while queued"))
      return true
    }

    // Running: the caller's turn will reject on the aborted signal and call
    // release(), which emits `leg-completed` with the cancelled outcome.
    this.markDirty()
    return true
  }

  /** Cancel every active leg for `sessionId`. Returns the number cancelled. */
  cancelBySession(sessionId: string): number {
    return this.cancelMatching((m) => m.request.sessionId === sessionId)
  }

  /** Cancel every active leg for `projectId`. Returns the number cancelled. */
  cancelByProject(projectId: string): number {
    return this.cancelMatching((m) => m.request.projectId === projectId)
  }

  /** Cancel every active leg. Returns the number cancelled. */
  cancelAll(): number {
    return this.cancelMatching(() => true)
  }

  private cancelMatching(predicate: (m: ManagedLease) => boolean): number {
    // Snapshot ids first — cancel() mutates the active map.
    const targets = [...this.active.values()].filter(
      (m) => !m.released && !m.cancelled && predicate(m)
    )
    let count = 0
    for (const m of targets) {
      if (this.cancel(m.id)) count += 1
    }
    return count
  }

  // ── Introspection ───────────────────────────────────────────────────────

  /** Whether `sessionId` has any active (queued or running) leg in `resource`. */
  hasActiveSession(
    sessionId: string | undefined,
    resource: ExecutionResourceClass = DEFAULT_RESOURCE
  ): boolean {
    if (!sessionId) return false
    for (const m of this.active.values()) {
      if (m.request.sessionId === sessionId && m.resource === resource && !m.released) return true
    }
    return false
  }

  /**
   * True when admitting a NEW (weight-1, non-exempt) leg on `resource` would
   * exceed the limit. A leg for an already-active `sessionId` is a continuation
   * and never at capacity. This is the broker-backed replacement for
   * `selectIsAtStreamCap`.
   */
  isAtCapacity(resource: ExecutionResourceClass = DEFAULT_RESOURCE, sessionId?: string): boolean {
    if (sessionId && this.hasActiveSession(sessionId, resource)) return false
    const pool = this.poolFor(resource)
    return pool.inUse + 1 > pool.limit
  }

  /** Number of running legs (including exempt continuations). */
  countRunning(resource?: ExecutionResourceClass): number {
    let count = 0
    for (const m of this.active.values()) {
      if (m.state !== "running") continue
      if (resource && m.resource !== resource) continue
      count += 1
    }
    return count
  }

  /** Sum of weights of running, non-exempt legs (permits currently held). */
  permitsInUse(resource: ExecutionResourceClass = DEFAULT_RESOURCE): number {
    return this.poolFor(resource).inUse
  }

  /** Permits available before the next non-exempt leg must queue. */
  availablePermits(resource: ExecutionResourceClass = DEFAULT_RESOURCE): number {
    const pool = this.poolFor(resource)
    return Math.max(0, pool.limit - pool.inUse)
  }

  /** Current limit for `resource`. */
  getLimit(resource: ExecutionResourceClass = DEFAULT_RESOURCE): number {
    return this.poolFor(resource).limit
  }

  /** Reconfigure a resource limit. Raising it immediately drains waiters. */
  setLimit(resource: ExecutionResourceClass, limit: number): void {
    const pool = this.poolFor(resource)
    pool.limit = Math.max(1, Math.floor(limit))
    log.debug("execution limit changed", { resource, limit: pool.limit })
    this.drain(pool)
    this.markDirty()
  }

  // ── Reactive snapshot ───────────────────────────────────────────────────

  /** Stable snapshot of every registered leg (queued + running). */
  list(): ExecutionLegSnapshot[] {
    if (this.snapshotDirty) {
      this.cachedSnapshot = [...this.active.values()]
        .map((m) => this.snapshotOf(m))
        .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
      this.snapshotDirty = false
    }
    return this.cachedSnapshot
  }

  /** `useSyncExternalStore` getSnapshot — alias for {@link list}. */
  getSnapshot = (): ExecutionLegSnapshot[] => this.list()

  /** `useSyncExternalStore` subscribe — fires on any registry change. */
  subscribe = (listener: SnapshotListener): (() => void) => {
    this.snapshotListeners.add(listener)
    return () => {
      this.snapshotListeners.delete(listener)
    }
  }

  /** Subscribe to leg lifecycle events (started / completed). */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  private snapshotOf(m: ManagedLease): ExecutionLegSnapshot {
    return {
      id: m.id,
      kind: m.request.kind,
      resource: m.resource,
      label: m.request.label,
      ...(m.request.sessionId ? { sessionId: m.request.sessionId } : {}),
      ...(m.request.runId ? { runId: m.request.runId } : {}),
      ...(m.request.taskId ? { taskId: m.request.taskId } : {}),
      ...(m.request.projectId ? { projectId: m.request.projectId } : {}),
      ...(m.request.slotKey ? { slotKey: m.request.slotKey } : {}),
      ...(m.heldSlot ? { holdsSlot: true } : {}),
      weight: m.weight,
      exempt: m.exempt,
      state: m.state,
      startedAt: m.startedAt,
      cancelled: m.cancelled,
    }
  }

  private markDirty(): void {
    this.snapshotDirty = true
    for (const listener of this.snapshotListeners) {
      try {
        listener()
      } catch {
        /* a faulty subscriber must never break admission */
      }
    }
  }

  private emit(event: ExecutionBrokerEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch {
        /* best-effort — lifecycle listeners must not break the broker */
      }
    }
  }

  private poolFor(resource: ExecutionResourceClass): ResourcePool {
    let pool = this.pools.get(resource)
    if (!pool) {
      pool = { limit: DEFAULT_AI_TURN_LIMIT, inUse: 0, queue: [] }
      this.pools.set(resource, pool)
    }
    return pool
  }
}

function normalizeWeight(weight: number | undefined): number {
  if (weight == null || !Number.isFinite(weight)) return 1
  return Math.max(1, Math.floor(weight))
}

// ── Singleton ───────────────────────────────────────────────────────────

let singleton: ExecutionBroker | null = null

/** The process-wide execution broker. Lazily created on first use. */
export function getExecutionBroker(): ExecutionBroker {
  if (!singleton) singleton = new ExecutionBroker()
  return singleton
}

/** Replace the singleton (tests only). Cancels any in-flight legs first. */
export function __resetExecutionBrokerForTesting(broker?: ExecutionBroker): void {
  if (singleton) {
    try {
      singleton.cancelAll()
    } catch {
      /* swallow — reset must always proceed */
    }
  }
  singleton = broker ?? null
}
