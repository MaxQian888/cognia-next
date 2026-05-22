// terminal-repl-tool — agent-facing interactive REPL MCP tool.
//
// Wave 1 (orthogonal to dock-relay). Where `terminal_dock_*` ride
// `plugin_tool_exec` to drive the user's *visible* PTY in the renderer
// (`lib/terminal/dock-tool-handler.ts`), `terminal_repl_*` live entirely
// in the sidecar and back a *private* persistent PTY via `node-pty`.
// Use case: python / claude-code / sql REPLs where the agent expects to
// hold state across multiple write/read turns.
//
// Surface (4 actions):
//   terminal_repl_spawn   — open a new PTY, return sessionId
//   terminal_repl_write   — push bytes to PTY stdin (non-blocking)
//   terminal_repl_read    — drain the in-memory output ring (since last read)
//   terminal_repl_kill    — signal-terminate the PTY
//
// Dependency model — node-pty is OPTIONAL. The sidecar runs in heterogeneous
// hosts (Windows without a C++ toolchain, headless CI). We require() it
// lazily inside `spawn`; on failure we return a clean structured error so
// the model sees "REPL unavailable" instead of an unhandled rejection.
//
// Security model — mirrors `shell-advanced.mjs` + `terminal-dock-tool` (now
// deleted):
//   * cwd must exist
//   * caller's `agentId` is recorded on each session; reads/writes filter
//     by it so an agent only addresses its own sessions
//   * output ring buffer capped at 256 KiB per session (drop oldest)
//   * idle GC: sessions with no write/read activity in 10 min are killed
//   * max 8 concurrent sessions per agent (back-pressure against runaways)

import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "./safety.mjs"

const OUTPUT_RING_BYTES = 256 * 1024
const IDLE_TIMEOUT_MS = 10 * 60 * 1000
const MAX_SESSIONS_PER_AGENT = 8

/**
 * Per-session in-memory state.
 * @type {Map<string, { id: string, agentId: string, shell: string, pty: any, buffer: Buffer, truncated: boolean, exited: boolean, exitCode: number|null, createdAt: number, lastActivityAt: number }>}
 */
const sessions = new Map()

/**
 * Lazy node-pty loader. Returns null on failure so `spawn` can surface
 * a structured error. Cached so repeated spawns don't pay the dynamic
 * import every time.
 *
 * Exposed so the test harness can swap in a stub without touching the
 * native module loader.
 */
let cachedNodePty = undefined
let nodePtyLoadError = null
async function loadNodePty() {
  if (cachedNodePty !== undefined) return { mod: cachedNodePty, error: nodePtyLoadError }
  try {
    cachedNodePty = await import("node-pty")
    nodePtyLoadError = null
  } catch (err) {
    cachedNodePty = null
    nodePtyLoadError = err instanceof Error ? err.message : String(err)
  }
  return { mod: cachedNodePty, error: nodePtyLoadError }
}

export function __setNodePtyForTesting(mod, error = null) {
  cachedNodePty = mod
  nodePtyLoadError = error
}

function appendToRing(session, chunk) {
  const max = OUTPUT_RING_BYTES
  if (session.buffer.length + chunk.length <= max) {
    session.buffer = Buffer.concat([session.buffer, chunk])
    return
  }
  // Keep the most-recent bytes — drop the oldest.
  const combined = Buffer.concat([session.buffer, chunk])
  session.buffer = combined.subarray(combined.length - max)
  session.truncated = true
}

function ensureOwner(session, agentId) {
  if (!session) return { ok: false, reason: "unknown session" }
  if (session.agentId !== agentId) return { ok: false, reason: "session belongs to another agent" }
  return { ok: true }
}

function countSessionsForAgent(agentId) {
  let n = 0
  for (const session of sessions.values()) {
    if (session.agentId === agentId && !session.exited) n++
  }
  return n
}

/**
 * Idle GC — invoked from every action. Kills sessions whose
 * lastActivityAt is older than IDLE_TIMEOUT_MS so abandoned REPLs don't
 * leak.
 */
function reapIdleSessions(now = Date.now()) {
  for (const session of sessions.values()) {
    if (session.exited) continue
    if (now - session.lastActivityAt < IDLE_TIMEOUT_MS) continue
    try {
      session.pty?.kill?.()
    } catch {
      // ignore
    }
    session.exited = true
    session.exitCode = null
  }
}

const spawnShape = {
  agentId: z
    .string()
    .min(1)
    .describe("Caller identity. Sessions filter on this — an agent only sees its own."),
  shell: z
    .string()
    .min(1)
    .describe("Interactive program to spawn (python / bash / pwsh / node …)."),
  args: z
    .array(z.string())
    .optional()
    .describe("Argv after the shell. E.g. ['-i'] for python interactive."),
  cwd: z.string().min(1).describe("Working directory. Must exist."),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Extra env vars to merge into the child env."),
  cols: z.number().int().min(20).max(500).default(80),
  rows: z.number().int().min(5).max(200).default(24),
}

