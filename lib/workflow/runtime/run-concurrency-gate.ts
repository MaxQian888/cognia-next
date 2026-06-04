/**
 * Global in-flight concurrency gate — a plain FIFO semaphore shared between
 * the top-level orchestrator's loop-container iterations and every
 * subgraph-runner child step, so nested parallel loops cannot multiply into
 * a resource explosion (consensus decision: default 16, process-wide).
 *
 * This is deliberately SEPARATE from `concurrency-controller.ts`:
 *   • the controller caps in-flight nodes WITHIN one run (per-run setting);
 *   • the gate caps loop-iteration work across ALL runs in the process.
 */

export class ConcurrencyGate {
  readonly limit: number
  private inUse = 0
  private queue: Array<{
    resolve: (release: () => void) => void
    reject: (err: Error) => void
    signal?: AbortSignal
    onAbort?: () => void
  }> = []

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  /** Currently held slots. */
  get active(): number {
    return this.inUse
  }

  /** Waiters parked behind the limit. */
  get pending(): number {
    return this.queue.length
  }

  /**
   * Acquire a slot. Resolves with an idempotent `release` function. When
   * `signal` aborts while waiting, the acquire rejects and the slot is
   * never consumed.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("Gate acquire aborted"))
    }
    if (this.inUse < this.limit) {
      this.inUse += 1
      return Promise.resolve(this.makeRelease())
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: (typeof this.queue)[number] = { resolve, reject, signal }
      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(waiter)
          if (idx >= 0) this.queue.splice(idx, 1)
          reject(new Error("Gate acquire aborted"))
        }
        waiter.onAbort = onAbort
        signal.addEventListener("abort", onAbort, { once: true })
      }
      this.queue.push(waiter)
    })
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.inUse -= 1
      this.drain()
    }
  }

  private drain(): void {
    while (this.inUse < this.limit && this.queue.length > 0) {
      const next = this.queue.shift()!
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort)
      }
      this.inUse += 1
      next.resolve(this.makeRelease())
    }
  }
}

const DEFAULT_GLOBAL_LIMIT = 16

let globalGate: ConcurrencyGate | null = null

/** Process-wide gate (default limit 16). */
export function getGlobalRunGate(): ConcurrencyGate {
  if (!globalGate) globalGate = new ConcurrencyGate(DEFAULT_GLOBAL_LIMIT)
  return globalGate
}

/** Test seam — swap (or reset with `null`) the global gate. */
export function __setGlobalRunGateForTesting(gate: ConcurrencyGate | null): void {
  globalGate = gate
}
