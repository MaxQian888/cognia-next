#!/usr/bin/env node
/**
 * Free a TCP port before `tauri dev` starts, so Next.js lands on a deterministic
 * port that matches Tauri's static `devUrl`.
 *
 * The problem: `tauri.conf.json` pins `devUrl` to http://localhost:3000, but
 * `next dev` silently auto-increments to 3001+ when 3000 is already in use
 * (Next has no Vite-style `--strictPort`). Tauri then waits on — and loads —
 * the wrong port, leaving a blank or stale window. The stale occupier is almost
 * always a `next dev` from a previous session that did not exit cleanly.
 *
 * This kills whatever is LISTENING on the port, then `next dev -p <port>` can
 * reclaim it. It must NEVER abort dev startup: every failure is swallowed and
 * the process always exits 0 (if the port is already free, or the platform
 * tooling is missing, we just move on).
 *
 * Usage:
 *   node scripts/dev/free-port.mjs            # frees 3000
 *   node scripts/dev/free-port.mjs 4000       # frees 4000
 */

import { execSync } from "node:child_process"

/** Parse `lsof -ti` output (one PID per line) into a unique numeric PID list. */
export function parseUnixPids(stdout) {
  return uniquePids(
    String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => Number.parseInt(line, 10))
  )
}

/**
 * Parse `netstat -ano -p tcp` output, returning PIDs of rows that are LISTENING
 * on `:port`. The local-address column ends with `:<port>` and the PID is the
 * last whitespace-separated token.
 */
export function parseWindowsPids(stdout, port) {
  const suffix = `:${port}`
  return uniquePids(
    String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes("LISTENING"))
      .map((line) => line.split(/\s+/))
      .filter((cols) => cols.length >= 2 && (cols[1] ?? "").endsWith(suffix))
      .map((cols) => Number.parseInt(cols[cols.length - 1], 10))
  )
}

/**
 * Parse `ss -lptnH` output, returning every PID it reports. `ss` embeds the
 * owner as `users:(("next-server",pid=1234,fd=23))`; a single row may list
 * several processes. Used as the Linux fallback when `lsof` is absent.
 */
export function parseSsPids(stdout) {
  const pids = []
  const re = /pid=(\d+)/g
  let match
  while ((match = re.exec(String(stdout))) !== null) {
    pids.push(Number.parseInt(match[1], 10))
  }
  return uniquePids(pids)
}

/**
 * Parse `fuser <port>/tcp` output: a space-separated PID list (the `<port>/tcp:`
 * label is printed to stderr, which we drop). Last-ditch Linux fallback.
 */
export function parseFuserPids(stdout) {
  return uniquePids(
    String(stdout)
      .replace(/\d+\/tcp:?/g, " ")
      .split(/\s+/)
      .map((token) => Number.parseInt(token, 10))
  )
}

function uniquePids(pids) {
  return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))]
}

/** Default runner: execute a command, returning stdout; "" on any failure. */
function defaultExec(command) {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString()
  } catch {
    return ""
  }
}

/** Default killer: SIGKILL on POSIX, `taskkill /F` on Windows. Never throws. */
function defaultKill(pid, platform) {
  try {
    if (platform === "win32") {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" })
    } else {
      process.kill(pid, "SIGKILL")
    }
  } catch {
    /* process already gone, or not ours — ignore */
  }
}

/**
 * List PIDs currently LISTENING on `port` for the given platform.
 *
 * Windows uses `netstat`. POSIX prefers `lsof` (present on macOS and most
 * Linux), but minimal Linux environments (containers, CI images) often ship
 * without it, so we cascade `lsof → ss → fuser` and return the first tool that
 * yields any PID. Each tool is tried independently; a missing binary just
 * produces empty output via `defaultExec` and we fall through.
 */
export function findListenerPids(port, { platform = process.platform, exec = defaultExec } = {}) {
  if (platform === "win32") {
    return parseWindowsPids(exec("netstat -ano -p tcp"), port)
  }
  // -t = terse (PID only), restrict to LISTEN sockets.
  const viaLsof = parseUnixPids(exec(`lsof -ti tcp:${port} -sTCP:LISTEN`))
  if (viaLsof.length > 0) return viaLsof
  const viaSs = parseSsPids(exec(`ss -lptnH sport = :${port}`))
  if (viaSs.length > 0) return viaSs
  return parseFuserPids(exec(`fuser ${port}/tcp 2>&1`))
}

/**
 * Kill every listener on `port`. Returns `{ killed: number[] }`. Pure-ish: all
 * side effects go through injectable `exec`/`kill`, so tests never touch real
 * processes. Never throws.
 */
export function freePort(
  port,
  { platform = process.platform, exec = defaultExec, kill = defaultKill, log = console.log } = {}
) {
  const pids = findListenerPids(port, { platform, exec })
  if (pids.length === 0) {
    log(`[free-port] :${port} is free.`)
    return { killed: [] }
  }
  for (const pid of pids) kill(pid, platform)
  log(`[free-port] killed ${pids.length} stale listener(s) on :${port} (pid ${pids.join(", ")}).`)
  return { killed: pids }
}

// Run only when invoked directly, not when imported by the test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.argv[2] ?? "3000", 10) || 3000
  try {
    freePort(port)
  } catch (error) {
    // Defensive: dev startup must never be blocked by this guard.
    console.warn(`[free-port] skipped (${error?.message ?? error}).`)
  }
  process.exit(0)
}
