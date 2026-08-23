import { BackpressureError } from "./errors"
import type { AgentEventEnvelope } from "./types"

/** Default per-subscriber queue capacity, in events. */
export const DEFAULT_SUBSCRIBER_CAPACITY = 1024

export interface EventSubscriptionOptions {
  /**
   * Replay persisted history after this event before switching to live
   * delivery. Omit to replay the whole session.
   */
  afterEventId?: string
  /**
   * Skip replay entirely and deliver only events that arrive from the moment
   * `subscribe()` returns. Used by `session.start()`, which subscribes before
   * it writes `turn/run` and therefore cannot miss an event of that run.
   */
  replay?: boolean
  signal?: AbortSignal
  /** Bounded queue capacity for this subscriber alone. */
  capacity?: number
}

export interface ReplayPage {
  entries: readonly { envelope: AgentEventEnvelope }[]
  nextEventId?: string
  headEventId?: string
}

/** How the hub pages persisted history. Supplied by the client. */
export type ReplayReader = (request: {
  afterEventId?: string
  limit: number
}) => Promise<ReplayPage>

/** Page size for replay requests. Independent of subscriber capacity. */
const REPLAY_PAGE_SIZE = 512

type Waiter = (result: IteratorResult<AgentEventEnvelope>) => void

/**
 * One subscriber's view of a session's event stream.
 *
 * Each subscriber owns its own bounded queue and its own dedup window, so a
 * consumer that stops reading closes *itself* with a `BackpressureError` and
 * never stalls the session, starves a sibling subscriber, or grows the client
 * heap without bound.
 */
class Subscriber {
  private readonly queue: AgentEventEnvelope[] = []
  private readonly pendingLive: AgentEventEnvelope[] = []
  private readonly waiters: Waiter[] = []
  /** Insertion-ordered, evicted at `capacity` — a bounded LRU of event ids. */
  private readonly seen = new Set<string>()
  private phase: "replay" | "live" = "replay"
  /**
   * Built at throw time, not at detection time. The iterator drains whatever is
   * still queued before it raises, so the resume cursor is only correct once
   * the caller has actually stopped receiving events — capturing it earlier
   * would tell the caller to replay from a point it had already passed.
   */
  private failure: (() => Error) | undefined
  private droppedCount = 0
  private lastEventId: string | undefined
  private closed = false

  constructor(
    readonly capacity: number,
    private readonly onClose: (subscriber: Subscriber) => void
  ) {}

  /** Called by the hub for every live `agent/event` notification. */
  offer(envelope: AgentEventEnvelope): void {
    if (this.closed) return
    if (this.phase === "replay") {
      if (this.pendingLive.length >= this.capacity) {
        this.droppedCount += 1
        this.fail(() => this.backpressure())
        return
      }
      this.pendingLive.push(envelope)
      return
    }
    this.enqueue(envelope)
  }

  /** Called by the replay pump for every historical envelope, in order. */
  pushReplayed(envelope: AgentEventEnvelope): void {
    this.enqueue(envelope)
  }

  /**
   * Replay reached the head cursor. Flush everything that arrived live while we
   * were paging — deduplicated against what replay already delivered — and then
   * switch to direct delivery.
   */
  goLive(): void {
    if (this.closed || this.phase === "live") return
    this.phase = "live"
    const buffered = this.pendingLive.splice(0)
    for (const envelope of buffered) {
      if (this.closed) return
      this.enqueue(envelope)
    }
  }

  fail(error: Error | (() => Error)): void {
    if (this.closed) return
    this.failure = typeof error === "function" ? error : () => error
    this.close()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.pendingLive.length = 0
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
    this.onClose(this)
  }

