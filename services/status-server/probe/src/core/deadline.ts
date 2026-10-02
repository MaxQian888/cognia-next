/**
 * Deadline and cancellation helpers shared by the HTTP and protocol checks.
 *
 * The core never trusts an adapter to honour its own timeout: every awaited
 * network step is raced against a local timer and the run's abort signal, so
 * a stuck socket cannot hold a run past its deadline.
 */

/** The core's own timer fired before the awaited step settled. */
export class DeadlineError extends Error {
  constructor() {
    super("deadline exceeded")
    this.name = "DeadlineError"
  }
}

/** The run was cancelled through its abort signal. */
export class ProbeAbortedError extends Error {
  constructor() {
    super("probe run aborted")
    this.name = "ProbeAbortedError"
  }
}

/**
 * Settle with `promise`, or reject with `DeadlineError` after `ms`, or with
 * `ProbeAbortedError` as soon as `signal` aborts. The losing promise's later
 * rejection is observed so it never surfaces as an unhandled rejection.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  promise.catch(() => undefined)
  if (signal.aborted) return Promise.reject(new ProbeAbortedError())
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        cleanup()
        reject(new DeadlineError())
      },
      Math.max(0, ms)
    )
    const onAbort = () => {
      cleanup()
      reject(new ProbeAbortedError())
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

/** Resolve after `ms`, or immediately when `signal` aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, Math.max(0, ms))
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}
