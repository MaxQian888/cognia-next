import fs from "node:fs"
import path from "node:path"
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"

import { connectWorker, type WorkerConnectOptions } from "./worker-connect"
import { detectVersionDrift, watchVersionDrift, type VersionDrift } from "./version-drift"
import {
  clearDaemonState,
  daemonPaths,
  defaultIsAlive,
  ensureDaemonRoot,
  normalizeProfile,
  readDaemonMeta,
  readDaemonStatus,
  writeDaemonMeta,
  type DaemonPaths,
  type DaemonStateIo,
  type DaemonStatus,
} from "./daemon-state"

/**
 * Process lifecycle for `cognia-agent worker`.
 *
 * `worker connect` maintains its own reconnect loop, so the connection was
 * never the fragile part — the *process* was. A worker started from a terminal
 * dies with that terminal, and a machine that quietly leaves the fleet still
 * shows as an enrolled host, so runs get placed on it and wait.
 */

/** How often a running daemon checks whether a newer CLI was installed under it. */
const DRIFT_POLL_MS = 10 * 60 * 1000
/** Grace period before a daemon that ignored SIGTERM is killed outright. */
const STOP_GRACE_MS = 10_000
const STOP_POLL_MS = 100
/** Rotate a daemon log once it passes this size; keep one previous generation. */
const MAX_LOG_BYTES = 8 * 1024 * 1024

export interface DaemonRuntimeIo {
  spawn?: typeof nodeSpawn
  isAlive?: (pid: number) => boolean
  kill?: (pid: number, signal: NodeJS.Signals) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  openLog?: (file: string) => number
  statSync?: (file: string) => { size: number }
  renameSync?: (from: string, to: string) => void
  existsSync?: (file: string) => boolean
  readFileSync?: (file: string) => string
  writeFileSync?: (file: string, data: string, options: { mode: number }) => void
  mkdirSync?: (dir: string, options: { recursive: true; mode: number }) => void
  rmSync?: (file: string, options: { force: true }) => void
  execPath?: string
  scriptPath?: string
  version?: string
  pid?: number
}

export interface StartDaemonOptions {
  home: string
  profile?: string
  /** Run the connection in this process instead of spawning a detached child. */
  foreground?: boolean
  connectOptions: Omit<WorkerConnectOptions, "signal">
  signal?: AbortSignal
  connect?: typeof connectWorker
  /**
   * Poll interval for the version-drift watcher. Zero disables it, which is
   * what a caller with no login service configured wants: exiting for a
   * restart nobody performs would just take the worker offline.
   */
  driftPollMs?: number
  onVersionRestart?: (drift: VersionDrift) => void
}

export interface StartDaemonResult {
  started: boolean
  alreadyRunning: boolean
  pid: number
  profile: string
  logFile: string
}

function runtime(io: DaemonRuntimeIo) {
  return {
    spawn: io.spawn ?? nodeSpawn,
    isAlive: io.isAlive ?? defaultIsAlive,
    kill: io.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal)),
    now: io.now ?? Date.now,
    sleep:
      io.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())),
    openLog: io.openLog ?? ((file: string) => fs.openSync(file, "a", 0o600)),
    statSync: io.statSync ?? ((file: string) => fs.statSync(file)),
    renameSync: io.renameSync ?? ((from: string, to: string) => fs.renameSync(from, to)),
    existsSync: io.existsSync ?? fs.existsSync,
    readFileSync: io.readFileSync ?? ((file: string) => fs.readFileSync(file, "utf8")),
    execPath: io.execPath ?? process.execPath,
    scriptPath: io.scriptPath ?? process.argv[1] ?? "",
    version: io.version ?? "unknown",
    pid: io.pid ?? process.pid,
  }
}

/**
 * The daemon-state half of `DaemonRuntimeIo`.
 *
 * The pidfile/meta helpers take their own `DaemonStateIo`, and passing them
 * nothing meant every injected `existsSync` / `readFileSync` / `writeFileSync`
 * / `mkdirSync` / `rmSync` stub was ignored and the real filesystem used —
 * while `readDaemonStatus` did forward `isAlive`, so the gap read as
 * intentional. Projecting once keeps the two seams in step.
 */