async function execSpawn(args) {
  reapIdleSessions()
  if (!fs.existsSync(args.cwd)) {
    return toolError(`cwd does not exist: ${args.cwd}`, "terminal_repl_spawn")
  }
  if (countSessionsForAgent(args.agentId) >= MAX_SESSIONS_PER_AGENT) {
    return toolError(
      `agent has already reached the ${MAX_SESSIONS_PER_AGENT}-session limit; kill an old REPL first`,
      "terminal_repl_spawn"
    )
  }

  const { mod, error } = await loadNodePty()
  if (!mod) {
    return toolError(
      `node-pty is not available on this host (${error ?? "unknown error"}). Interactive REPLs require the native module.`,
      "terminal_repl_spawn"
    )
  }

  /** @type {any} */
  let pty
  try {
    pty = mod.spawn(args.shell, args.args ?? [], {
      name: "xterm-color",
      cols: args.cols,
      rows: args.rows,
      cwd: args.cwd,
      env: { ...process.env, ...(args.env ?? {}) },
    })
  } catch (err) {
    return toolError(
      `node-pty spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      "terminal_repl_spawn"
    )
  }

  const id = randomUUID()
  const now = Date.now()
  const session = {
    id,
    agentId: args.agentId,
    shell: args.shell,
    pty,
    buffer: Buffer.alloc(0),
    truncated: false,
    exited: false,
    exitCode: null,
    createdAt: now,
    lastActivityAt: now,
  }
  sessions.set(id, session)

  pty.onData((data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8")
    appendToRing(session, chunk)
    session.lastActivityAt = Date.now()
  })
  pty.onExit?.(({ exitCode, signal }) => {
    session.exited = true
    session.exitCode = typeof exitCode === "number" ? exitCode : null
    // Track signal in the buffer footer so callers reading after exit
    // see a hint as to why the REPL died.
    if (signal) {
      appendToRing(session, Buffer.from(`\n[terminal_repl exit: signal ${signal}]\n`))
    }
    session.lastActivityAt = Date.now()
  })

  return toolText(JSON.stringify({ sessionId: id, shell: args.shell }))
}

const writeShape = {
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  data: z.string().describe("Bytes to write to PTY stdin. Append `\\n` to submit a command."),
}

async function execWrite(args) {
  reapIdleSessions()
  const session = sessions.get(args.sessionId)
  const owns = ensureOwner(session, args.agentId)
  if (!owns.ok) return toolError(owns.reason, "terminal_repl_write")
  if (session.exited) {
    return toolError("session has exited", "terminal_repl_write")
  }
  try {
    session.pty.write(args.data)
    session.lastActivityAt = Date.now()
  } catch (err) {
    return toolError(
      `write failed: ${err instanceof Error ? err.message : String(err)}`,
      "terminal_repl_write"
    )
  }
  return toolText(JSON.stringify({ ok: true }))
}

const readShape = {
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  /**
   * When true, drain the in-memory ring buffer after returning it. Default
   * true — read is destructive so successive reads return only new bytes.
   * Pass false for an idempotent peek.
   */
  drain: z.boolean().default(true),
  /** Max bytes to return. The ring buffer caps at 256 KiB. */
  maxBytes: z.number().int().min(256).max(OUTPUT_RING_BYTES).default(OUTPUT_RING_BYTES),
}

async function execRead(args) {
  reapIdleSessions()
  const session = sessions.get(args.sessionId)
  const owns = ensureOwner(session, args.agentId)
  if (!owns.ok) return toolError(owns.reason, "terminal_repl_read")
  const slice =
    session.buffer.length <= args.maxBytes
      ? session.buffer
      : session.buffer.subarray(session.buffer.length - args.maxBytes)
  const out = slice.toString("utf8")
  const truncated = session.truncated || session.buffer.length > args.maxBytes
  if (args.drain) {
    session.buffer = Buffer.alloc(0)
    session.truncated = false
  }
  session.lastActivityAt = Date.now()
  return toolText(
    JSON.stringify({
      data: out,
      truncated,
      exited: session.exited,
      exitCode: session.exitCode,
    })
  )
}

const killShape = {
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  /** POSIX signal name (Unix). Ignored on Windows. */
  signal: z.string().optional(),
}

async function execKill(args) {
  reapIdleSessions()
  const session = sessions.get(args.sessionId)
  const owns = ensureOwner(session, args.agentId)
  if (!owns.ok) return toolError(owns.reason, "terminal_repl_kill")
  if (!session.exited) {
    try {
      session.pty.kill(args.signal)
    } catch (err) {
      return toolError(
        `kill failed: ${err instanceof Error ? err.message : String(err)}`,
        "terminal_repl_kill"
      )
    }
  }
  session.exited = true
  session.lastActivityAt = Date.now()
  return toolText(JSON.stringify({ ok: true, exitCode: session.exitCode }))
}

const terminal_repl_spawn = tool(
  "terminal_repl_spawn",
  "Open an interactive node-pty session backed by the named shell. Returns the sessionId. Use this for persistent REPLs (python, sql, claude-code, …) — for one-shot commands prefer the dock-relay path.",
  spawnShape,
  execSpawn
)

const terminal_repl_write = tool(
  "terminal_repl_write",
  "Write bytes into the PTY's stdin. Append `\\n` to submit a command. Non-blocking — read output with terminal_repl_read.",
  writeShape,
  execWrite
)

const terminal_repl_read = tool(
  "terminal_repl_read",
  "Read accumulated PTY output. Destructive by default (drain=true). Returns {data, truncated, exited, exitCode}.",
  readShape,
  execRead
)

const terminal_repl_kill = tool(
  "terminal_repl_kill",
  "Signal-terminate a REPL session. Idempotent; safe to call on already-exited sessions.",
  killShape,
  execKill
)

export const terminalReplTools = Object.freeze([
  terminal_repl_spawn,
  terminal_repl_write,
  terminal_repl_read,
  terminal_repl_kill,
])

// Test-only helpers — used by `terminal-repl-tool.test.mjs`.
export const __testExports = {
  execSpawn,
  execWrite,
  execRead,
  execKill,
  reset: () => sessions.clear(),
  sessions,
  reapIdleSessions,
  IDLE_TIMEOUT_MS,
  MAX_SESSIONS_PER_AGENT,
  OUTPUT_RING_BYTES,
}
