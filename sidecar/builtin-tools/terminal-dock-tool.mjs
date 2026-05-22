// terminal-dock-tool — agent-facing dock terminal MCP tool.
//
// Surface: 4 actions (spawn / write / read_recent / wait_for_exit) keyed by
// session ids that this MCP tool owns. The tool maintains in-sidecar
// child_process state — these are NOT the same processes as the visual
// dock's xterm-bound PTYs in the renderer. Wiring the agent's sessions
// into the renderer's dock requires a renderer↔sidecar IPC contract
// (`plugin_tool_exec`-style) that lives outside this file. The user
// settings flag `terminal.exposeDockToAgents` gates registration — when
// off (default), this tool is not surfaced to the agent at all.
//
// Why child_process and not node-pty: keeping sidecar dependency-light.
// Most agent shell use is "run a command and read the output", which
// `spawn` covers cleanly. Persistent interactive PTY sessions can be
// added later via node-pty if the use case justifies the native
// dependency.
//
// Security model — mirrors `shell-advanced.mjs`:
//   * 5-minute hard timeout per command
//   * 64 KB output cap
//   * cwd must exist
//   * caller's `agentId` is recorded on each session; reads/writes
//     filter by it so an agent can only address its own sessions.

import { spawn } from "node:child_process"
import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "./safety.mjs"

const MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 30 * 1000
const MAX_TIMEOUT_MS = 5 * 60 * 1000

/** Per-session in-memory state. `cmd` arrays hold completed runs. */
const sessions = new Map()

function getSession(id) {
  return sessions.get(id) ?? null
}

function newSession({ agentId, shell, cwd, env }) {
  const id = randomUUID()
  sessions.set(id, {
    id,
    agentId,
    shell,
    cwd,
    env: env ?? {},
    history: [], // [{cmd, exitCode, stdout, stderr, endedAt}]
    createdAt: Date.now(),
  })
  return id
}

function ensureOwner(session, agentId) {
  if (!session) return { ok: false, reason: "unknown session" }
  if (session.agentId !== agentId) return { ok: false, reason: "session belongs to another agent" }
  return { ok: true }
}

/**
 * Build the argv flags for a one-shot `<shell> <flag> "<command>"` run.
 * Different shells take different "-c"-style switches.
 */
function buildShellArgs(shell, command) {
  const stem = (shell || "").toLowerCase()
  // Match by suffix so a full path or just the binary name both work.
  if (stem.endsWith("pwsh") || stem.endsWith("pwsh.exe"))
    return ["-NoLogo", "-NoProfile", "-Command", command]
  if (stem.endsWith("powershell") || stem.endsWith("powershell.exe"))
    return ["-NoLogo", "-NoProfile", "-Command", command]
  if (stem.endsWith("cmd") || stem.endsWith("cmd.exe")) return ["/c", command]
  // bash, zsh, sh, dash, fish all accept `-lc` for an interactive-flavored one-shot.
  return ["-lc", command]
}

/**
 * Run a command in a session — short-lived child_process per call.
 * The session itself is just a logical bag of (cwd, env, history).
 */
function runOnce({ session, command, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(session.shell, buildShellArgs(session.shell, command), {
      cwd: session.cwd,
      env: { ...process.env, ...session.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdoutBuf = Buffer.alloc(0)
    let stderrBuf = Buffer.alloc(0)
    let truncated = false

    const append = (which, chunk) => {
      const max = MAX_OUTPUT_BYTES
      const buf = which === "out" ? stdoutBuf : stderrBuf
      if (buf.length >= max) {
        truncated = true
        return
      }
      const room = max - buf.length
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
      const merged = Buffer.concat([buf, slice])
      if (chunk.length > room) truncated = true
      if (which === "out") stdoutBuf = merged
      else stderrBuf = merged
    }

    child.stdout?.on("data", (c) => append("out", c))
    child.stderr?.on("data", (c) => append("err", c))

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM")
      } catch {
        // ignore
      }
    }, timeoutMs)

    child.on("close", (code, signal) => {
      clearTimeout(timeout)
      const record = {
        cmd: command,
        exitCode: code,
        signal,
        stdout: stdoutBuf.toString("utf8"),
        stderr: stderrBuf.toString("utf8"),
        truncated,
        endedAt: Date.now(),
      }
      session.history.push(record)
      // Keep only the last 50 records.
      if (session.history.length > 50) session.history.splice(0, session.history.length - 50)
      resolve(record)
    })

    child.on("error", (err) => {
      clearTimeout(timeout)
      resolve({
        cmd: command,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: String(err?.message ?? err),
        truncated: false,
        endedAt: Date.now(),
      })
    })
  })
}

