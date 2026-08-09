/**
 * Startup command runner for terminal profiles.
 *
 * After a session connects and the shell is ready, this module sends the
 * profile's `startupCommands` sequentially. It uses OSC 633 prompt_start
 * as the gate between commands when shell integration is available;
 * otherwise falls back to a delay-based approach.
 *
 * Pure logic — works against the session abstraction without React or store
 * dependencies.
 */

/** Minimum delay between commands when no shell integration is present. */
export const STARTUP_COMMAND_DELAY_MS = 250

/** Maximum time to wait for a prompt between startup commands. */
export const STARTUP_COMMAND_TIMEOUT_MS = 5000

export interface StartupCommandRunner {
  /** Cancel any pending commands in the queue. */
  cancel: () => void
}

export interface StartupCommandSession {
  /** Write data (command + \r) to the PTY. */
  write: (data: string) => void
  /**
   * Register a one-time listener for the next prompt (OSC 633 A).
   * Returns an unsubscribe function. Returns `null` if shell integration
   * is not available (triggers fallback to delay-based approach).
   */
  onNextPrompt?: (cb: () => void) => (() => void) | null
}

/**
 * Execute startup commands sequentially. Returns a handle with a `cancel`
 * method so the session can abort on close/disconnect.
 */
export function runStartupCommands(
  session: StartupCommandSession,
  commands: readonly string[]
): StartupCommandRunner {
  let cancelled = false
  let currentTimeout: ReturnType<typeof setTimeout> | null = null
  let currentUnsub: (() => void) | null = null

  async function execute() {
    for (const cmd of commands) {
      if (cancelled) break
      session.write(cmd + "\r")

      if (commands.indexOf(cmd) < commands.length - 1) {
        // Wait for prompt or timeout before the next command.
        await waitForReady()
      }
    }
  }

  function waitForReady(): Promise<void> {
    return new Promise((resolve) => {
      if (cancelled) {
        resolve()
        return
      }

      // Try shell integration first.
      if (session.onNextPrompt) {
        const unsub = session.onNextPrompt(() => {
          if (currentTimeout) {
            clearTimeout(currentTimeout)
            currentTimeout = null
          }
          currentUnsub = null
          resolve()
        })

        if (unsub) {
          currentUnsub = unsub
          // Timeout fallback in case prompt never fires.
          currentTimeout = setTimeout(() => {
            currentTimeout = null
            if (currentUnsub) {
              currentUnsub()
              currentUnsub = null
            }
            resolve()
          }, STARTUP_COMMAND_TIMEOUT_MS)
          return
        }
      }

      // Fallback: simple delay.
      currentTimeout = setTimeout(() => {
        currentTimeout = null
        resolve()
      }, STARTUP_COMMAND_DELAY_MS)
    })
  }

  // Start execution.
  execute()

  return {
    cancel: () => {
      cancelled = true
      if (currentTimeout) {
        clearTimeout(currentTimeout)
        currentTimeout = null
      }
      if (currentUnsub) {
        currentUnsub()
        currentUnsub = null
      }
    },
  }
}
