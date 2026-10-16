/**
 * Hard-signal exit for the TUI: persist the CLI database before the process
 * dies.
 *
 * With no listener, Node ends the process on SIGINT/SIGTERM/SIGHUP at once, so
 * a write still waiting on the database's debounce (a `/remember` confirmed a
 * moment earlier) never reached disk. These handlers flush first, bounded so a
 * wedged write cannot keep a killed TUI alive, restore the terminal, and exit
 * with the conventional `128 + signal` status.
 *
 * Raw mode turns a Ctrl+C keypress into input, so SIGINT only arrives from
 * outside (`kill -INT`) or while an interactive `!` command holds the terminal
 * in cooked mode. In that second case the shell runner has its own SIGINT
 * listener and owns the interrupt: the child gets it, and Cognia stays up.
 */

export type ExitSignal = "SIGINT" | "SIGTERM" | "SIGHUP"

const SIGNAL_NUMBERS: Readonly<Record<ExitSignal, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
}

/** How long a signal waits for the database flush before exiting anyway. */
export const SIGNAL_FLUSH_TIMEOUT_MS = 5_000

export interface SignalProcess {
  on(event: ExitSignal, listener: () => void): unknown
  off(event: ExitSignal, listener: () => void): unknown
  listenerCount(event: ExitSignal): number
  exit(code: number): void
}

export interface TuiExitSignalDeps {
  /** Persist pending database writes. */
  flush: () => Promise<void>
  /** Unmount the UI and put the terminal back; must be idempotent. */
  restore: () => void
  /** Where a failed or timed-out flush is recorded. */
  onFlushError?: (error: unknown) => void
  proc?: SignalProcess
  timeoutMs?: number
}

/**
 * Await `flush`, but give up after `timeoutMs`. Rejects with the flush error,
 * or with a timeout error, so the caller can record why data may be missing.
 */
export async function flushWithin(flush: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      flush(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`database flush did not finish within ${timeoutMs} ms`)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Install the handlers; the returned function removes them. */
export function installTuiExitSignals(deps: TuiExitSignalDeps): () => void {
  const proc: SignalProcess = deps.proc ?? (process as unknown as SignalProcess)
  const timeoutMs = deps.timeoutMs ?? SIGNAL_FLUSH_TIMEOUT_MS
  let exiting = false
  const listeners = new Map<ExitSignal, () => void>()

  const handle = (signal: ExitSignal) => {
    const code = 128 + SIGNAL_NUMBERS[signal]
    // A second signal while the flush runs means "stop now".
    if (exiting) {
      proc.exit(code)
      return
    }
    // Another SIGINT listener is the interactive-shell runner: the interrupt
    // belongs to the program in the foreground, not to Cognia.
    if (signal === "SIGINT" && proc.listenerCount("SIGINT") > 1) return
    exiting = true
    void flushWithin(deps.flush, timeoutMs)
      .catch((error) => deps.onFlushError?.(error))
      .finally(() => {
        try {
          deps.restore()
        } catch {
          // The terminal may already be gone (SIGHUP); exiting matters more.
        }
        proc.exit(code)
      })
  }

  for (const signal of Object.keys(SIGNAL_NUMBERS) as ExitSignal[]) {
    const listener = () => handle(signal)
    listeners.set(signal, listener)
    proc.on(signal, listener)
  }
  return () => {
    for (const [signal, listener] of listeners) proc.off(signal, listener)
    listeners.clear()
  }
}
