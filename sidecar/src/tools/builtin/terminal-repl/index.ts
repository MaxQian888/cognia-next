import { sandboxedProcessTarget, sandboxedProcessEnv } from "../../../platform/process/exec.ts"
import type { ProcessSandboxScope } from "../../../platform/process/exec.ts"
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
// Security model — mirrors `src/tools/builtin/shell-advanced/` + `terminal-dock-tool` (now
// deleted):
//   * cwd must exist
//   * caller's `agentId` is recorded on each session; reads/writes filter
//     by it so an agent only addresses its own sessions
//   * output ring buffer capped at 256 KiB per session (drop oldest)
//   * idle GC: sessions with no write/read activity in 10 min are killed
//   * max 8 concurrent sessions per agent (back-pressure against runaways)

import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import { toolError, toolText } from "../../kernel/result.ts"
import type { ToolResult } from "../../kernel/result.ts"
import { tool, type ToolArgs } from "../../kernel/define.ts"

const OUTPUT_RING_BYTES = 256 * 1024
const IDLE_TIMEOUT_MS = 10 * 60 * 1000
const MAX_SESSIONS_PER_AGENT = 8

/** How a PTY reports its exit. */
export interface PtyExit {
  exitCode: number | null
  signal?: string | number | null
}

/** The slice of node-pty's `IPty` this module drives. */
export interface PtyProcess {
  write(data: string): void
  resize?(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string | Buffer) => void): unknown
  onExit?(listener: (exit: PtyExit) => void): unknown
}

export interface PtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string | undefined>
}

/** node-pty's module surface, or the Bun adapter below. */
export interface PtyModule {
  spawn(shell: string, args: string[], options: PtySpawnOptions): PtyProcess
}

/** The slice of Bun's runtime API the PTY adapter uses. */
export interface BunPtyRuntime {
  Terminal: unknown
  spawn(
    argv: string[],
    options: {
      cwd: string
      env: Record<string, string | undefined>
      terminal: {
        name: string
        cols: number
        rows: number
        data(terminal: unknown, data: Uint8Array | string): void
      }
    }
  ): {
    exited: Promise<number | null>
    terminal: { write(data: string): void; resize(cols: number, rows: number): void; close(): void }
    kill(signal?: string): void
  }
}

interface ReplSession {
  id: string
  agentId: string
  shell: string
  pty: PtyProcess
  buffer: Buffer
  truncated: boolean
  exited: boolean
  exitCode: number | null
  createdAt: number
  lastActivityAt: number
}

/** The host session the tools are bound to; model input cannot override it. */
export interface TerminalReplContext {
  sessionId?: string | undefined
  builtinProcessSandbox?: ProcessSandboxScope | undefined
}

/** Per-session in-memory state. */
const sessions = new Map<string, ReplSession>()

/**
 * Lazy node-pty loader. Returns null on failure so `spawn` can surface
 * a structured error. Cached so repeated spawns don't pay the dynamic
 * import every time.
 *
 * Exposed so the test harness can swap in a stub without touching the
 * native module loader.
 */
let cachedNodePty: PtyModule | null | undefined = undefined
let nodePtyLoadError: string | null = null

/** Repair the executable bit lost by some package archives before native spawn. */
export function prepareNodePtyHelper(
  packageRoot: string,
  platform: string = process.platform,
  arch: string = process.arch
): void {
  if (platform === "win32") return
  for (const directory of ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]) {
    const helper = path.join(packageRoot, directory, "spawn-helper")
    if (!fs.existsSync(helper)) continue
    const mode = fs.statSync(helper).mode
    if ((mode & 0o111) !== 0o111) {
      try {
        fs.chmodSync(helper, mode | 0o111)
      } catch (error) {
        throw new Error(
          `PTY helper is not executable: ${helper}. Reinstall node-pty or restore its executable permission. ${(error as Error).message}`
        )
      }
    }
  }
}

export function isBunPtyRuntime(runtime: unknown): runtime is BunPtyRuntime {
  const candidate = runtime as Partial<BunPtyRuntime> | null | undefined
  return typeof candidate?.Terminal === "function" && typeof candidate?.spawn === "function"
}

