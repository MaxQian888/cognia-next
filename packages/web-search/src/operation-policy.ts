/**
 * One shared definition of the bounds every external web operation runs under.
 *
 * Search (`search-service`), the configured Reader (`lib/web/reader/
 * configured-reader`), the fetch cache and the host tools all read these
 * values from here so a budget can never be tightened in one owner and left
 * loose in another. They are policy values, not latency promises: an
 * operation that exhausts them settles with a typed reason instead of running
 * on.
 *
 * Also owns the small runtime pieces those budgets need — a deadline-bound
 * abort signal and a per-scope admission gate — so neither caller grows its
 * own copy.
 */

/** Total wall-clock budget for one logical search, retries and fallback included. */
export const SEARCH_TOTAL_BUDGET_MS = 30_000
/** Total wall-clock budget for one logical read, every reader attempt included. */
export const READ_TOTAL_BUDGET_MS = 60_000
/** Ceiling for a single reader attempt (one direct fetch, one vendor reader call). */
export const READ_ATTEMPT_BUDGET_MS = 20_000
/** Adapter attempts per logical operation, counting retries AND fallback. */
export const MAX_OPERATION_ATTEMPTS = 3

/** Decoded response bytes a transport may buffer before parsing. */
export const RESPONSE_BYTE_CEILING = 8 * 1024 * 1024

/** Result caps (characters). `maxBytes` / offsets on `web_fetch` are character counts. */
export const RAW_RESULT_MAX_CHARS = 64 * 1024
export const EXTRACTED_RESULT_MAX_CHARS = 40 * 1024
export const EXTRACTOR_INPUT_MAX_CHARS = 32 * 1024
export const EXTRACTOR_OUTPUT_MAX_TOKENS = 1024

/** Search tool output bounds. */
export const SEARCH_SNIPPET_MAX_CHARS = 300
export const SEARCH_EXCERPT_MAX_CHARS = 2_000
export const SEARCH_IMAGES_MAX = 10

/** In-memory Reader cache bounds (characters, not bytes). */
export const READ_CACHE_TTL_MS = 5 * 60 * 1000
export const READ_CACHE_MAX_ENTRIES = 100
export const READ_CACHE_ENTRY_MAX_CHARS = 256 * 1024
export const READ_CACHE_TOTAL_MAX_CHARS = 4 * 1024 * 1024

/** Per-scope concurrency: running operations per kind, plus queued waiters. */
export const OPERATION_CONCURRENCY = { search: 2, read: 2 } as const
export const OPERATION_PENDING_MAX = 8

export type WebOperationKind = "search" | "read"

/** Thrown when an operation's own deadline (not the caller) ended it. */
export class OperationTimeoutError extends Error {
  constructor(message = "Operation exceeded its time budget") {
    super(message)
    this.name = "TimeoutError"
  }
}

/** Thrown when admission is full; callers map it to a retryable rate-limit result. */
export class OperationAdmissionError extends Error {
  constructor(message = "Too many web operations are queued; try again shortly") {
    super(message)
    this.name = "OperationAdmissionError"
  }
}

export interface OperationDeadline {
  /** Aborts on the caller's signal OR when the budget elapses. */
  signal: AbortSignal
  /** Milliseconds left, floored at 0. */
  remaining(): number
  /** True once the budget (not the caller) ended the operation. */
  timedOut(): boolean
  /** Release the timer; always call once the operation settles. */
  dispose(): void
}

/**
 * Bind one deadline to an operation. The returned signal aborts with an
 * {@link OperationTimeoutError} reason when the budget elapses, or with the
 * parent's reason when the caller cancels first.
 */
export function createOperationDeadline(
  budgetMs: number,
  parent?: AbortSignal,
  now: () => number = Date.now
): OperationDeadline {
  const controller = new AbortController()
  const startedAt = now()
  let expired = false
  const onParentAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted) controller.abort(parent.reason)
  else parent?.addEventListener("abort", onParentAbort, { once: true })
  const timer = setTimeout(
    () => {
      expired = true
      controller.abort(new OperationTimeoutError())
    },
    Math.max(0, budgetMs)
  )
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, budgetMs - (now() - startedAt)),
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener("abort", onParentAbort)
    },
  }
}