function stateIo(io: DaemonRuntimeIo): DaemonStateIo {
  return {
    ...(io.existsSync ? { existsSync: io.existsSync } : {}),
    ...(io.readFileSync ? { readFileSync: io.readFileSync } : {}),
    ...(io.writeFileSync ? { writeFileSync: io.writeFileSync } : {}),
    ...(io.mkdirSync ? { mkdirSync: io.mkdirSync } : {}),
    ...(io.rmSync ? { rmSync: io.rmSync } : {}),
    ...(io.isAlive ? { isAlive: io.isAlive } : {}),
  }
}

/**
 * Cap a daemon log before it is appended to.
 *
 * A long-lived worker writes a reconnect line per attempt; on a flaky network
 * that is unbounded growth on a machine nobody logs into. One previous
 * generation is kept so a crash's context survives the rotation that follows
 * it.
 */
export function rotateDaemonLog(file: string, io: DaemonRuntimeIo = {}): boolean {
  const rt = runtime(io)
  if (!rt.existsSync(file)) return false
  let size = 0
  try {
    size = rt.statSync(file).size
  } catch {
    return false
  }
  if (size <= MAX_LOG_BYTES) return false
  try {
    rt.renameSync(file, `${file}.1`)
    return true
  } catch {
    return false
  }
}

export async function startWorkerDaemon(
  options: StartDaemonOptions,
  io: DaemonRuntimeIo = {}
): Promise<StartDaemonResult> {
  const rt = runtime(io)
  const profile = normalizeProfile(options.profile)
  const paths = daemonPaths(options.home, profile)
  ensureDaemonRoot(paths, stateIo(io))

  const existing = readDaemonStatus(options.home, profile, {
    ...stateIo(io),
    isAlive: rt.isAlive,
  })
  if (existing.running) {
    return {
      started: false,
      alreadyRunning: true,
      pid: existing.pid ?? 0,
      profile,
      logFile: paths.logFile,
    }
  }
  // A stale pidfile from a crash must not block a restart.
  if (existing.stalePid !== undefined) clearDaemonState(paths, stateIo(io))

  if (options.foreground) {
    writeDaemonMeta(
      paths,
      {
        pid: rt.pid,
        profile,
        startedAt: rt.now(),
        argv: [rt.execPath, rt.scriptPath, "worker", "daemon", "start", "--foreground"],
        version: rt.version,
      },
      stateIo(io)
    )

    // The connection loop reconnects forever, so a version restart has to come
    // from outside it: the watcher aborts the loop at the first idle moment and
    // the login service brings the new code up (launchd `KeepAlive`, systemd
    // `Restart=always`). A Windows logon task does not restart within a
    // session, so there the new version lands at next logon — `daemon status`
    // reports the drift either way.
    const restart = new AbortController()
    const composed = composeSignals(options.signal, restart.signal)
    let activeTurns = () => 0
    const pollMs = options.driftPollMs ?? DRIFT_POLL_MS
    const stopDriftWatch =
      pollMs > 0
        ? watchVersionDrift({
            runningVersion: rt.version,
            scriptPath: rt.scriptPath,
            intervalMs: pollMs,
            activeTurns: () => activeTurns(),
            onRestartReady: (drift) => {
              options.onVersionRestart?.(drift)
              restart.abort()
            },
          })
        : () => undefined

    try {
      await (options.connect ?? connectWorker)({
        ...options.connectOptions,
        onRuntimeReady: (probe) => {
          activeTurns = () => probe.activeTurns()
        },
        signal: composed,
      })
    } finally {
      stopDriftWatch()
      clearDaemonState(paths, stateIo(io))
    }
    return { started: true, alreadyRunning: false, pid: rt.pid, profile, logFile: paths.logFile }
  }

  rotateDaemonLog(paths.logFile, io)
  rotateDaemonLog(paths.errorLogFile, io)
  const out = rt.openLog(paths.logFile)
  const err = rt.openLog(paths.errorLogFile)
  const child: ChildProcess = rt.spawn(
    rt.execPath,
    [rt.scriptPath, "worker", "daemon", "start", "--foreground", "--profile", profile],
    {
      // Detached + its own session: the daemon must outlive the shell that
      // launched it, which is the entire reason this command exists.
      detached: true,
      stdio: ["ignore", out, err],
    }
  )
  child.unref()
  const pid = child.pid ?? 0
  if (!pid) throw new Error("worker daemon did not start")
  // The child rewrites this record with its own metadata once it is up; writing
  // it here means `status` and `stop` work during the startup window too.
  writeDaemonMeta(
    paths,
    {
      pid,
      profile,
      startedAt: rt.now(),
      argv: [rt.execPath, rt.scriptPath, "worker", "daemon", "start", "--foreground"],
      version: rt.version,
    },
    stateIo(io)
  )
  return { started: true, alreadyRunning: false, pid, profile, logFile: paths.logFile }
}

