// Process management tools — list, get, search, terminate.
//
// Cross-platform: Windows uses PowerShell `Get-Process` (CIM-backed, more
// reliable than the deprecated `wmic`); POSIX uses `ps` with a stable column
// layout. Output is normalised into a single ProcessInfo shape.
//
// Tracking: when start_process runs, the spawned PID is recorded in a
// module-level Set so terminate_process can refuse to kill processes the
// agent didn't start (unless the user explicitly opts in). Approval gates
// live with the parent (canUseTool), not here.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { ALLOWED_COMMANDS, BLOCKED_COMMANDS, toolError, toolText } from "./safety.mjs"

const execFileAsync = promisify(execFile)

const MAX_OUTPUT_BYTES = 1 * 1024 * 1024 // 1 MB — process listings can be sizeable
const DEFAULT_TIMEOUT_MS = 15 * 1000

/** @type {Set<number>} */
const trackedPids = new Set()

// ---- Platform-agnostic listing -------------------------------------------

/**
 * @typedef ProcessInfo
 * @property {number} pid
 * @property {string} name
 * @property {number=} memoryBytes  Resident set size in bytes (best-effort).
 * @property {number=} cpuPercent
 * @property {string=} cmdLine      Full command line if available.
 * @property {number=} parentPid
 */

async function listAllProcesses() {
  if (process.platform === "win32") {
    return listWindows()
  }
  return listPosix()
}

async function listPosix() {
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
    stdout = r.stdout
  } catch {
    // macOS ps doesn't accept "ww" twice; retry without it.
    const r = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss=,pcpu=,comm=,args="], {
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    })
    stdout = r.stdout
  }
  return parsePosixPs(stdout)
}

function parsePosixPs(stdout) {
  const out = []
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Split first 5 columns by whitespace, leave the rest as args.
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s*(.*)$/)
    if (!m) continue
    const [, pid, ppid, rssKb, cpu, comm, args] = m
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

async function listWindows() {
  // Get-Process is the modern replacement for tasklist/wmic. Format-Csv keeps
  // values quoted so paths with spaces don't break parsing.
  const psScript =
    "Get-Process | Select-Object Id,ProcessName,WorkingSet64,CPU,Path,Description | ConvertTo-Csv -NoTypeInformation"
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }
  )
  return parseWindowsCsv(stdout)
}