/**
 * A child signal for one attempt: aborts with the parent, or after `budgetMs`.
 * The caller disposes it once the attempt settles.
 */
export function createAttemptSignal(
  parent: AbortSignal,
  budgetMs: number
): { signal: AbortSignal; dispose: () => void } {
  const deadline = createOperationDeadline(budgetMs, parent)
  return { signal: deadline.signal, dispose: deadline.dispose }
}

/** True for a caller abort, a deadline abort, or an error shaped like either. */
export function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const name = (error as { name?: unknown }).name
  if (name === "AbortError" || name === "TimeoutError") return true
  const message = error instanceof Error ? error.message : ""
  return /(?:^|\b)(?:abort(?:ed)?|cancel(?:l)?ed)\b/i.test(message)
}

/** Throw the signal's reason as an abort-shaped error when it has fired. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const reason: unknown = signal.reason
  if (reason instanceof Error) throw reason
  throw new DOMException("Aborted", "AbortError")
}

interface Waiter {
  resolve: (release: () => void) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

interface ScopeQueue {
  running: number
  waiting: Waiter[]
}

/**
 * Cancellation-aware, bounded admission per `(scope, kind)`. At most
 * `OPERATION_CONCURRENCY[kind]` operations run at once; up to
 * `OPERATION_PENDING_MAX` more wait in FIFO order; anything beyond that is
 * refused immediately with {@link OperationAdmissionError}. A waiter whose
 * signal aborts leaves the queue without ever running.
 */
export class OperationAdmission {
  private readonly queues = new Map<string, ScopeQueue>()

  constructor(
    private readonly limits: Record<WebOperationKind, number> = OPERATION_CONCURRENCY,
    private readonly pendingMax = OPERATION_PENDING_MAX
  ) {}

  acquire(scope: string, kind: WebOperationKind, signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal)
    const key = `${kind}\u0000${scope}`
    let queue = this.queues.get(key)
    if (!queue) {
      queue = { running: 0, waiting: [] }
      this.queues.set(key, queue)
    }
    const q = queue
    const release = this.releaser(key, q)
    if (q.running < this.limits[kind]) {
      q.running += 1
      return Promise.resolve(release)
    }
    if (q.waiting.length >= this.pendingMax) {
      return Promise.reject(new OperationAdmissionError())
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = q.waiting.indexOf(waiter)
          if (index >= 0) q.waiting.splice(index, 1)
          this.prune(key, q)
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("Aborted", "AbortError")
          )
        }
        signal.addEventListener("abort", waiter.onAbort, { once: true })
      }
      q.waiting.push(waiter)
    })
  }

  /** Snapshot for tests and diagnostics. */
  stats(scope: string, kind: WebOperationKind): { running: number; waiting: number } {
    const q = this.queues.get(`${kind}\u0000${scope}`)
    return { running: q?.running ?? 0, waiting: q?.waiting.length ?? 0 }
  }

  private releaser(key: string, q: ScopeQueue): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = q.waiting.shift()
      if (next) {
        if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort)
        next.resolve(this.releaser(key, q))
        return
      }
      q.running = Math.max(0, q.running - 1)
      this.prune(key, q)
    }
  }

  private prune(key: string, q: ScopeQueue): void {
    if (q.running === 0 && q.waiting.length === 0) this.queues.delete(key)
  }
}

let sharedAdmission: OperationAdmission | null = null

/** Process-wide admission gate shared by every host tool caller. */
export function getOperationAdmission(): OperationAdmission {
  if (!sharedAdmission) sharedAdmission = new OperationAdmission()
  return sharedAdmission
}

export function resetOperationAdmissionForTesting(): void {
  sharedAdmission = null
}
