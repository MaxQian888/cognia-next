import fs from "node:fs"
import path from "node:path"

/**
 * On-disk lifecycle for a worker daemon.
 *
 * A worker is only useful when it is connected, and `worker connect` is a
 * foreground process: close the terminal and the machine silently leaves the
 * fleet. Nothing here supervises the connection itself — `connectWorker`
 * already reconnects with backoff — this owns the surrounding process: is one
 * running, which one, and where did it write its log.
 *
 * State lives under `<COGNIA_HOME>/worker/<profile>/` so several profiles can
 * point one machine at different hosts without fighting over a pidfile.
 */

export interface DaemonPaths {
  root: string
  pidFile: string
  logFile: string
  errorLogFile: string
  metaFile: string
}

export interface DaemonMeta {
  pid: number
  profile: string
  startedAt: number
  /** Argv of the process that was launched, for `status` and version drift. */
  argv: readonly string[]
  version: string
}

export interface DaemonStatus {
  running: boolean
  profile: string
  pid?: number
  startedAt?: number
  version?: string
  logFile: string
  /** Set when a pidfile was found but the process behind it is gone. */
  stalePid?: number
}

export interface DaemonStateIo {
  /** Narrower than `fs.existsSync` on purpose: every call site here passes a
   *  string, and the wide `PathLike` signature is not assignable from the
   *  `(file: string) => boolean` stubs `DaemonRuntimeIo` carries. */
  existsSync?: (file: string) => boolean
  readFileSync?: (file: string) => string
  writeFileSync?: (file: string, data: string, options: { mode: number }) => void
  mkdirSync?: (dir: string, options: { recursive: true; mode: number }) => void
  rmSync?: (file: string, options: { force: true }) => void
  /** Signal 0 probe. Returns false when the pid is gone or not ours. */
  isAlive?: (pid: number) => boolean
}

const DEFAULT_PROFILE = "default"

export function normalizeProfile(profile: string | undefined): string {
  const value = profile?.trim() || DEFAULT_PROFILE
  // The profile becomes a directory name; anything path-like would let a
  // `--profile ../..` escape the CLI home.
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error("--profile may only contain letters, digits, dot, dash, and underscore")
  }
  return value
}

export function daemonPaths(home: string, profile: string | undefined): DaemonPaths {
  const root = path.join(home, "worker", normalizeProfile(profile))
  return {
    root,
    pidFile: path.join(root, "daemon.pid"),
    logFile: path.join(root, "daemon.log"),
    errorLogFile: path.join(root, "daemon.err.log"),
    metaFile: path.join(root, "daemon.json"),
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything. ESRCH means gone; EPERM means alive but owned by someone else,
    // which for our purposes still means "do not start a second one".
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function ensureDaemonRoot(paths: DaemonPaths, io: DaemonStateIo = {}): void {
  // 0700: the log can contain host URLs and worker identity, and the pidfile
  // gates process control. Same posture as the enrolled device config.
  ;(io.mkdirSync ?? fs.mkdirSync)(paths.root, { recursive: true, mode: 0o700 })
}

export function readDaemonMeta(paths: DaemonPaths, io: DaemonStateIo = {}): DaemonMeta | null {
  const exists = io.existsSync ?? fs.existsSync
  if (!exists(paths.metaFile)) return null
  try {
    const raw = (io.readFileSync ?? ((file: string) => fs.readFileSync(file, "utf8")))(
      paths.metaFile
    )
    const parsed = JSON.parse(raw) as Partial<DaemonMeta>
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null
    return {
      pid: parsed.pid,
      profile: typeof parsed.profile === "string" ? parsed.profile : DEFAULT_PROFILE,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      argv: Array.isArray(parsed.argv) ? parsed.argv.map(String) : [],
      version: typeof parsed.version === "string" ? parsed.version : "unknown",
    }
  } catch {
    // A truncated record from a killed write must not brick `status`/`stop`.
    return null
  }
}

export function writeDaemonMeta(
  paths: DaemonPaths,
  meta: DaemonMeta,
  io: DaemonStateIo = {}
): void {
  const write =
    io.writeFileSync ??
    ((file: string, data: string, options: { mode: number }) =>
      fs.writeFileSync(file, data, { encoding: "utf8", mode: options.mode }))
  write(paths.metaFile, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 })
  write(paths.pidFile, `${meta.pid}\n`, { mode: 0o600 })
}

export function clearDaemonState(paths: DaemonPaths, io: DaemonStateIo = {}): void {
  const remove = io.rmSync ?? ((file: string, options: { force: true }) => fs.rmSync(file, options))
  remove(paths.pidFile, { force: true })
  remove(paths.metaFile, { force: true })
}

export function readDaemonStatus(
  home: string,
  profile: string | undefined,
  io: DaemonStateIo = {}
): DaemonStatus {
  const normalized = normalizeProfile(profile)
  const paths = daemonPaths(home, normalized)
  const meta = readDaemonMeta(paths, io)
  if (!meta) return { running: false, profile: normalized, logFile: paths.logFile }
  const alive = (io.isAlive ?? defaultIsAlive)(meta.pid)
  if (!alive) {
    // A crashed daemon leaves its pidfile behind. Reporting "running" off a
    // dead pid is how a fleet ends up with a machine everyone believes is
    // connected, so the stale record is surfaced instead of trusted.
    return {
      running: false,
      profile: normalized,
      logFile: paths.logFile,
      stalePid: meta.pid,
    }
  }
  return {
    running: true,
    profile: normalized,
    pid: meta.pid,
    startedAt: meta.startedAt,
    version: meta.version,
    logFile: paths.logFile,
  }
}

export { defaultIsAlive }
