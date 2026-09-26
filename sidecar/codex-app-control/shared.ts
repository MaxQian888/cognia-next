import { spawnSync } from "node:child_process"
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const APP_PATH = "/Applications/ChatGPT.app"
export const APP_EXECUTABLE = `${APP_PATH}/Contents/MacOS/ChatGPT`
export const APP_BUNDLE_ID = "com.openai.codex"
export const DEFAULT_REAL_CLI = `${APP_PATH}/Contents/Resources/codex`
export const CDP_ONLY_RELAUNCH_LABEL_PREFIX = "com.cognia.codex-app-control.relaunch"

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

export function appProcessIds(): number[] {
  const result = commandResult("/bin/ps", ["-axo", "pid=,command="])
  if (!result.ok) {
    throw new Error(result.stderr || result.error || "Unable to inspect ChatGPT process")
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => {
      const command = match?.[2] ?? ""
      return command === APP_EXECUTABLE || command.startsWith(`${APP_EXECUTABLE} `)
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
export function appServerChildren({
  appPids,
  realCli,
}: {
  appPids: readonly number[]
  realCli: string
}): AppServerChild[] {
  const owners = new Set(appPids)
  const listed = commandResult("/bin/ps", ["-axo", "pid=,ppid=,command="])
  if (!listed.ok) throw new Error(listed.stderr || listed.error || "Unable to inspect App children")
  return listed.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => {
      const command = match?.[3] ?? ""
      return (
        owners.has(Number(match?.[2])) &&
        command.startsWith(
          `${realCli} -c features.code_mode_host=true app-server --analytics-default-enabled`
        ) &&
        !command.includes("--listen") &&
        !command.includes("relay-shim")
      )
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
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = argv[index + 1]
    if (argument === "--state-dir" && next) {
      options.stateDir = resolve(next)
      index += 1
    } else if (argument === "--real-cli" && next) {
      options.realCli = resolve(next)
      index += 1
    } else if (argument === "--app-path" && next) {
      options.appPath = resolve(next)
      index += 1
    } else if (argument === "--cdp-port" && next) {
      options.cdpPort = Number(next)
      index += 1
    }
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
