import type { Log } from "./sessions/types.ts"
import { errorStack } from "../shared/errors.ts"

/**
 * Last-resort process guards. A bug that escapes every handler above must not
 * take every session down with it, so log it and keep serving. The budget is
 * the escape hatch for a genuinely broken host: more than
 * `UNCAUGHT_ERROR_BUDGET` escapes inside one window exits with code 1, and
 * Rust's recovery ladder takes over as before.
 */
export const UNCAUGHT_ERROR_BUDGET = 5

export const UNCAUGHT_ERROR_WINDOW_MS = 60_000

export function createUncaughtErrorGuard({
  log: logFn,
  exit,
  now = () => Date.now(),
}: {
  log: Log
  exit: (code: number) => unknown
  now?: () => number
}) {
  let windowStart = now()
  let count = 0
  return (kind: string, err: unknown) => {
    const at = now()
    if (at - windowStart > UNCAUGHT_ERROR_WINDOW_MS) {
      windowStart = at
      count = 0
    }
    count += 1
    const reason = errorStack(err)
    logFn("error", `${kind}: ${reason}`)
    if (count > UNCAUGHT_ERROR_BUDGET) {
      logFn("error", `${count} uncaught errors within ${UNCAUGHT_ERROR_WINDOW_MS}ms; exiting`)
      exit(1)
    }
  }
}