function parseWindowsCsv(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  if (lines.length <= 1) return []
  const out = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvRow(lines[i])
    if (cells.length < 6) continue
    const [pid, name, ws, cpu, exe] = cells
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

function parseCsvRow(line) {
  const out = []
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

function formatProcess(proc) {
  return {
    pid: proc.pid,
    name: proc.name,
    parentPid: proc.parentPid,
    memoryMB:
      typeof proc.memoryBytes === "number" ? Math.round(proc.memoryBytes / 1024 / 1024) : undefined,
    cpuPercent: proc.cpuPercent,
    cmdLine: proc.cmdLine,
  }
}

// ---- list_processes -------------------------------------------------------

const listProcessesShape = {
  name: z.string().optional().describe("Filter by name substring (case-insensitive)."),
  limit: z.number().int().min(1).max(2000).default(100).describe("Cap on rows returned."),
  sortBy: z.enum(["pid", "name", "cpu", "memory"]).default("memory").describe("Sort key."),
  sortDesc: z.boolean().default(true).describe("Sort descending."),
}

async function execListProcesses(args) {
  try {
    const all = await listAllProcesses()
    const needle = args.name?.toLowerCase()
    const filtered = needle ? all.filter((p) => p.name.toLowerCase().includes(needle)) : all
    const sorted = filtered.slice().sort((a, b) => compareBy(a, b, args.sortBy, args.sortDesc))
    const sliced = sorted.slice(0, args.limit)
    return toolText({
      total: filtered.length,
      truncated: filtered.length > sliced.length,
      processes: sliced.map(formatProcess),
    })
  } catch (err) {
    return toolError(err, "list_processes")
  }
}

function compareBy(a, b, key, desc) {
  const va = pickField(a, key)
  const vb = pickField(b, key)
  const dir = desc ? -1 : 1
  if (va === undefined && vb === undefined) return 0
  if (va === undefined) return 1
  if (vb === undefined) return -1
  if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir
  return String(va).localeCompare(String(vb)) * dir
}

function pickField(p, key) {
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

export const listProcessesTool = tool(
  "list_processes",
  "List running processes (read-only). Optional name filter, limit, and sort.",
  listProcessesShape,
  execListProcesses
)

// ---- get_process ----------------------------------------------------------

const getProcessShape = {
  pid: z.number().int().describe("PID of the target process."),
}

async function execGetProcess(args) {
  try {
    const all = await listAllProcesses()
    const proc = all.find((p) => p.pid === args.pid)
    if (!proc) return toolError(`no process with pid ${args.pid}`)
    return toolText(formatProcess(proc))
  } catch (err) {
    return toolError(err, "get_process")
  }
}

export const getProcessTool = tool(
  "get_process",
  "Get a single running process by PID (read-only).",
  getProcessShape,
  execGetProcess
)

// ---- search_processes -----------------------------------------------------

const searchProcessesShape = {
  name: z.string().min(1).describe("Process name substring (case-insensitive)."),
  limit: z.number().int().min(1).max(500).default(50).describe("Cap on rows returned."),
}

async function execSearchProcesses(args) {
  try {
    const all = await listAllProcesses()
    const needle = args.name.toLowerCase()
    const matches = all.filter((p) => p.name.toLowerCase().includes(needle))
    return toolText({
      query: args.name,
      total: matches.length,
      processes: matches.slice(0, args.limit).map(formatProcess),
    })
  } catch (err) {
    return toolError(err, "search_processes")
  }
}

export const searchProcessesTool = tool(
  "search_processes",
  "Find processes whose name contains the given substring (read-only).",
  searchProcessesShape,
  execSearchProcesses
)

// ---- top_memory_processes -------------------------------------------------

const topMemoryProcessesShape = {
  limit: z.number().int().min(1).max(100).default(10).describe("How many top processes to return."),
}

async function execTopMemoryProcesses(args) {
  try {
    const all = await listAllProcesses()
    const sorted = all
      .slice()
      .sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0))
      .slice(0, args.limit)
    return toolText({ processes: sorted.map(formatProcess) })
  } catch (err) {
    return toolError(err, "top_memory_processes")
  }
}

export const topMemoryProcessesTool = tool(
  "top_memory_processes",
  "Top N processes ranked by resident memory.",
  topMemoryProcessesShape,
  execTopMemoryProcesses
)

// ---- check_program_allowed -----------------------------------------------

const checkProgramAllowedShape = {
  program: z.string().min(1).describe("Program name (path basename)."),
}

function isProgramAllowed(name) {
  const lc = String(name)
    .toLowerCase()
    .replace(/\.exe$/i, "")
  if (BLOCKED_COMMANDS.has(lc)) return false
  return ALLOWED_COMMANDS.has(lc)
}

async function execCheckProgramAllowed(args) {
  return toolText({
    program: args.program,
    allowed: isProgramAllowed(args.program),
  })
}

export const checkProgramAllowedTool = tool(
  "check_program_allowed",
  "Check whether a program is on the allowlist for start_process.",
  checkProgramAllowedShape,
  execCheckProgramAllowed
)

// ---- get_process_manager_status ------------------------------------------

const getProcessManagerStatusShape = {}

async function execGetProcessManagerStatus() {
  return toolText({
    enabled: true,
    trackedCount: trackedPids.size,
    trackedPids: [...trackedPids],
    platform: process.platform,
  })
}

export const getProcessManagerStatusTool = tool(
  "get_process_manager_status",
  "Report sidecar process-manager status: tracked PIDs and platform.",
  getProcessManagerStatusShape,
  execGetProcessManagerStatus
)

// ---- get_tracked_processes -----------------------------------------------

const getTrackedProcessesShape = {
  includeDetails: z.boolean().default(true).describe("Include process details for tracked PIDs."),
}

async function execGetTrackedProcesses(args) {
  if (trackedPids.size === 0 || !args.includeDetails) {
    return toolText({ trackedCount: trackedPids.size, trackedPids: [...trackedPids] })
  }
  try {
    const all = await listAllProcesses()
    const matched = all.filter((p) => trackedPids.has(p.pid)).map(formatProcess)
    return toolText({
      trackedCount: trackedPids.size,
      trackedPids: [...trackedPids],
      processes: matched,
    })
  } catch (err) {
    return toolError(err, "get_tracked_processes")
  }
}

export const getTrackedProcessesTool = tool(
  "get_tracked_processes",
  "List PIDs the agent has started this session, optionally with live details.",
  getTrackedProcessesShape,
  execGetTrackedProcesses
)

// ---- start_process --------------------------------------------------------

const startProcessShape = {
  program: z.string().min(1).describe("Program name (must be on the allowlist)."),
  args: z.array(z.string()).default([]).describe("Argv list (no shell expansion)."),
  cwd: z.string().optional().describe("Working directory."),
  detached: z.boolean().default(true).describe("Run detached (return immediately)."),
  timeoutSecs: z
    .number()
    .int()
    .min(1)
    .max(300)
    .default(30)
    .describe("Timeout in seconds (only relevant when detached=false)."),
}

async function execStartProcess(args) {
  try {
    if (!isProgramAllowed(args.program)) {
      return toolError(`program not on allowlist: ${args.program}`)
    }
    if (args.detached) {
      const { spawn } = await import("node:child_process")
      const child = spawn(args.program, args.args, {
        cwd: args.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
      child.unref()
      if (child.pid) trackedPids.add(child.pid)
      return toolText({ pid: child.pid ?? null, detached: true, program: args.program })
    }
    // Synchronous-ish: capture output up to timeout.
    const { stdout, stderr } = await execFileAsync(args.program, args.args, {
      cwd: args.cwd,
      timeout: args.timeoutSecs * 1000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    })
    return toolText({
      program: args.program,
      stdout: String(stdout),
      stderr: String(stderr),
      exitCode: 0,
    })
  } catch (err) {
    return toolError(err, "start_process")
  }
}

export const startProcessTool = tool(
  "start_process",
  "Start a process. Program must be on the allowlist. HIGH-RISK — requires user approval.",
  startProcessShape,
  execStartProcess
)

// ---- terminate_process ----------------------------------------------------

const terminateProcessShape = {
  pid: z.number().int().describe("PID of the target process."),
  force: z.boolean().default(false).describe("Send SIGKILL/TerminateProcess instead of SIGTERM."),
  allowUntracked: z
    .boolean()
    .default(false)
    .describe(
      "Allow killing processes the agent did NOT start. Default is false to avoid stomping on the user's work."
    ),
}

async function execTerminateProcess(args) {
  try {
    if (!trackedPids.has(args.pid) && !args.allowUntracked) {
      return toolError(
        `pid ${args.pid} was not started by this session — pass allowUntracked=true to override`
      )
    }
    const signal = args.force ? "SIGKILL" : "SIGTERM"
    process.kill(args.pid, signal)
    trackedPids.delete(args.pid)
    return toolText({ pid: args.pid, signal, terminated: true })
  } catch (err) {
    return toolError(err, "terminate_process")
  }
}

export const terminateProcessTool = tool(
  "terminate_process",
  "Terminate a process by PID. HIGH-RISK — requires user approval. Refuses untracked PIDs unless allowUntracked=true.",
  terminateProcessShape,
  execTerminateProcess
)

// ---- Exports --------------------------------------------------------------

export const processTools = [
  listProcessesTool,
  getProcessTool,
  searchProcessesTool,
  topMemoryProcessesTool,
  checkProgramAllowedTool,
  getProcessManagerStatusTool,
  getTrackedProcessesTool,
  startProcessTool,
  terminateProcessTool,
]

export const __testExports = {
  execListProcesses,
  execGetProcess,
  execSearchProcesses,
  execTopMemoryProcesses,
  execCheckProgramAllowed,
  execGetProcessManagerStatus,
  execGetTrackedProcesses,
  execStartProcess,
  execTerminateProcess,
  parsePosixPs,
  parseWindowsCsv,
  parseCsvRow,
  isProgramAllowed,
  formatProcess,
  trackedPids,
  pickField,
  compareBy,
}
