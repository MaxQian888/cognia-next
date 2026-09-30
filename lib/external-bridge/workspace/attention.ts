/**
 * Passive job attention for External Bridge clients (roadmap 2026-09-29,
 * Phase 1 "passive attention sidecar").
 *
 * An agent that starts `shell_run` work and moves on should learn that the job
 * finished without polling for it. The change feed already exists — the job
 * supervisor emits `jobs://exited` for every job it settles — so this module
 * only adds what WebCodex's `job_attention` adds on top of one:
 *
 *  - **routing**: an exit is queued for the client whose owner session
 *    (`external-bridge:jobs:<client>`, minted by `background_job_spawn_bridge`)
 *    started the job, and for no one else;
 *  - **piggyback delivery**: the queue drains into the `attention` field of
 *    that client's next workspace-family tool result, so no new channel is
 *    opened;
 *  - **cursor dedup**: every exit is delivered at most once, and an exit the
 *    client already saw — `job_output` returned the terminal status — is
 *    dropped instead of repeated;
 *  - **byte cap**: one result carries at most {@link ATTENTION_BYTE_CAP} bytes
 *    of attention; the rest stays queued and `more` says how many wait.
 */

import { onTauriEvent, TAURI_EVENTS } from "@/lib/tauri/events"

/** Owner-session prefix of bridge jobs — mirrors `BRIDGE_JOB_SESSION_PREFIX` in Rust. */
export const BRIDGE_JOB_SESSION_PREFIX = "external-bridge:jobs:"

export const ATTENTION_BYTE_CAP = 1024
/** Oldest exits are dropped (and counted) past this many queued per client. */
export const ATTENTION_QUEUE_CAP = 32
/** Bound on remembered labels / observed ids, so a long session cannot grow them forever. */
export const ATTENTION_MEMORY_CAP = 512

/** Insert into an insertion-ordered set/map, evicting the oldest past the cap. */
function evictOldest(collection: Set<string> | Map<string, string>): void {
  while (collection.size > ATTENTION_MEMORY_CAP) {
    const oldest = collection.keys().next().value
    if (oldest === undefined) return
    collection.delete(oldest)
  }
}

export interface JobExitEvent {
  jobId: string
  status: string
  exitCode?: number | null
  owner?: { kind?: string; sessionId?: string }
  endedAtMs?: number
}

export interface AttentionItem {
  jobId: string
  status: string
  exitCode?: number
  /** The command head the job was started with, when this app session saw it. */
  label?: string
}

export interface AttentionDelivery {
  jobs: AttentionItem[]
  /** Exits still queued after this delivery (byte cap). */
  more?: number
  /** Exits dropped unseen because the queue overflowed. */
  dropped?: number
}

interface ClientQueue {
  items: Array<AttentionItem & { seq: number }>
  dropped: number
}

type Subscribe = (handler: (event: JobExitEvent) => void) => Promise<() => void>

const defaultSubscribe: Subscribe = (handler) =>
  onTauriEvent<JobExitEvent>(TAURI_EVENTS.backgroundJobExited, handler)

export class JobAttention {
  private readonly queues = new Map<string, ClientQueue>()
  private readonly labels = new Map<string, string>()
  private readonly observed = new Set<string>()
  private seq = 0
  private subscription: Promise<unknown> | null = null

  constructor(private readonly subscribe: Subscribe = defaultSubscribe) {}

  /** Subscribe to the exit feed once. Idempotent; call before the first spawn. */
  ensureSubscribed(): Promise<unknown> {
    if (!this.subscription) {
      this.subscription = this.subscribe((event) => this.record(event)).catch((error) => {
        // Retry on the next spawn rather than latching a dead subscription.
        this.subscription = null
        throw error
      })
    }
    return this.subscription
  }

  /** Remember a spawned job's label so its exit can name it. */
  noteSpawned(jobId: string, label: string): void {
    this.labels.set(jobId, label)
    evictOldest(this.labels)
  }

  /** The client saw this job's terminal status itself: never repeat it. */
  markObserved(caller: string, jobId: string): void {
    this.observed.add(jobId)
    evictOldest(this.observed)
    const queue = this.queues.get(caller)
    if (queue) queue.items = queue.items.filter((item) => item.jobId !== jobId)
  }

  record(event: JobExitEvent): void {
    const sessionId = event.owner?.kind === "session" ? event.owner.sessionId : undefined
    if (!sessionId?.startsWith(BRIDGE_JOB_SESSION_PREFIX) || !event.jobId) return
    if (this.observed.has(event.jobId)) {
      // Each job exits once: the id is no longer needed after this.
      this.observed.delete(event.jobId)
      this.labels.delete(event.jobId)
      return
    }
    const caller = sessionId.slice(BRIDGE_JOB_SESSION_PREFIX.length)
    const queue = this.queues.get(caller) ?? { items: [], dropped: 0 }
    this.seq += 1
    const label = this.labels.get(event.jobId)
    this.labels.delete(event.jobId)
    queue.items.push({
      seq: this.seq,
      jobId: event.jobId,
      status: event.status,
      ...(typeof event.exitCode === "number" ? { exitCode: event.exitCode } : {}),
      ...(label ? { label } : {}),
    })
    while (queue.items.length > ATTENTION_QUEUE_CAP) {
      queue.items.shift()
      queue.dropped += 1
    }
    this.queues.set(caller, queue)
  }

  /**
   * Take what fits in the byte cap for `caller`, oldest first. Returns
   * `undefined` when there is nothing to say (sparse results stay sparse).
   */
  drain(caller: string, byteCap = ATTENTION_BYTE_CAP): AttentionDelivery | undefined {
    const queue = this.queues.get(caller)
    if (!queue || (queue.items.length === 0 && queue.dropped === 0)) return undefined
    const jobs: AttentionItem[] = []
    let bytes = 0
    while (queue.items.length > 0) {
      const { seq: _seq, ...item } = queue.items[0]!
      const size = JSON.stringify(item).length
      // Always deliver at least one item, even an oversized one, so a single
      // long label cannot wedge the queue forever.
      if (jobs.length > 0 && bytes + size > byteCap) break
      queue.items.shift()
      jobs.push(item)
      bytes += size
    }
    const delivery: AttentionDelivery = {
      jobs,
      ...(queue.items.length > 0 ? { more: queue.items.length } : {}),
      ...(queue.dropped > 0 ? { dropped: queue.dropped } : {}),
    }
    queue.dropped = 0
    if (queue.items.length === 0) this.queues.delete(caller)
    return delivery
  }
}

let shared: JobAttention | null = null

/** The process-wide attention queue the workspace tools share. */
export function jobAttention(): JobAttention {
  shared ??= new JobAttention()
  return shared
}

/** Test seam. */
export function __resetJobAttentionForTests(next: JobAttention | null = null): void {
  shared = next
}
