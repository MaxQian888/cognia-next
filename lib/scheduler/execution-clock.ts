/**
 * A scheduled execution's timeout, as a clock a running executor can stop
 * (ADR-0224 A7).
 *
 * `task.config.timeout` bounds how long a task may run. An unattended chat
 * turn that parks a tool request for a person is not running while it waits:
 * the time someone takes to answer must not be charged against that budget,
 * or every parked request near the end of a run would turn into an
 * `execution-timeout` instead of the decision it was waiting for. The park
 * bounds that wait on its own (`lib/claude/unattended-park.ts`).
 *
 * The clock is bound to the execution's AbortSignal so the executors keep
 * their `(task, execution, signal)` signature: whoever holds the signal can
 * hold the clock. Holds nest; the clock runs again when the last one is
 * released, with whatever time was left.
 */

export interface ExecutionClock {
  /** Stop the clock until the returned release is called. */
  hold(): () => void
  /** Stop the clock for good (the execution is over). */
  clear(): void
}

const clocks = new WeakMap<AbortSignal, ExecutionClock>()

/**
 * Abort `controller` with `reason` once `timeoutMs` of unheld time has passed.
 * A non-positive or non-finite timeout never fires.
 */
export function startExecutionClock(
  controller: AbortController,
  timeoutMs: number,
  reason: string = "execution-timeout",
  now: () => number = () => Date.now()
): ExecutionClock {
  const enabled = Number.isFinite(timeoutMs) && timeoutMs > 0
  let remaining = timeoutMs
  let startedAt = now()
  let timer: ReturnType<typeof setTimeout> | null = null
  let holds = 0
  let cleared = false

  const arm = () => {
    if (!enabled || cleared || timer || controller.signal.aborted) return
    startedAt = now()
    timer = setTimeout(() => {
      timer = null
      controller.abort(reason)
    }, remaining)
  }
  const stop = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
    remaining = Math.max(0, remaining - (now() - startedAt))
  }

  const clock: ExecutionClock = {
    hold() {
      holds += 1
      if (holds === 1) stop()
      let released = false
      return () => {
        if (released) return
        released = true
        holds = Math.max(0, holds - 1)
        if (holds === 0) arm()
      }
    },
    clear() {
      cleared = true
      if (timer) clearTimeout(timer)
      timer = null
      clocks.delete(controller.signal)
    },
  }
  clocks.set(controller.signal, clock)
  arm()
  return clock
}

/**
 * Stop the execution clock behind `signal` until the returned release is
 * called. A signal with no clock (a test, a caller outside the scheduler)
 * gets a release that does nothing.
 */
export function holdExecutionClock(signal: AbortSignal | undefined): () => void {
  const clock = signal ? clocks.get(signal) : undefined
  return clock ? clock.hold() : () => undefined
}
