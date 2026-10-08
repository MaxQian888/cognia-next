"use client"

/**
 * Launch configurations for the dock browser: a `launch.json` in the task's
 * working directory — the same shape Claude Code's `.claude/launch.json` uses —
 * names the dev servers a project can start, so the browser's start page can
 * offer "start it and open it" in one click.
 *
 * ```json
 * {
 *   "version": "0.0.1",
 *   "configurations": [
 *     { "name": "web", "runtimeExecutable": "pnpm", "runtimeArgs": ["dev"], "port": 3000 }
 *   ]
 * }
 * ```
 *
 * Each configuration may also carry `url` (opened instead of
 * `http://localhost:<port>`), `cwd` (relative to the root, or absolute) and
 * `env`. JSONC is accepted: people hand-edit these files.
 *
 * Starting one does not invent a process runner: the command is typed into a
 * fresh integrated-terminal tab (`runInTerminalDock`), so the user sees its
 * output and stops it there. A configuration whose port already answers is
 * reused instead of started twice.
 */

import { parseJsonc } from "@/lib/jsonc"
import { exists, readTextFile } from "@/lib/file/file-operations"
import { detectPlatform, type ShellPlatform } from "@/lib/terminal/shell-detect"

import { detectDevServers, type DevServer } from "./local-content-client"

/** Where a launch file is looked for, in order; the first one present wins. */
export const LAUNCH_CONFIG_RELATIVE_PATHS = [".cognia/launch.json", ".claude/launch.json"] as const

export interface LaunchConfiguration {
  name: string
  runtimeExecutable: string
  runtimeArgs: string[]
  port: number | null
  url: string | null
  cwd: string | null
  env: Record<string, string>
}

export interface LaunchConfigFile {
  /** Absolute path of the file read. */
  path: string
  configurations: LaunchConfiguration[]
  /** Entries skipped because they lack a name / executable or are malformed. */
  invalid: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readPort(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535
    ? value
    : null
}

function readUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

function readConfiguration(entry: unknown): LaunchConfiguration | null {
  if (!isRecord(entry)) return null
  const name = typeof entry.name === "string" ? entry.name.trim() : ""
  const runtimeExecutable =
    typeof entry.runtimeExecutable === "string" ? entry.runtimeExecutable.trim() : ""
  if (!name || !runtimeExecutable) return null
  const args = entry.runtimeArgs
  if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === "string"))) {
    return null
  }
  const env: Record<string, string> = {}
  if (isRecord(entry.env)) {
    for (const [key, value] of Object.entries(entry.env)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        env[key] = String(value)
      }
    }
  }
  return {
    name,
    runtimeExecutable,
    runtimeArgs: (args as string[] | undefined) ?? [],
    port: readPort(entry.port),
    url: readUrl(entry.url),
    cwd: typeof entry.cwd === "string" && entry.cwd.trim() ? entry.cwd.trim() : null,
    env,
  }
}

/**
 * Parse a launch file's text. Throws `SyntaxError` when the text is not JSON(C)
 * or has no `configurations` array; individual bad entries are counted in
 * `invalid` rather than failing the whole file.
 */
export function parseLaunchConfig(text: string): Omit<LaunchConfigFile, "path"> {
  const value = parseJsonc<unknown>(text)
  if (!isRecord(value) || !Array.isArray(value.configurations)) {
    throw new SyntaxError("launch.json has no configurations array")
  }
  const configurations: LaunchConfiguration[] = []
  let invalid = 0
  for (const entry of value.configurations) {
    const config = readConfiguration(entry)
    if (config) configurations.push(config)
    else invalid += 1
  }
  return { configurations, invalid }
}

function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${relative.replace(/^\.?[\\/]+/, "")}`
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(path)
}

/** The directory a configuration runs in: its `cwd` against the root. */
export function resolveLaunchCwd(root: string, config: LaunchConfiguration): string {
  if (!config.cwd) return root
  return isAbsolutePath(config.cwd) ? config.cwd : joinPath(root, config.cwd)
}

/** The port to wait for: the declared one, else the `url`'s. */
export function launchPort(config: LaunchConfiguration): number | null {
  if (config.port) return config.port
  if (!config.url) return null
  const url = new URL(config.url)
  if (url.port) return Number(url.port)
  return null
}

/** The page to open once the server is up, or null when nothing names one. */
export function launchTargetUrl(config: LaunchConfiguration): string | null {
  if (config.url) return config.url
  return config.port ? `http://localhost:${config.port}/` : null
}