/** Adapt Bun's built-in PTY to the narrow node-pty surface used below. */
export function createBunPtyModule(runtime: BunPtyRuntime): PtyModule {
  return {
    spawn(shell, args, options) {
      let dataListener: ((data: string) => void) | null = null
      let exitListener: ((exit: PtyExit) => void) | null = null
      let settledExit: PtyExit | null = null
      const proc = runtime.spawn([shell, ...args], {
        cwd: options.cwd,
        env: options.env,
        terminal: {
          name: options.name,
          cols: options.cols,
          rows: options.rows,
          data(_terminal, data) {
            dataListener?.(Buffer.from(data).toString("utf8"))
          },
        },
      })
      void proc.exited.then((exitCode) => {
        settledExit = { exitCode, signal: null }
        exitListener?.(settledExit)
      })
      return {
        write(data) {
          proc.terminal.write(data)
        },
        resize(cols, rows) {
          proc.terminal.resize(cols, rows)
        },
        kill(signal) {
          proc.kill(signal)
          proc.terminal.close()
        },
        onData(listener) {
          dataListener = listener
          return { dispose: () => (dataListener = null) }
        },
        onExit(listener) {
          exitListener = listener
          if (settledExit) listener(settledExit)
          return { dispose: () => (exitListener = null) }
        },
      }
    },
  }
}

async function loadNodePty(): Promise<{ mod: PtyModule | null; error: string | null }> {
  if (cachedNodePty !== undefined) return { mod: cachedNodePty, error: nodePtyLoadError }
  const bun = (globalThis as { Bun?: unknown }).Bun
  if (isBunPtyRuntime(bun)) {
    cachedNodePty = createBunPtyModule(bun)
    nodePtyLoadError = null
    return { mod: cachedNodePty, error: null }
  }
  try {
    const require = createRequire(import.meta.url)
    prepareNodePtyHelper(path.dirname(require.resolve("node-pty/package.json")))
    // node-pty's own IPty is wider than the slice this module drives.
    cachedNodePty = (await import("node-pty")) as unknown as PtyModule
    nodePtyLoadError = null
  } catch (err) {
    cachedNodePty = null
    nodePtyLoadError = err instanceof Error ? err.message : String(err)
  }
  return { mod: cachedNodePty, error: nodePtyLoadError }
}

export function __setNodePtyForTesting(
  mod: PtyModule | null | undefined,
  error: string | null = null
) {
  cachedNodePty = mod
  nodePtyLoadError = error
}

