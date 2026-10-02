/**
 * JSON-line logs. Fields are restricted to scalars and callers pass only
 * non-secret identifiers (probe/profile/check/run IDs, reasons, counts,
 * durations). Room IDs, keys, signatures, request bodies and IPs never reach
 * this function; there is deliberately no "log an object" escape hatch.
 */

export type LogValue = string | number | boolean | null
export type LogFields = Record<string, LogValue>
export type LogLevel = "info" | "warn" | "error"

export interface Logger {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

export function createLogger(
  write: (line: string) => void = (line) => process.stdout.write(line),
  now: () => number = Date.now
): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    // Fixed keys go last so a field can never spoof the level or event.
    write(`${JSON.stringify({ ...fields, ts: new Date(now()).toISOString(), level, event })}\n`)
  }
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  }
}

/** A logger that records lines, for tests. */
export function memoryLogger(): Logger & {
  lines: Array<{ level: LogLevel; event: string } & LogFields>
} {
  const lines: Array<{ level: LogLevel; event: string } & LogFields> = []
  const push =
    (level: LogLevel) =>
    (event: string, fields: LogFields = {}) => {
      lines.push({ ...fields, level, event })
    }
  return { lines, info: push("info"), warn: push("warn"), error: push("error") }
}