const SAFE_ARG = /^[A-Za-z0-9_\-./:=@%+,]+$/

/** Quote one argv entry for the terminal's shell. */
export function quoteShellArg(arg: string, platform: ShellPlatform): string {
  if (SAFE_ARG.test(arg)) return arg
  // PowerShell and cmd both accept a double-quoted word; embedded quotes are
  // doubled, which PowerShell reads literally and cmd passes through.
  if (platform === "windows") return `"${arg.replace(/"/g, '""')}"`
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** The command line typed into the terminal. */
export function buildLaunchCommand(
  config: LaunchConfiguration,
  platform: ShellPlatform = detectPlatform()
): string {
  return [config.runtimeExecutable, ...config.runtimeArgs]
    .map((part) => quoteShellArg(part, platform))
    .join(" ")
}

export interface LoadLaunchConfigDeps {
  exists?: (path: string) => Promise<boolean>
  readTextFile?: (path: string) => Promise<string>
}

/**
 * Read the first launch file under `root`, or null when there is none.
 * Rejects when the file is present but unreadable or malformed, so the caller
 * can say so rather than pretend the project has no configurations.
 */
export async function loadLaunchConfigs(
  root: string,
  deps: LoadLaunchConfigDeps = {}
): Promise<LaunchConfigFile | null> {
  const has = deps.exists ?? exists
  const read = deps.readTextFile ?? readTextFile
  for (const relative of LAUNCH_CONFIG_RELATIVE_PATHS) {
    const path = joinPath(root, relative)
    if (!(await has(path).catch(() => false))) continue
    return { path, ...parseLaunchConfig(await read(path)) }
  }
  return null
}

export interface WaitForPortOptions {
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
  detect?: () => Promise<DevServer[]>
}

/** Whether a loopback listener answers on `port`. */
export async function isPortListening(
  port: number,
  detect: () => Promise<DevServer[]> = detectDevServers
): Promise<boolean> {
  const servers = await detect().catch(() => [] as DevServer[])
  return servers.some((server) => server.port === port)
}

/** Poll the loopback listeners until `port` answers; false on timeout or abort. */
export async function waitForPort(
  port: number,
  options: WaitForPortOptions = {}
): Promise<boolean> {
  const { timeoutMs = 120_000, intervalMs = 1_000, signal, detect = detectDevServers } = options
  const deadline = Date.now() + timeoutMs
  while (!signal?.aborted) {
    if (await isPortListening(port, detect)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

export type LaunchOutcome =
  /** The port already answered: nothing was started. */
  | { kind: "reused"; url: string }
  /** Started, and the port came up. */
  | { kind: "ready"; url: string }
  /** Started; nothing names a page to open. */
  | { kind: "started" }
  /** Started, but the port never came up in time. */
  | { kind: "timeout"; port: number }

export interface StartLaunchInput {
  config: LaunchConfiguration
  root: string
  chatSessionId: string
  signal?: AbortSignal
  timeoutMs?: number
  detect?: () => Promise<DevServer[]>
  /** Test seam; defaults to typing the command into a new terminal tab. */
  run?: (
    command: string,
    cwd: string,
    chatSessionId: string,
    options: { env: Record<string, string>; title: string }
  ) => Promise<void>
}

/** Start a configuration in a terminal tab and wait until its page can open. */
export async function startLaunchConfiguration(input: StartLaunchInput): Promise<LaunchOutcome> {
  const { config, detect = detectDevServers } = input
  const port = launchPort(config)
  const url = launchTargetUrl(config)
  if (port && url && (await isPortListening(port, detect))) return { kind: "reused", url }

  const run = input.run ?? (await import("@/lib/terminal/run-in-dock")).runInTerminalDock
  await run(buildLaunchCommand(config), resolveLaunchCwd(input.root, config), input.chatSessionId, {
    env: config.env,
    title: config.name,
  })

  if (!port || !url) return { kind: "started" }
  const up = await waitForPort(port, { detect, signal: input.signal, timeoutMs: input.timeoutMs })
  return up ? { kind: "ready", url } : { kind: "timeout", port }
}