export interface StopDaemonResult {
  stopped: boolean
  pid?: number
  profile: string
  /** True when the daemon had to be killed after ignoring SIGTERM. */
  forced?: boolean
}

export async function stopWorkerDaemon(
  home: string,
  profile: string | undefined,
  io: DaemonRuntimeIo = {}
): Promise<StopDaemonResult> {
  const rt = runtime(io)
  const normalized = normalizeProfile(profile)
  const paths = daemonPaths(home, normalized)
  const meta = readDaemonMeta(paths, stateIo(io))
  if (!meta) return { stopped: false, profile: normalized }
  if (!rt.isAlive(meta.pid)) {
    clearDaemonState(paths, stateIo(io))
    return { stopped: false, pid: meta.pid, profile: normalized }
  }

  rt.kill(meta.pid, "SIGTERM")
  const deadline = rt.now() + STOP_GRACE_MS
  while (rt.now() < deadline) {
    if (!rt.isAlive(meta.pid)) {
      clearDaemonState(paths, stateIo(io))
      return { stopped: true, pid: meta.pid, profile: normalized }
    }
    await rt.sleep(STOP_POLL_MS)
  }
  // A worker mid-turn can legitimately take a while to unwind, but it cannot
  // hold the profile forever — the next start would refuse to run.
  rt.kill(meta.pid, "SIGKILL")
  clearDaemonState(paths, stateIo(io))
  return { stopped: true, pid: meta.pid, profile: normalized, forced: true }
}

export interface WorkerDaemonStatus extends DaemonStatus {
  installedVersion?: string | null
  /** A newer CLI is on disk; the daemon restarts onto it at the next idle turn. */
  versionDrifted?: boolean
}

export function workerDaemonStatus(
  home: string,
  profile: string | undefined,
  io: DaemonRuntimeIo = {}
): WorkerDaemonStatus {
  const rt = runtime(io)
  const status = readDaemonStatus(home, profile, { ...stateIo(io), isAlive: rt.isAlive })
  if (!status.running || !status.version) return status
  const drift = detectVersionDrift(status.version, rt.scriptPath)
  return { ...status, installedVersion: drift.installed, versionDrifted: drift.drifted }
}

export interface LogReadResult {
  file: string
  lines: readonly string[]
}

export function readWorkerDaemonLog(
  home: string,
  profile: string | undefined,
  lines: number,
  io: DaemonRuntimeIo = {}
): LogReadResult {
  const rt = runtime(io)
  const paths = daemonPaths(home, profile)
  if (!rt.existsSync(paths.logFile)) return { file: paths.logFile, lines: [] }
  const content = rt.readFileSync(paths.logFile)
  const all = content.split("\n")
  if (all.at(-1) === "") all.pop()
  return { file: paths.logFile, lines: all.slice(Math.max(0, all.length - lines)) }
}

export interface DaemonGcResult {
  removedLogs: readonly string[]
  removedWorkspaces: readonly string[]
}

export interface DaemonGcIo {
  readdirSync?: (dir: string) => string[]
  statSync?: (file: string) => { mtimeMs: number; isDirectory(): boolean }
  rmSync?: (file: string, options: { force: true; recursive: true }) => void
  existsSync?: (file: string) => boolean
  now?: () => number
}

/** Depth and breadth ceiling for the freshness walk, so a pathological tree
 *  cannot turn a GC pass into a full-disk scan. */
const ACTIVITY_SCAN_MAX_DEPTH = 6
const ACTIVITY_SCAN_MAX_ENTRIES = 4_000