function appendToRing(session: ReplSession, chunk: Buffer): void {
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

function ensureOwner(
  session: ReplSession | undefined,
  agentId: string
): { ok: true; session: ReplSession } | { ok: false; reason: string } {
  if (!session) return { ok: false, reason: "unknown session" }
  if (session.agentId !== agentId) return { ok: false, reason: "session belongs to another agent" }
  return { ok: true, session }
}

function countSessionsForAgent(agentId: string): number {
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
function reapIdleSessions(now: number = Date.now()): void {
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
  cols: z.number().int().min(20).max(500).default(80).describe("Terminal width in columns."),
  rows: z.number().int().min(5).max(200).default(24).describe("Terminal height in rows."),
}

// Shared identity params for the write/read/kill actions — these reach the
// model via the JSON schema, so the guidance lives in `.describe()` (a JS
// comment would be invisible to the model).
const ownerAgentIdParam = z
  .string()
  .min(1)
  .describe("Caller identity — must match the agentId that spawned the session.")
const sessionIdParam = z.string().min(1).describe("The sessionId returned by terminal_repl_spawn.")

/** `extra` is a {@link TerminalReplContext}, or the SDK tool context for the static tools. */
async function execSpawn(args: ToolArgs<typeof spawnShape>, extra: unknown = {}) {
  const ctx = (extra ?? {}) as TerminalReplContext
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

  let pty: PtyProcess
  try {
    const target = sandboxedProcessTarget(
      args.shell,
      args.args ?? [],
      args.cwd,
      ctx.builtinProcessSandbox
    )
    pty = mod.spawn(target.command, target.args, {
      name: "xterm-color",
      cols: args.cols,
      rows: args.rows,
      cwd: args.cwd,
      env: sandboxedProcessEnv(process.env, ctx.builtinProcessSandbox, args.env),
    })
  } catch (err) {
    return toolError(
      `node-pty spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      "terminal_repl_spawn"
    )
  }

  const id = randomUUID()
  const now = Date.now()
  const session: ReplSession = {
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

  pty.onData((data: string | Buffer) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8")
    appendToRing(session, chunk)
    session.lastActivityAt = Date.now()
  })
  pty.onExit?.(({ exitCode, signal }: PtyExit) => {
    session.exited = true
    session.exitCode = typeof exitCode === "number" ? exitCode : null
    // Track signal in the buffer footer so callers reading after exit
    // see a hint as to why the REPL died.
    if (signal) {
      appendToRing(session, Buffer.from(`\n[terminal_repl exit: signal ${signal}]\n`))
    }
    session.lastActivityAt = Date.now()
  })

  return toolText({ sessionId: id, shell: args.shell })
}

const writeShape = {
  agentId: ownerAgentIdParam,
  sessionId: sessionIdParam,
  data: z.string().describe("Bytes to write to PTY stdin. Append `\\n` to submit a command."),
}

async function execWrite(args: ToolArgs<typeof writeShape>) {
  reapIdleSessions()
  const owns = ensureOwner(sessions.get(args.sessionId), args.agentId)
  if (!owns.ok) return toolError(owns.reason, "terminal_repl_write")
  const { session } = owns
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
  return toolText({ ok: true })
}

const readShape = {
  agentId: ownerAgentIdParam,
  sessionId: sessionIdParam,
  drain: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), clear the output ring after returning it so successive reads return only new bytes. Pass false for an idempotent peek."
    ),
  maxBytes: z
    .number()
    .int()
    .min(256)
    .max(OUTPUT_RING_BYTES)
    .default(OUTPUT_RING_BYTES)
    .describe("Max bytes to return (most-recent). The ring buffer caps at 256 KiB."),
}

async function execRead(args: ToolArgs<typeof readShape>) {
  reapIdleSessions()
  const owns = ensureOwner(sessions.get(args.sessionId), args.agentId)
  if (!owns.ok) return toolError(owns.reason, "terminal_repl_read")
  const { session } = owns
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
  return toolText({
    data: out,
    truncated,
    exited: session.exited,
    exitCode: session.exitCode,
  })
}

const killShape = {
  agentId: ownerAgentIdParam,
  sessionId: sessionIdParam,
  signal: z
    .string()
    .optional()
    .describe('POSIX signal name to send, e.g. "SIGTERM" (Unix only; ignored on Windows).'),
}

async function execKill(args: ToolArgs<typeof killShape>) {
  reapIdleSessions()
  const owns = ensureOwner(sessions.get(args.sessionId), args.agentId)
  if (!owns.ok) return toolError(owns.reason, "terminal_repl_kill")
  const { session } = owns
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
  return toolText({ ok: true, exitCode: session.exitCode })
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

/** Bind terminal ownership and confinement to the host session, not model input. */
export function createTerminalReplTools(ctx: TerminalReplContext = {}) {
  // Each handler takes its own tool's parsed arguments, in the same order as
  // terminalReplTools.
  const handlers = [execSpawn, execWrite, execRead, execKill] as ((
    args: Record<string, unknown>,
    extra?: unknown
  ) => Promise<ToolResult>)[]
  return terminalReplTools.map((definition, index) => ({
    ...definition,
    handler: (args: Record<string, unknown>) =>
      handlers[index]!(ctx.sessionId ? { ...args, agentId: ctx.sessionId } : args, ctx),
  }))
}

export function disposeTerminalRepls(agentId: string): void {
  for (const [id, session] of sessions) {
    if (session.agentId !== agentId) continue
    try {
      session.pty.kill()
    } catch {
      /* already exited */
    }
    sessions.delete(id)
  }
}

// Test-only helpers — used by `index.test.ts`.
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
