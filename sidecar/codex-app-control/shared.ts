import { spawnSync } from "node:child_process"
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process"
import { accessSync, constants, realpathSync, statSync } from "node:fs"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const APP_PATH = "/Applications/ChatGPT.app"
export const APP_EXECUTABLE = `${APP_PATH}/Contents/MacOS/ChatGPT`
export const APP_BUNDLE_ID = "com.openai.codex"
export const DEFAULT_REAL_CLI =
  findBundledCodexCli(APP_PATH) ?? `${APP_PATH}/Contents/Resources/codex`
export const CDP_ONLY_RELAUNCH_LABEL_PREFIX = "com.cognia.codex-app-control.relaunch"

function bundledCodexCliPaths(appPath: string): string[] {
  const resources = join(resolve(appPath), "Contents", "Resources")
  return [
    join(resources, "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"),
    join(resources, "codex-cli", "bin", "codex"),
    join(resources, "codex"),
  ]
}

function executablePath(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null
    accessSync(path, constants.X_OK)
    return realpathSync(path)
  } catch {
    return null
  }
}

function findBundledCodexCli(appPath: string): string | null {
  for (const candidate of bundledCodexCliPaths(appPath)) {
    const executable = executablePath(candidate)
    if (executable) return executable
  }
  return null
}

/** Discover the bundled runtime across the current and legacy macOS App layouts. */
export function resolveCodexAppCli(appPath: string = APP_PATH, realCli?: string): string {
  if (realCli) {
    const executable = executablePath(resolve(realCli))
    if (executable) return executable
    throw new Error(`Codex CLI is missing or not executable: ${realCli}`)
  }
  const executable = findBundledCodexCli(appPath)
  if (executable) return executable
  throw new Error(`No executable bundled Codex CLI found in ${resolve(appPath)}`)
}

/**
 * The port the retired relay prototype listened on. Still validated so a CDP
 * port can never be configured onto it.
 */
const LEGACY_RELAY_PORT = 4318

/** This directory — the worker and launcher scripts are spawned from it by path. */
export function controlRoot(): string {
  return resolve(import.meta.dirname)
}

export function defaultStateDir(): string {
  return join(homedir(), ".cognia", "codex-app-control")
}

export interface ControlPaths {
  root: string
  cdpOnlyRelaunchResult: string
  cdpOnlyRelaunchStdout: string
  cdpOnlyRelaunchStderr: string
}

export function relayPaths(
  stateDir: string = process.env.CODEX_RELAY_STATE_DIR ?? defaultStateDir()
): ControlPaths {
  const root = resolve(stateDir)
  return {
    root,
    cdpOnlyRelaunchResult: join(root, "cdp-only-relaunch-result.json"),
    cdpOnlyRelaunchStdout: join(root, "cdp-only-relaunch-worker.stdout.log"),
    cdpOnlyRelaunchStderr: join(root, "cdp-only-relaunch-worker.stderr.log"),
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

export async function readJson<T = unknown>(
  path: string,
  fallback: T | null = null
): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode })
  await chmod(temporary, mode)
  await rename(temporary, path)
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

export interface CommandResult {
  ok: boolean
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error: string | null
}

export function commandResult(
  command: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {}
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  })
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    error: result.error?.message ?? null,
  }
}

export function appProcessIds(appPath: string = APP_PATH): number[] {
  const result = commandResult("/bin/ps", ["-axo", "pid=,command="])
  if (!result.ok) {
    throw new Error(result.stderr || result.error || "Unable to inspect ChatGPT process")
  }
  const appExecutable = join(resolve(appPath), "Contents", "MacOS", "ChatGPT")
  return result.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => {
      const command = match?.[2] ?? ""
      return command === appExecutable || command.startsWith(`${appExecutable} `)
    })
    .map((match) => Number(match[1]))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
}

export interface AppServerChild {
  pid: number
  ppid: number
  command: string
}

/**
 * The App Server processes the normal (App-owned, CLI-override-free) Codex App
 * spawned under `appPids`. Exactly one means the App runs its bundled runtime,
 * which is the only state the controller drives.
 */
export function appServerChildren(
  {
    appPids,
    realCli,
    appPath,
  }: {
    appPids: readonly number[]
    realCli: string
    appPath?: string
  },
  inspectProcesses: typeof commandResult = commandResult
): AppServerChild[] {
  const owners = new Set(appPids)
  const resourcesIndex = realCli.indexOf("/Contents/Resources/")
  const bundle = appPath ?? (resourcesIndex >= 0 ? realCli.slice(0, resourcesIndex) : APP_PATH)
  const executables = new Set([realCli, ...bundledCodexCliPaths(bundle)])
  for (const path of [...executables]) {
    const executable = executablePath(path)
    if (executable) executables.add(executable)
  }
  const listed = inspectProcesses("/bin/ps", ["-axo", "pid=,ppid=,command="])
  if (!listed.ok) throw new Error(listed.stderr || listed.error || "Unable to inspect App children")
  return listed.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => {
      const command = match?.[3] ?? ""
      if (!owners.has(Number(match?.[2])) || command.includes("relay-shim")) return false
      const executable = [...executables].find((path) => command.startsWith(`${path} `))
      if (!executable) return false
      const args = command.slice(executable.length).trim().split(/\s+/)
      if (args.some((arg) => arg === "--listen" || arg.startsWith("--listen="))) return false
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] ?? ""
        if (["-c", "--config", "-C", "--cd", "--enable", "--disable"].includes(arg)) {
          index += 1
        } else if (!arg.startsWith("-")) {
          return arg === "app-server"
        }
      }
      return false
    })
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }))
}

function launchctlDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`
}

export function launchctlJobExists(label: string): boolean {
  return commandResult("/bin/launchctl", ["print", `${launchctlDomain()}/${label}`]).ok
}

export interface WaitForOptions {
  timeoutMs: number
  intervalMs?: number
  description?: string
}

export async function waitFor<T>(
  predicate: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  { timeoutMs, intervalMs = 250, description }: WaitForOptions
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(
    `${description ?? "Condition"} did not become ready within ${timeoutMs}ms${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`
  )
}

/** A script in this directory, as spawned by path. */
export function workerPath(name: string): string {
  return join(controlRoot(), name)
}

export interface CommonOptions {
  stateDir: string
  realCli: string
  appPath: string
  cdpPort: number | null
}

/** Flags shared by the detached worker scripts. */
export function parseCommonOptions(argv: readonly string[]): CommonOptions {
  const options: CommonOptions = {
    stateDir: defaultStateDir(),
    realCli: DEFAULT_REAL_CLI,
    appPath: APP_PATH,
    cdpPort: null,
  }
  let explicitCli = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = argv[index + 1]
    if (argument === "--state-dir" && next) {
      options.stateDir = resolve(next)
      index += 1
    } else if (argument === "--real-cli" && next) {
      options.realCli = resolve(next)
      explicitCli = true
      index += 1
    } else if (argument === "--app-path" && next) {
      options.appPath = resolve(next)
      index += 1
    } else if (argument === "--cdp-port" && next) {
      options.cdpPort = Number(next)
      index += 1
    }
  }
  if (!explicitCli) {
    options.realCli =
      findBundledCodexCli(options.appPath) ?? join(options.appPath, "Contents/Resources/codex")
  }
  if (
    options.cdpPort != null &&
    (!Number.isSafeInteger(options.cdpPort) ||
      options.cdpPort < 1024 ||
      options.cdpPort > 65535 ||
      options.cdpPort === LEGACY_RELAY_PORT)
  ) {
    throw new Error(`Invalid CDP port: ${options.cdpPort}`)
  }
  return options
}