  iterate(signal?: AbortSignal): AsyncIterable<AgentEventEnvelope> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<AgentEventEnvelope> => {
        let detached = false
        const onAbort = () => {
          detached = true
          this.close()
        }
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        }
        const detach = () => {
          if (!detached) signal?.removeEventListener("abort", onAbort)
        }
        const raise = (build: () => Error): never => {
          this.failure = undefined
          detach()
          throw build()
        }
        return {
          next: async (): Promise<IteratorResult<AgentEventEnvelope>> => {
            const buffered = this.queue.shift()
            if (buffered) {
              this.lastEventId = buffered.eventId
              return { done: false, value: buffered }
            }
            const queuedFailure = this.failure
            if (queuedFailure) raise(queuedFailure)
            if (this.closed) {
              detach()
              return { done: true, value: undefined }
            }
            const result = await new Promise<IteratorResult<AgentEventEnvelope>>((resolve) => {
              this.waiters.push(resolve)
            })
            if (!result.done) {
              this.lastEventId = result.value.eventId
              return result
            }
            const wakeFailure = this.failure
            if (wakeFailure) raise(wakeFailure)
            detach()
            return result
          },
          return: async (): Promise<IteratorResult<AgentEventEnvelope>> => {
            detach()
            this.close()
            return { done: true, value: undefined }
          },
        }
      },
    }
  }

  private enqueue(envelope: AgentEventEnvelope): void {
    if (this.closed) return
    if (this.seen.has(envelope.eventId)) return
    this.seen.add(envelope.eventId)
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next()
      if (!oldest.done) this.seen.delete(oldest.value)
    }
    const waiter = this.waiters.shift()
    if (waiter) {
      this.lastEventId = envelope.eventId
      waiter({ done: false, value: envelope })
      return
    }
    if (this.queue.length >= this.capacity) {
      this.droppedCount += 1
      this.fail(() => this.backpressure())
      return
    }
    this.queue.push(envelope)
  }

  private backpressure(): BackpressureError {
    return new BackpressureError({
      ...(this.lastEventId !== undefined ? { lastEventId: this.lastEventId } : {}),
      capacity: this.capacity,
      droppedCount: this.droppedCount,
    })
  }
}

/**
 * Fan-out for one session's event stream.
 *
 * `publish` is called by the client's `agent/event` notification handler.
 * `subscribe` hands each caller an independent iterable: history is paged up to
 * the host's head cursor while live notifications buffer, the two are merged by
 * event id, and only then does the subscriber switch to live delivery. Nothing
 * interleaves and nothing is lost in the handover.
 */
export class SessionEventHub {
  private readonly subscribers = new Set<Subscriber>()
  private closed = false

  constructor(private readonly readReplay: ReplayReader) {}

  get subscriberCount(): number {
    return this.subscribers.size
  }

  publish(envelope: AgentEventEnvelope): void {
    if (this.closed) return
    for (const subscriber of [...this.subscribers]) subscriber.offer(envelope)
  }

  subscribe(options: EventSubscriptionOptions = {}): AsyncIterable<AgentEventEnvelope> {
    const capacity = Math.max(1, options.capacity ?? DEFAULT_SUBSCRIBER_CAPACITY)
    const subscriber = new Subscriber(capacity, (entry) => this.subscribers.delete(entry))
    if (this.closed) {
      subscriber.close()
      return subscriber.iterate(options.signal)
    }
    // Registered before any await, so live events buffer from this instant.
    this.subscribers.add(subscriber)

    if (options.replay === false) {
      subscriber.goLive()
    } else {
      void this.pumpReplay(subscriber, options.afterEventId)
    }
    return subscriber.iterate(options.signal)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const subscriber of [...this.subscribers]) subscriber.close()
    this.subscribers.clear()
  }

  /**
   * Page history until the head cursor captured on the first request is
   * delivered, then hand over to live delivery.
   *
   * The head is read once, from the first page. Events published after it are
   * already buffered on the subscriber, so paging past it would only re-read
   * rows the buffer already holds.
   */
  private async pumpReplay(subscriber: Subscriber, afterEventId?: string): Promise<void> {
    try {
      let cursor = afterEventId
      let head: string | undefined
      let headSeen = false
      let firstPage = true

      for (;;) {
        const page = await this.readReplay({
          ...(cursor !== undefined ? { afterEventId: cursor } : {}),
          limit: REPLAY_PAGE_SIZE,
        })
        if (firstPage) {
          head = page.headEventId
          firstPage = false
          // Nothing persisted, or the caller's cursor is already the head.
          if (head === undefined || head === afterEventId) break
        }
        if (page.entries.length === 0) break
        for (const entry of page.entries) {
          subscriber.pushReplayed(entry.envelope)
          if (entry.envelope.eventId === head) headSeen = true
        }
        if (headSeen) break
        const next = page.nextEventId ?? page.entries.at(-1)?.envelope.eventId
        if (next === undefined || next === cursor) break
        cursor = next
      }
      subscriber.goLive()
    } catch (error) {
      subscriber.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