const spawnShape = {
  agentId: z
    .string()
    .min(1)
    .describe("Caller identity. Sessions filter on this — agent only sees its own."),
  shell: z
    .string()
    .min(1)
    .default(process.platform === "win32" ? "pwsh.exe" : "/bin/bash")
    .describe("Shell binary. Defaults to platform shell."),
  cwd: z.string().min(1).describe("Working directory. Must exist."),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Extra env vars to merge into the child env."),
}

async function execSpawn(args) {
  if (!fs.existsSync(args.cwd)) {
    return toolError(`cwd does not exist: ${args.cwd}`, "terminal_dock_spawn")
  }
  const id = newSession({
    agentId: args.agentId,
    shell: args.shell,
    cwd: args.cwd,
    env: args.env,
  })
  return toolText(JSON.stringify({ sessionId: id }))
}

const terminal_dock_spawn = tool(
  "terminal_dock_spawn",
  "Create a new agent-owned dock-like terminal session. Returns the session id.",
  spawnShape,
  execSpawn
)

const runShape = {
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
}

async function execWrite(args) {
  const session = getSession(args.sessionId)
  const owns = ensureOwner(session, args.agentId)
  if (!owns.ok) return toolError(owns.reason, "terminal_dock_write")
  const result = await runOnce({
    session,
    command: args.command,
    timeoutMs: args.timeoutMs,
  })
  return toolText(JSON.stringify(result))
}

const terminal_dock_write = tool(
  "terminal_dock_write",
  "Run a command in the named session and wait for it to finish. Output is capped at 64 KB.",
  runShape,
  execWrite
)

const readShape = {
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  lineLimit: z.number().int().min(1).max(50).default(10),
}

async function execReadRecent(args) {
  const session = getSession(args.sessionId)
  const owns = ensureOwner(session, args.agentId)
  if (!owns.ok) return toolError(owns.reason, "terminal_dock_read_recent")
  const recent = session.history.slice(-args.lineLimit)
  return toolText(JSON.stringify(recent))
}

const terminal_dock_read_recent = tool(
  "terminal_dock_read_recent",
  "Return the last N command records for the session (cmd, exitCode, stdout/stderr).",
  readShape,
  execReadRecent
)

const waitShape = {
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  /** Future hook for long-poll on async commands; currently no-op since runOnce is sync. */
  timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
}

async function execWaitForExit(args) {
  const session = getSession(args.sessionId)
  const owns = ensureOwner(session, args.agentId)
  if (!owns.ok) return toolError(owns.reason, "terminal_dock_wait_for_exit")
  const last = session.history[session.history.length - 1]
  if (!last) return toolText(JSON.stringify({ pending: true }))
  return toolText(JSON.stringify(last))
}

const terminal_dock_wait_for_exit = tool(
  "terminal_dock_wait_for_exit",
  "Wait for the most-recent command in the session to finish. Currently runs synchronously inside dock_write; this action exists for API symmetry and future async modes.",
  waitShape,
  execWaitForExit
)

export const terminalDockTools = Object.freeze([
  terminal_dock_spawn,
  terminal_dock_write,
  terminal_dock_read_recent,
  terminal_dock_wait_for_exit,
])

// Test-only helpers — used by `terminal-dock-tool.test.mjs`.
export const __testExports = {
  execSpawn,
  execWrite,
  execReadRecent,
  execWaitForExit,
  reset: () => sessions.clear(),
  sessions,
}