/**
 * Whether anything under `dir` has been touched since `cutoff`.
 *
 * A directory's own mtime only moves when entries are added or removed
 * DIRECTLY in it, so a checkout that a run has been editing for a week — files
 * rewritten in place, objects landing under `.git/` — still reports a week-old
 * mtime at the top. Reclaiming on that alone deletes the workspace out from
 * under the run executing in it, and `rm -rf` on POSIX succeeds against open
 * files, so nothing downstream catches it.
 *
 * The walk stops at the FIRST fresh entry, so the case that matters — a live
 * workspace — is also the cheap one. Anything unreadable counts as fresh: this
 * decides a deletion, and the safe answer to "I cannot tell" is to keep it.
 */
function hasActivitySince(
  dir: string,
  cutoff: number,
  io: {
    readdirSync: (dir: string) => string[]
    statSync: (file: string) => { mtimeMs: number; isDirectory(): boolean }
  },
  budget: { entries: number },
  depth = 0
): boolean {
  if (depth > ACTIVITY_SCAN_MAX_DEPTH) return true
  let entries: string[]
  try {
    entries = io.readdirSync(dir)
  } catch {
    return true
  }
  for (const entry of entries) {
    if (budget.entries-- <= 0) return true
    const child = path.join(dir, entry)
    let stat: { mtimeMs: number; isDirectory(): boolean }
    try {
      stat = io.statSync(child)
    } catch {
      return true
    }
    if (stat.mtimeMs > cutoff) return true
    if (stat.isDirectory() && hasActivitySince(child, cutoff, io, budget, depth + 1)) return true
  }
  return false
}

/**
 * Reclaim disk on a machine nobody logs into.
 *
 * Rotated logs and abandoned task workspaces are the two things a long-running
 * worker accumulates without bound. Both are keyed on mtime rather than on a
 * manifest, because the run that created a workspace may have died with the
 * process that would otherwise have cleaned it up — but for a workspace the
 * mtime that decides it is the newest one in the TREE, not the directory's own
 * (see {@link hasActivitySince}).
 */
export function collectWorkerDaemonGarbage(
  home: string,
  profile: string | undefined,
  options: { workspaceRoot?: string; ttlMs: number },
  io: DaemonGcIo = {}
): DaemonGcResult {
  const readdirSync = io.readdirSync ?? ((dir: string) => fs.readdirSync(dir))
  const statSync = io.statSync ?? ((file: string) => fs.statSync(file))
  const rmSync =
    io.rmSync ?? ((file: string, opts: { force: true; recursive: true }) => fs.rmSync(file, opts))
  const existsSync = io.existsSync ?? fs.existsSync
  const now = (io.now ?? Date.now)()
  const paths: DaemonPaths = daemonPaths(home, profile)
  const removedLogs: string[] = []
  const removedWorkspaces: string[] = []

  for (const rotated of [`${paths.logFile}.1`, `${paths.errorLogFile}.1`]) {
    if (!existsSync(rotated)) continue
    try {
      if (now - statSync(rotated).mtimeMs <= options.ttlMs) continue
      rmSync(rotated, { force: true, recursive: true })
      removedLogs.push(rotated)
    } catch {
      // A log we cannot stat or remove is not worth failing a GC pass over.
    }
  }

  const workspaceRoot = options.workspaceRoot
  if (workspaceRoot && existsSync(workspaceRoot)) {
    for (const entry of readdirSync(workspaceRoot)) {
      const candidate = path.join(workspaceRoot, entry)
      try {
        const stat = statSync(candidate)
        if (!stat.isDirectory()) continue
        if (now - stat.mtimeMs <= options.ttlMs) continue
        // The top-level mtime says "stale"; the tree is what decides. A run
        // editing files inside subdirectories never moves the mtime above.
        if (
          hasActivitySince(
            candidate,
            now - options.ttlMs,
            { readdirSync, statSync },
            {
              entries: ACTIVITY_SCAN_MAX_ENTRIES,
            }
          )
        ) {
          continue
        }
        rmSync(candidate, { force: true, recursive: true })
        removedWorkspaces.push(candidate)
      } catch {
        // A workspace we cannot stat or remove is not worth failing a pass over.
      }
    }
  }

  return { removedLogs, removedWorkspaces }
}

/**
 * One signal that aborts when either input does.
 *
 * The daemon has two independent reasons to stop — an operator signal and a
 * version restart — and `connectWorker` takes exactly one.
 */
function composeSignals(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (present.length === 1) return present[0]!
  const controller = new AbortController()
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true })
  }
  return controller.signal
}
