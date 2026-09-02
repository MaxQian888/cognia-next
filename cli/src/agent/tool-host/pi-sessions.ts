/**
 * List the sessions Pi keeps on disk, for the `list_pi_sessions` host command.
 *
 * Pi's RPC protocol has no "list sessions" command (`switch_session` takes a
 * path the caller is expected to already know), and the adapter runs in the
 * renderer under static export, so it cannot look for itself. This is the
 * host's answer, and it deliberately mirrors what Pi's own `SessionManager.list`
 * does rather than inventing a second notion of "a session":
 *
 *   - the store is `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`) `/sessions/`
 *   - one sub-directory per working directory, named by Pi's own encoding
 *     (`--` + path with `/`, `\` and `:` replaced by `-` + `--`)
 *   - one `.jsonl` file per session whose first line is the header
 *     (`{"type":"session","id":...,"cwd":...,"timestamp":...}`)
 *   - the display name, when set, is the LAST `session_info` entry
 *
 * Only headers and names are read. Message bodies never leave this function,
 * and nothing here writes: listing must not be a way for Cognia to touch Pi's
 * store.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface PiSessionRecord {
  id: string
  cwd?: string
  name?: string
  createdAt?: string
  updatedAt?: string
}

/** Bytes of a file scanned for the header line before giving up on it. */
const HEADER_SCAN_LIMIT = 64 * 1024
/** Files larger than this keep their header but skip the name scan. */
const NAME_SCAN_LIMIT = 16 * 1024 * 1024

export function piAgentDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim()
  return override || path.join(os.homedir(), ".pi", "agent")
}

/** Pi's session directory name for a working directory (`session-manager.js`). */
export function piSessionDirName(cwd: string): string {
  const resolved = path.resolve(cwd)
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

interface SessionHeader {
  id: string
  cwd?: string
  timestamp?: string
}

function parseHeader(text: string): SessionHeader | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (parsed.type !== "session" || typeof parsed.id !== "string" || !parsed.id) return null
      return {
        id: parsed.id,
        ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
        ...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {}),
      }
    } catch {
      return null
    }
  }
  return null
}

function readHeader(file: string): SessionHeader | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, "r")
    const buffer = Buffer.alloc(HEADER_SCAN_LIMIT)
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, read).toString("utf8")
    const newline = text.indexOf("\n")
    return parseHeader(newline >= 0 ? text.slice(0, newline + 1) : text)
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** The last `session_info` name, or undefined. Cheap string test per line. */
function readName(file: string, size: number): string | undefined {
  if (size > NAME_SCAN_LIMIT) return undefined
  let name: string | undefined
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"session_info"')) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed.type === "session_info" && typeof parsed.name === "string" && parsed.name) {
        name = parsed.name
      }
    } catch {
      // A torn trailing line is not a name.
    }
  }
  return name
}

function listDir(dir: string, cwdFilter: string | undefined): PiSessionRecord[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const records: PiSessionRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue
    const file = path.join(dir, entry)
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const header = readHeader(file)
    if (!header) continue
    if (cwdFilter && (!header.cwd || path.resolve(header.cwd) !== cwdFilter)) continue
    const name = readName(file, stat.size)
    records.push({
      id: header.id,
      ...(header.cwd ? { cwd: header.cwd } : {}),
      ...(name ? { name } : {}),
      ...(header.timestamp ? { createdAt: header.timestamp } : {}),
      updatedAt: stat.mtime.toISOString(),
    })
  }
  return records
}

/**
 * Sessions for one working directory, or for every directory when `cwd` is
 * absent. Newest activity first.
 */
export function listPiSessions(
  options: { cwd?: string; agentDir?: string } = {}
): PiSessionRecord[] {
  const root = path.join(options.agentDir ?? piAgentDir(), "sessions")
  let records: PiSessionRecord[]
  if (options.cwd) {
    records = listDir(path.join(root, piSessionDirName(options.cwd)), path.resolve(options.cwd))
  } else {
    let dirs: string[]
    try {
      dirs = fs.readdirSync(root)
    } catch {
      dirs = []
    }
    records = dirs.flatMap((dir) => listDir(path.join(root, dir), undefined))
  }
  return records.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
}
