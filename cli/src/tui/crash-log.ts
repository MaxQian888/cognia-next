/**
 * Crash logging for the TUI. When the React error boundary catches a render
 * throw, or a process-level `uncaughtException` / `unhandledRejection` fires,
 * we append a structured record to `~/.cognia/logs/crash.log` so a crash the
 * user only saw for a moment (or never saw, if it happened off-screen) leaves a
 * durable trail.
 *
 * Pure + injectable: the file path, the append sink, and the clock are all
 * injected, so the logger unit-tests without touching real disk, and logging a
 * crash can never itself throw (a failing append is swallowed).
 */
import fs from "node:fs"
import path from "node:path"

/** Absolute path to the crash log for a given CLI home dir. */
export function crashLogPath(home: string): string {
  return path.join(home, "logs", "crash.log")
}

/** One appended crash record (serialized as a single JSON line). */
export interface CrashRecord {
  /** ISO-8601 timestamp. */
  time: string
  /** Where it came from: "render" (error boundary), "uncaughtException", … */
  source: string
  message: string
  stack?: string
  /** Extra context (e.g. the React component stack). */
  info?: string
}

/** Serialize a record to the newline-terminated JSON line written to the log. */
export function formatCrashRecord(rec: CrashRecord): string {
  return JSON.stringify(rec) + "\n"
}

/** Logs one crash. Never throws. `info` accepts null (React's component stack
 * may be null) — a falsy value is simply omitted from the record. */
export type CrashLogger = (source: string, error: unknown, info?: string | null) => void

export interface CrashLoggerDeps {
  /** Target log file (absolute). */
  file: string
  /** Append sink — defaults to a real fs append that creates the dir first. */
  append?: (file: string, line: string) => void
  /** Clock — defaults to the real wall clock. */
  now?: () => Date
}

/** Real-fs append: ensures the parent dir exists, then appends the line. */
function realAppend(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, line, "utf8")
}

/**
 * Build a {@link CrashLogger} that appends structured records to `deps.file`.
 * A failing append (read-only disk, permission error) is swallowed — logging a
 * crash must never cause a second crash.
 */
export function createCrashLogger(deps: CrashLoggerDeps): CrashLogger {
  const append = deps.append ?? realAppend
  const now = deps.now ?? (() => new Date())
  return (source, error, info) => {
    const err = error instanceof Error ? error : new Error(String(error))
    const rec: CrashRecord = {
      time: now().toISOString(),
      source,
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(info ? { info } : {}),
    }
    try {
      append(deps.file, formatCrashRecord(rec))
    } catch {
      // Intentionally ignored — see the doc comment.
    }
  }
}

/** Convenience: a real-fs crash logger writing under the given CLI home dir. */
export function defaultCrashLogger(home: string): CrashLogger {
  return createCrashLogger({ file: crashLogPath(home) })
}
