"use client"

/**
 * Turn-silence watchdog.
 *
 * # What it is for
 *
 * A chat turn flips the session to `streaming` and then depends on the sidecar
 * to flip it back. Every path that gives up in between is supposed to set a
 * terminal status on the way out, and most do — but a bare `return` on one of
 * them leaves the session `streaming` with no error, no event, and no way for
 * the user to tell "the model is thinking" from "nothing is coming". The
 * composer spins forever and there is nothing to press.
 *
 * This watchdog does not fix those paths. It makes the condition **visible**,
 * which is the part no amount of per-path auditing can guarantee: a path added
 * tomorrow that forgets its cleanup is caught by the same clock.
 *
 * # What it deliberately does not do
 *
 * It does not terminate the turn, release the execution lease, settle the work
 * submission, or change the run status. Silence is not proof of failure — a
 * multi-minute tool call or a slow reasoning model looks exactly like this from
 * here, and a watchdog that killed those would be a worse bug than the one it
 * is guarding. It raises one persistent `turnSilent` warning whose two actions
 * are "look at why" and "take the session back", and it clears that warning by
 * itself the moment the next frame arrives.
 *
 * # What counts as a sign of life
 *
 * Anything the host says about this session: an assistant delta, a tool call, a
 * permission request, an SDK session id, a command acknowledgement, or a
 * terminal frame. Callers funnel all of them into {@link SilenceWatchdog.notice}
 * rather than the watchdog subscribing on its own, because the controller
 * already demultiplexes the stream and a second subscriber would be a second
 * thing to keep in sync.
 */

/** How long a turn may say nothing before the warning is raised. */
export const DEFAULT_SILENCE_TIMEOUT_MS = 90_000

export interface SilenceWatchdogOptions {
  /** Silence budget in ms. */
  timeoutMs?: number
  /**
   * Raised once per silent stretch. `silentForMs` is the budget that elapsed,
   * so the caller can put a real number in front of the user rather than a
   * hard-coded "90 seconds" that drifts from this constant.
   */
  onSilent: (sessionId: string, silentForMs: number) => void
  /**
   * Called when a session that had gone silent speaks again, or is disarmed
   * while flagged. Callers use it to clear the warning they raised — the
   * watchdog never leaves a stale one behind.
   */
  onRecovered?: (sessionId: string) => void
}

export interface SilenceWatchdog {
  /** Start (or restart) the clock for a session. Idempotent. */
  arm(sessionId: string): void
  /** A sign of life. Restarts the clock and clears any raised warning. */
  notice(sessionId: string): void
  /** The turn ended. Stops the clock and clears any raised warning. */
  disarm(sessionId: string): void
  /** Whether this session is currently flagged silent. */
  isSilent(sessionId: string): boolean
  /**
   * The sessions with a live clock, as a snapshot safe to iterate while
   * disarming.
   *
   * Exists so a store watcher can check only the turns actually being timed
   * instead of sweeping every open session on every store write — one open turn
   * is the normal case, and the chat store writes once per streaming delta.
   */
  armed(): string[]
  /** Unmount. Stops every clock without firing `onRecovered`. */
  dispose(): void
}

interface Entry {
  timer: ReturnType<typeof setTimeout>
  silent: boolean
}

export function createSilenceWatchdog(options: SilenceWatchdogOptions): SilenceWatchdog {
  const { timeoutMs = DEFAULT_SILENCE_TIMEOUT_MS, onSilent, onRecovered } = options
  const entries = new Map<string, Entry>()

  const clearTimer = (sessionId: string): Entry | undefined => {
    const entry = entries.get(sessionId)
    if (entry) clearTimeout(entry.timer)
    return entry
  }

  const start = (sessionId: string, wasSilent: boolean) => {
    const timer = setTimeout(() => {
      const current = entries.get(sessionId)
      // Only fire once per silent stretch: a second `onSilent` for the same
      // stretch would re-raise a warning the user may have already read.
      if (!current || current.silent) return
      current.silent = true
      onSilent(sessionId, timeoutMs)
    }, timeoutMs)
    entries.set(sessionId, { timer, silent: wasSilent })
  }

  return {
    arm(sessionId) {
      const existing = clearTimer(sessionId)
      // Arming a session that is already flagged keeps the flag: the caller is
      // re-arming an open turn, not starting a new one, and dropping it here
      // would clear a warning nothing has answered.
      start(sessionId, existing?.silent ?? false)
    },

    notice(sessionId) {
      const existing = entries.get(sessionId)
      // Never arm on a stray frame. A `notice` for a session with no clock is
      // a late event on a settled turn, and starting a clock for it would
      // eventually flag a session that is not running anything.
      if (!existing) return
      clearTimeout(existing.timer)
      if (existing.silent) onRecovered?.(sessionId)
      start(sessionId, false)
    },

    disarm(sessionId) {
      const existing = clearTimer(sessionId)
      if (!existing) return
      entries.delete(sessionId)
      if (existing.silent) onRecovered?.(sessionId)
    },

    isSilent(sessionId) {
      return entries.get(sessionId)?.silent ?? false
    },

    armed() {
      // Copied, not a live view: callers disarm while iterating.
      return [...entries.keys()]
    },

    dispose() {
      for (const entry of entries.values()) clearTimeout(entry.timer)
      entries.clear()
    },
  }
}
