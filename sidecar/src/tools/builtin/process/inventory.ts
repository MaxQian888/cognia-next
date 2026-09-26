// Process inventory — cross-platform listing + the session PID registry.
//
// Windows uses PowerShell `Get-Process` (CIM-backed); POSIX uses `ps` with a
// stable column layout. Output is normalised into a single ProcessInfo shape.
//
// `trackedPids` is the ONE shared registry: start_process records spawned PIDs
// here so terminate_process can refuse to kill processes the agent didn't start.
// Every process tool imports this single Set instance — do not re-declare it.

import { ALLOWED_COMMANDS, BLOCKED_COMMANDS } from "../../../policy/shell/rules.ts"
import { execFileAsync } from "../../../platform/process/exec.ts"

export const MAX_OUTPUT_BYTES = 1 * 1024 * 1024 // 1 MB — process listings can be sizeable
export const DEFAULT_TIMEOUT_MS = 15 * 1000

/** Session PID registry — single shared instance. */
export const trackedPids = new Set<number>()

export interface ProcessInfo {
  pid: number
  name: string
  /** Resident set size in bytes (best-effort). */
  memoryBytes?: number | undefined
  cpuPercent?: number | undefined
  /** Full command line if available. */
  cmdLine?: string | undefined
  parentPid?: number | undefined
}

/** The fields a process can be sorted by. */
export type ProcessSortKey = "pid" | "name" | "cpu" | "memory"

export async function listAllProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") {
    return listWindows()
  }
  return listPosix()
}

// ── Shared short-TTL snapshot ────────────────────────────────────────────────
// list/get/search/top_memory each enumerated EVERY process on every call —
// 4 tools that each re-spawn `ps`/PowerShell (and `get_process` enumerated all
// of them just to find one PID). A model that lists, then inspects, then ranks
// in one turn paid 3+ full enumerations. A short-lived snapshot collapses a burst
// into a single spawn while staying fresh enough for an interactive tool.

export const PROCESS_SNAPSHOT_TTL_MS = 1500

let snapshotCache: { at: number; procs: ProcessInfo[] } | null = null

/**
 * A process listing no older than `maxAgeMs`, shared across the read-only process
 * tools. `now` / `list` are injectable for tests.
 */
export async function getProcessSnapshot({
  maxAgeMs = PROCESS_SNAPSHOT_TTL_MS,
  now = Date.now,
  list = listAllProcesses,
}: {
  maxAgeMs?: number
  now?: () => number
  list?: () => Promise<ProcessInfo[]>
} = {}): Promise<ProcessInfo[]> {
  const t = now()
  if (snapshotCache && t - snapshotCache.at < maxAgeMs) return snapshotCache.procs
  const procs = await list()
  snapshotCache = { at: t, procs }
  return procs
}

/** Drop the cached snapshot (tests / explicit refresh). */
export function resetProcessSnapshot(): void {
  snapshotCache = null
}

async function listPosix(): Promise<ProcessInfo[]> {
  // -e: every process; -o: column list; --no-headers omits header line.
  // ww: wide output (don't truncate args).
  const args = ["-eo", "pid=,ppid=,rss=,pcpu=,comm=,args=", "ww"]
  let stdout = ""
  try {
    const r = await execFileAsync("ps", args, {
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    })
    // No `encoding: "buffer"`, so execFile hands back strings.
    stdout = r.stdout as string
  } catch {
    // macOS ps doesn't accept "ww" twice; retry without it.
    const r = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss=,pcpu=,comm=,args="], {
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    })
    stdout = r.stdout as string
  }
  return parsePosixPs(stdout)
}

export function parsePosixPs(stdout: string): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Split first 5 columns by whitespace, leave the rest as args.
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s*(.*)$/)
    if (!m) continue
    const [, pid, ppid, rssKb, cpu, comm, args] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    out.push({
      pid: Number(pid),
      parentPid: Number(ppid),
      memoryBytes: Number(rssKb) * 1024,
      cpuPercent: Number(cpu),
      name: comm,
      cmdLine: args || comm,
    })
  }
  return out
}

async function listWindows(): Promise<ProcessInfo[]> {
  // Get-Process is the modern replacement for tasklist/wmic. Format-Csv keeps
  // values quoted so paths with spaces don't break parsing.
  const psScript =
    "Get-Process | Select-Object Id,ProcessName,WorkingSet64,CPU,Path,Description | ConvertTo-Csv -NoTypeInformation"
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }
  )
  return parseWindowsCsv(stdout as string)
}

export function parseWindowsCsv(stdout: string): ProcessInfo[] {
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  if (lines.length <= 1) return []
  const out: ProcessInfo[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvRow(lines[i]!)
    if (cells.length < 6) continue
    const [pid, name, ws, cpu, exe] = cells as [string, string, string, string, string]
    out.push({
      pid: Number(pid),
      name,
      memoryBytes: ws ? Number(ws) : undefined,
      cpuPercent: cpu ? Number(cpu) : undefined,
      cmdLine: exe || name,
    })
  }
  return out
}

export function parseCsvRow(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQ = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQ = true
    } else if (c === ",") {
      out.push(cur)
      cur = ""
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out
}

// Per-row cap on the (often very long) command line. At a list `limit` of 100
// rows an uncapped cmdLine — full argv of every process — can dominate the
// result; clipping each keeps the listing token-frugal while still showing the
// program and leading args.
export const MAX_CMDLINE_CHARS = 200

export function formatProcess(proc: ProcessInfo) {
  const cmdLine =
    typeof proc.cmdLine === "string" && proc.cmdLine.length > MAX_CMDLINE_CHARS
      ? `${proc.cmdLine.slice(0, MAX_CMDLINE_CHARS)}…`
      : proc.cmdLine
  return {
    pid: proc.pid,
    name: proc.name,
    parentPid: proc.parentPid,
    memoryMB:
      typeof proc.memoryBytes === "number" ? Math.round(proc.memoryBytes / 1024 / 1024) : undefined,
    cpuPercent: proc.cpuPercent,
    cmdLine,
  }
}

export function compareBy(
  a: ProcessInfo,
  b: ProcessInfo,
  key: ProcessSortKey | string,
  desc: boolean
): number {
  const va = pickField(a, key)
  const vb = pickField(b, key)
  const dir = desc ? -1 : 1
  if (va === undefined && vb === undefined) return 0
  if (va === undefined) return 1
  if (vb === undefined) return -1
  if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir
  return String(va).localeCompare(String(vb)) * dir
}

export function pickField(
  p: ProcessInfo,
  key: ProcessSortKey | string
): number | string | undefined {
  switch (key) {
    case "pid":
      return p.pid
    case "name":
      return p.name
    case "cpu":
      return p.cpuPercent
    case "memory":
    default:
      return p.memoryBytes
  }
}

export function isProgramAllowed(name: unknown): boolean {
  const lc = String(name)
    .toLowerCase()
    .replace(/\.exe$/i, "")
  if (BLOCKED_COMMANDS.has(lc)) return false
  return ALLOWED_COMMANDS.has(lc)
}
