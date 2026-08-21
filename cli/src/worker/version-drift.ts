import fs from "node:fs"
import path from "node:path"

/**
 * Detect that the CLI on disk is newer than the CLI in this process.
 *
 * A worker daemon is meant to run for weeks. `npm i -g cognia-agent` swaps the
 * files under it without touching the running process, so a fleet quietly ends
 * up executing runs on last month's code. Node has no way to reload itself, so
 * the only honest fix is to exit and let the login service start the new copy —
 * and that must never happen mid-turn.
 */

export interface VersionDriftIo {
  existsSync?: (file: string) => boolean
  readFileSync?: (file: string) => string
}

/** Walk up from the entry script to the package that owns it. */
export function findPackageJson(scriptPath: string, io: VersionDriftIo = {}): string | null {
  const exists = io.existsSync ?? fs.existsSync
  let directory = path.dirname(path.resolve(scriptPath))
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(directory, "package.json")
    if (exists(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

export function installedVersion(scriptPath: string, io: VersionDriftIo = {}): string | null {
  const manifest = findPackageJson(scriptPath, io)
  if (!manifest) return null
  try {
    const raw = (io.readFileSync ?? ((file: string) => fs.readFileSync(file, "utf8")))(manifest)
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === "string" ? parsed.version : null
  } catch {
    // A package.json being rewritten by an in-flight npm install is unreadable
    // for a moment. Reporting "no drift" is right: the next poll sees the
    // finished file.
    return null
  }
}

export interface VersionDrift {
  drifted: boolean
  running: string
  installed: string | null
}

export function detectVersionDrift(
  runningVersion: string,
  scriptPath: string,
  io: VersionDriftIo = {}
): VersionDrift {
  const installed = installedVersion(scriptPath, io)
  return {
    drifted: installed !== null && installed !== runningVersion,
    running: runningVersion,
    installed,
  }
}

export interface DriftWatchOptions {
  runningVersion: string
  scriptPath: string
  intervalMs: number
  /** Turns currently in flight; the restart waits for this to reach zero. */
  activeTurns: () => number
  /** Called once, when a newer CLI is installed and the worker is quiescent. */
  onRestartReady: (drift: VersionDrift) => void
  io?: VersionDriftIo
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

/**
 * Poll for a newer installed CLI and signal a restart at the first idle moment.
 *
 * Returns a disposer. It fires `onRestartReady` at most once — the caller is
 * expected to unwind the connection, and firing again during that unwind would
 * race the shutdown it already started.
 */
export function watchVersionDrift(options: DriftWatchOptions): () => void {
  const start = options.setInterval ?? setInterval
  const stop = options.clearInterval ?? clearInterval
  let fired = false
  const timer = start(() => {
    if (fired) return
    const drift = detectVersionDrift(options.runningVersion, options.scriptPath, options.io)
    if (!drift.drifted) return
    // Restarting mid-turn would abandon a run the host has already leased to
    // this worker. Drift is not urgent; the next idle window is soon enough.
    if (options.activeTurns() > 0) return
    fired = true
    stop(timer)
    options.onRestartReady(drift)
  }, options.intervalMs)
  timer.unref?.()
  return () => stop(timer)
}
