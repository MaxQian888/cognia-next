// Session-scoped registry of background shells started by `bash` with
// `run_in_background: true`. Mirrors the tracked-PID discipline in
// `process.mjs`: the agent can only read/kill shells IT started this session,
// and the dispatch layer calls `killAll()` at session teardown so no
// background process outlives the chat session (no orphans).
//
// Output is held in a per-shell ring buffer (≤256 KB, oldest bytes dropped);
// `read()` is a NON-destructive incremental read — it returns only the bytes
// appended since the previous poll (Claude Code's BashOutput semantics) and
// advances a cursor, so repeated polls don't re-show old output.

import { spawn } from "node:child_process"

import { pickStreamDecoder } from "../shared/console-decode.mjs"
import { randomUUID } from "node:crypto"

/** Max bytes of combined stdout+stderr retained per background shell. */
export const MAX_RING_BYTES = 256 * 1024

/**
 * @typedef {Object} BgShellEntry
 * @property {string} id
 * @property {string} command
 * @property {import("node:child_process").ChildProcess} child
 * @property {string} buffer    Combined stdout+stderr ring buffer.
 * @property {number} cursor    Bytes already returned via read().
 * @property {"running"|"exited"} status
 * @property {number|null} exitCode
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {string|undefined} cwd
 * @property {Set<() => void>} waiters
 */

/**
 * Create a fresh per-session background-shell registry.
 * @returns {{
 *   spawnBackground: (opts: { command: string, shell: string, shellArgs: string[], cwd?: string, isWin?: boolean, env?: NodeJS.ProcessEnv }) => BgShellEntry,
 *   read: (id: string, opts?: { filter?: string, maxChars?: number }) => ({ ok: true, data: string, status: string, exitCode: number|null } | { ok: false, reason: string }),
 *   waitForOutput: (id: string, opts?: { filter?: string, maxChars?: number, waitMs?: number }) => Promise<{ ok: true, data: string, status: string, exitCode: number|null } | { ok: false, reason: string }>,
 *   kill: (id: string, signal?: string) => ({ ok: true, exitCode: number|null } | { ok: false, reason: string }),
 *   killAll: () => void,
 *   list: () => Array<{ id: string, command: string, status: string, exitCode: number|null }>,
 * }}
 */
export function createBgShellRegistry() {
  /** @type {Map<string, BgShellEntry>} */
  const shells = new Map()

  function spawnBackground({ command, shell, shellArgs, cwd, isWin, env }) {
    const id = randomUUID()
    const child = spawn(shell, shellArgs, {
      cwd,
      // `env` carries the PowerShell-scrubbed environment when bash.mjs supplies
      // it; undefined (legacy callers / tests) inherits the parent process env.
      ...(env ? { env } : {}),
      windowsHide: true,
      windowsVerbatimArguments: Boolean(isWin),
      stdio: ["ignore", "pipe", "pipe"],
    })
    /** @type {BgShellEntry} */
    const entry = {
      id,
      command,
      child,
      buffer: "",
      cursor: 0,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      cwd,
      waiters: new Set(),
    }
    const notifyWaiters = () => {
      for (const wake of [...entry.waiters]) wake()
    }
    // Decode bytes auto-detecting the console encoding (UTF-8, or the OEM code
    // page on Windows). One streaming decoder per shell, picked from the first
    // chunk, so multibyte chars split across chunks decode intact. Error strings
    // arrive already-decoded and pass straight through.
    let decoder = null
    const cap = (chunk) => {
      let s
      if (typeof chunk === "string") {
        s = chunk
      } else {
        if (!decoder) decoder = pickStreamDecoder(chunk)
        s = decoder.decode(chunk, { stream: true })
      }
      if (!s) return
      entry.buffer += s
      if (entry.buffer.length > MAX_RING_BYTES) {
        const drop = entry.buffer.length - MAX_RING_BYTES
        entry.buffer = entry.buffer.slice(drop)
        // Keep the cursor anchored to surviving bytes so the next read()
        // returns a clean delta rather than re-emitting shifted output.
        entry.cursor = Math.max(0, entry.cursor - drop)
      }
      notifyWaiters()
    }
    child.stdout?.on("data", cap)
    child.stderr?.on("data", cap)
    child.on("error", (err) => {
      cap(String(err?.message ?? err))
      if (entry.status !== "exited") {
        entry.status = "exited"
        entry.exitCode = entry.exitCode ?? null
        entry.endedAt = Date.now()
        notifyWaiters()
      }
    })
    child.on("close", (code) => {
      if (decoder) cap(decoder.decode())
      entry.status = "exited"
      entry.exitCode = code
      entry.endedAt = Date.now()
      notifyWaiters()
    })
    shells.set(id, entry)
    return entry
  }

  function read(id, { filter, maxChars } = {}) {
    const entry = shells.get(id)
    if (!entry) return { ok: false, reason: "not_found" }
    const cap = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : undefined
    const end = cap ? Math.min(entry.buffer.length, entry.cursor + cap) : entry.buffer.length
    let delta = entry.buffer.slice(entry.cursor, end)
    entry.cursor = end
    if (filter && delta) {
      try {
        const re = new RegExp(filter)
        delta = delta
          .split("\n")
          .filter((line) => re.test(line))
          .join("\n")
      } catch {
        // Invalid regex — ignore the filter and return the raw delta.
      }
    }
    return { ok: true, data: delta, status: entry.status, exitCode: entry.exitCode }
  }

  async function waitForOutput(id, { filter, maxChars, waitMs = 0 } = {}) {
    const immediate = read(id, { filter, maxChars })
    if (!immediate.ok || immediate.data || immediate.status === "exited" || waitMs <= 0) {
      return immediate
    }
    const entry = shells.get(id)
    if (!entry) return { ok: false, reason: "not_found" }
    const boundedWait = Math.min(Math.max(0, Math.floor(waitMs)), 30_000)
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        entry.waiters.delete(finish)
        resolve(read(id, { filter, maxChars }))
      }
      const timer = setTimeout(finish, boundedWait)
      entry.waiters.add(finish)
      // Close/output may have landed between the immediate read and waiter
      // registration. Re-check once to avoid sleeping through that race.
      if (entry.status === "exited" || entry.buffer.length > entry.cursor) finish()
    })
  }

  function kill(id, signal) {
    const entry = shells.get(id)
    if (!entry) return { ok: false, reason: "not_found" }
    if (entry.status !== "exited") {
      try {
        entry.child.kill(signal || undefined)
      } catch {
        // Already gone — idempotent.
      }
    }
    return { ok: true, exitCode: entry.exitCode }
  }

  function killAll() {
    for (const entry of shells.values()) {
      if (entry.status !== "exited") {
        try {
          entry.child.kill()
        } catch {
          // best effort
        }
      }
    }
    shells.clear()
  }

  function list() {
    return [...shells.values()].map((e) => ({
      id: e.id,
      command: e.command,
      status: e.status,
      exitCode: e.exitCode,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      durationMs: Math.max(0, (e.endedAt ?? Date.now()) - e.startedAt),
      cwd: e.cwd,
    }))
  }

  return { spawnBackground, read, waitForOutput, kill, killAll, list }
}
