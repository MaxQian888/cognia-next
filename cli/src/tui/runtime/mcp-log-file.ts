/**
 * Durable file sink for captured MCP logs. The `/mcp logs` panel holds a bounded
 * in-memory ring buffer (session-scoped); this appends every captured line to
 * `~/.cognia/logs/mcp.log` too, so a diagnostic that scrolled out of the buffer
 * (or a crash the user only glimpsed) leaves a trail for post-hoc debugging.
 *
 * Size-rotated: when the file crosses `maxBytes` it rolls to `mcp.log.1` (one
 * generation) and starts fresh, so the log never grows unbounded. Pure +
 * injectable (fs ops + the target path), so it unit-tests without real disk and
 * a failing write can never crash the UI — every write is best-effort.
 */
import fs from "node:fs"
import path from "node:path"

import type { McpLogEntry } from "../state/types"

/** Absolute path to the MCP log for a given CLI home dir. */
export function mcpLogFilePath(home: string): string {
  return path.join(home, "logs", "mcp.log")
}

/** A captured log line as written to disk — the reducer-stamped `id` is
 * irrelevant to the file record, so the writer accepts an entry without it. */
export type McpLogFileEntry = Omit<McpLogEntry, "id">

/** Serialize one entry to the newline-terminated JSON line written to disk. */
export function formatMcpLogFileLine(entry: McpLogFileEntry): string {
  return (
    JSON.stringify({
      time: new Date(entry.ts).toISOString(),
      level: entry.level,
      source: entry.source,
      ...(entry.server ? { server: entry.server } : {}),
      message: entry.message,
    }) + "\n"
  )
}

/** Injectable filesystem seam (defaulted to real fs). */
export interface McpLogFsOps {
  /** Current byte size of `file`, or 0 when it doesn't exist. */
  sizeOf: (file: string) => number
  /** Append `data` to `file` (creating it if absent). */
  append: (file: string, data: string) => void
  /** Move `file` → `rotated`, overwriting any existing `rotated`. */
  rotate: (file: string, rotated: string) => void
  /** Ensure the parent directory of `file` exists. */
  ensureDir: (file: string) => void
}

const realFsOps: McpLogFsOps = {
  sizeOf: (file) => {
    try {
      return fs.statSync(file).size
    } catch {
      return 0
    }
  },
  append: (file, data) => fs.appendFileSync(file, data, "utf8"),
  rotate: (file, rotated) => {
    // renameSync fails on Windows when the destination exists — drop it first.
    try {
      fs.rmSync(rotated, { force: true })
    } catch {
      // ignore — a missing/locked prior generation shouldn't block rotation
    }
    fs.renameSync(file, rotated)
  },
  ensureDir: (file) => fs.mkdirSync(path.dirname(file), { recursive: true }),
}

export interface McpLogFileDeps {
  /** Target log file (absolute). */
  file: string
  /** Rotate once the file would exceed this many bytes. Default ~2 MB. */
  maxBytes?: number
  /** Filesystem seam — defaults to real fs. */
  fsOps?: McpLogFsOps
}

/** A best-effort MCP log-file appender. Never throws. */
export type McpLogFileWriter = (entry: McpLogFileEntry) => void

/**
 * Build a size-rotated file appender. The running byte count is tracked in
 * memory (seeded lazily from the existing file's size on the first write) so
 * rotation doesn't `stat` on every line.
 */
export function createMcpLogFileWriter(deps: McpLogFileDeps): McpLogFileWriter {
  const maxBytes = deps.maxBytes ?? 2_000_000
  const ops = deps.fsOps ?? realFsOps
  const rotated = `${deps.file}.1`
  let size = -1 // lazy seed
  let dirEnsured = false
  return (entry) => {
    const line = formatMcpLogFileLine(entry)
    // Count UTF-8 BYTES, not UTF-16 code units: `size` is seeded from the file's
    // real byte size, so using `line.length` undercounts multibyte (CJK/emoji)
    // content and rotation fires late — the file can grow well past `maxBytes`.
    const lineBytes = Buffer.byteLength(line, "utf8")
    try {
      if (!dirEnsured) {
        ops.ensureDir(deps.file)
        dirEnsured = true
      }
      if (size < 0) size = ops.sizeOf(deps.file)
      if (size > 0 && size + lineBytes > maxBytes) {
        ops.rotate(deps.file, rotated)
        size = 0
      }
      ops.append(deps.file, line)
      size += lineBytes
    } catch {
      // Best-effort — a read-only disk / permission error must never crash the
      // UI. The in-memory buffer still shows the line.
    }
  }
}

/** Convenience: a real-fs MCP log writer under the given CLI home dir. */
export function defaultMcpLogFileWriter(home: string): McpLogFileWriter {
  return createMcpLogFileWriter({ file: mcpLogFilePath(home) })
}
