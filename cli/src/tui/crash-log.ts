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
  /** Rotate to `<file>.1` once the file exceeds this many bytes before a
   * write; `0`/absent keeps the historic append-forever behavior. Crashes are
   * rare, so this stats the file per write instead of tracking a counter. */
  maxBytes?: number
  /** Size probe seam — defaults to a real `statSync` (0 when missing). */
  sizeOf?: (file: string) => number
  /** Rotation seam — defaults to a real rename that drops any prior `.1`. */
  rotate?: (file: string, rotated: string) => void
}

/** Real-fs append: ensures the parent dir exists, then appends the line. */
function realAppend(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, line, "utf8")
}

/** Real-fs size probe (0 when the file doesn't exist). */
function realSizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** Real-fs rotation: drop any prior generation (renameSync fails on Windows
 * when the destination exists), then rename. */
function realRotate(file: string, rotated: string): void {
  try {
    fs.rmSync(rotated, { force: true })
  } catch {
    // ignore — a missing/locked prior generation shouldn't block rotation
  }
  fs.renameSync(file, rotated)
}

/**
 * Build a {@link CrashLogger} that appends structured records to `deps.file`.
 * A failing append (read-only disk, permission error) is swallowed — logging a
 * crash must never cause a second crash.
 */
export function createCrashLogger(deps: CrashLoggerDeps): CrashLogger {
  const append = deps.append ?? realAppend
  const now = deps.now ?? (() => new Date())
  const sizeOf = deps.sizeOf ?? realSizeOf
  const rotate = deps.rotate ?? realRotate
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
      const line = formatCrashRecord(rec)
      if (deps.maxBytes && deps.maxBytes > 0) {
        const size = sizeOf(deps.file)
        if (size > 0 && size + Buffer.byteLength(line, "utf8") > deps.maxBytes) {
          rotate(deps.file, `${deps.file}.1`)
        }
      }
      append(deps.file, line)
    } catch {
      // Intentionally ignored — see the doc comment.
    }
  }
}

/** Convenience: a real-fs crash logger writing under the given CLI home dir.
 * `maxBytes` bounds crash.log via one-generation rotation (0/absent = never). */
export function defaultCrashLogger(home: string, maxBytes?: number): CrashLogger {
  return createCrashLogger({ file: crashLogPath(home), maxBytes })
}
