/**
 * Idle watchdog for a streaming agent turn.
 *
 * Bounds a turn by SILENCE, never by wall-clock: a long agentic turn (deep
 * thinking, many tool legs) is legitimate and must not be killed, while a
 * provider that holds the connection open and stops sending bytes must be.
 *
 * This implements the contract `config.streamIdleTimeoutMs` already documents
 * for the built-in sidecar path — it arms only AFTER the first streamed event,
 * so a slow cold start never trips it, and it pauses while a permission prompt
 * is awaiting the user, so a long approval never trips it either. The external
 * (ACP / Codex) session had no equivalent: it inherited a hard wall-clock cap
 * from the shared manager instead, which killed every turn past a minute.
 *
 * Pure aside from the injected clock/timer, so it unit-tests without real time.
 */

/** The minimal timer surface the watchdog needs; injected in tests. */
export interface TimerApi {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export interface IdleWatchdogOptions {
  /** Idle budget in ms. `<= 0` disables the watchdog entirely. */
  timeoutMs: number
  now?: () => number
  timers?: TimerApi
}

export interface IdleWatchdog {
  /** Record stream activity. The first call also ARMS the watchdog. */
  bump(): void
  /** Suspend the countdown while the user is being asked something. Reentrant. */
  pause(): void
  /** Resume the countdown; also counts as activity. */
  resume(): void
  /** Stop permanently and release the timer. */
  stop(): void
  /**
   * Resolves once the idle budget elapses. Never rejects, and never settles
   * when the watchdog is disabled or stopped first — so a caller can leave it
   * in a `Promise.race` without risking an unhandled rejection.
   */
  whenIdle(): Promise<void>
}

const nodeTimers: TimerApi = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    // The watchdog alone must never hold the process open.
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** A watchdog that never fires — the shape returned when the budget is disabled. */
function disabledWatchdog(): IdleWatchdog {
  const never = new Promise<void>(() => {})
  return {
    bump: () => {},
    pause: () => {},
    resume: () => {},
    stop: () => {},
    whenIdle: () => never,
  }
}

export function createIdleWatchdog(options: IdleWatchdogOptions): IdleWatchdog {
  const { timeoutMs } = options
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return disabledWatchdog()

  const now = options.now ?? Date.now
  const timers = options.timers ?? nodeTimers

  let handle: unknown
  let armed = false
  let stopped = false
  let pauseDepth = 0
  let lastActivity = now()
  let fire: (() => void) | undefined
  const idle = new Promise<void>((resolve) => {
    fire = resolve
  })

  const clear = (): void => {
    if (handle !== undefined) {
      timers.clear(handle)
      handle = undefined
    }
  }

  const schedule = (ms: number): void => {
    clear()
    if (stopped || !armed || pauseDepth > 0) return
    handle = timers.set(onTick, Math.max(0, ms))
  }

  function onTick(): void {
    handle = undefined
    if (stopped || !armed) return
    // A pause that landed after the timer was scheduled: drop this tick and let
    // `resume` re-arm from a fresh activity stamp.
    if (pauseDepth > 0) return
    const elapsed = now() - lastActivity
    if (elapsed >= timeoutMs) {
      stopped = true
      fire?.()
      return
    }
    // Activity arrived while the timer was pending — wait out the remainder
    // instead of tearing down and rebuilding a timer on every stream delta.
    schedule(timeoutMs - elapsed)
  }

  return {
    bump() {
      if (stopped) return
      lastActivity = now()
      if (!armed) {
        armed = true
        schedule(timeoutMs)
      }
    },
    pause() {
      if (stopped) return
      pauseDepth += 1
      clear()
    },
    resume() {
      if (stopped || pauseDepth === 0) return
      pauseDepth -= 1
      if (pauseDepth > 0) return
      lastActivity = now()
      schedule(timeoutMs)
    },
    stop() {
      stopped = true
      clear()
    },
    whenIdle: () => idle,
  }
}
