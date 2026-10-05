/**
 * Per-configuration agent state roots on the CLI / headless host (ADR-0216,
 * "State-root launch contract").
 *
 * The TypeScript launch path asks for a private state root by setting
 * `COGNIA_AGENT_STATE_KEY=<configId>`. This module is the Node twin of
 * `crates/cognia-external-agent/src/state_isolation.rs`: it validates the key,
 * resolves `<data_dir>/cognia/external-agents/<key>` from THIS host's
 * environment, creates it owner-only, maps the runtime's home variables into
 * it, and removes the key. The sandbox launcher then grants the root as
 * writable, withdraws the runtime's shared default roots from the writable set
 * and denies reading them (see `buildSandboxLauncherArgs`).
 *
 * The rules are read from the shared security policy
 * (`protocol/external-agent-security-policy.json`) through its TypeScript
 * accessor, so this side cannot drift from the renderer's view of which
 * runtimes can be isolated.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  AGENT_STATE_KEY_ENV,
  AGENT_STATE_KEY_PATTERN,
  agentStateIsolationFor,
} from "@/lib/ai/agent/external/policy/security-policy"

/** The spawn-config fields isolation reads and rewrites. */
export interface StateIsolationSpawnConfig {
  id: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

/** A resolved private state root. Every path is absolute. */
export interface StateIsolationPlan {
  /** `<data_dir>/cognia/external-agents/<key>`. */
  root: string
  /** Env variables pointing the runtime's homes into {@link root}. */
  env: Record<string, string>
  /** The runtime's shared default state roots; they leave the writable set. */
  sharedRoots: string[]
  /** Roots under the user's home the agent must not read. */
  denyReadable: string[]
}

/** Disk facts about one configuration's state root, for the settings UI. */
export interface AgentStateRootInfo {
  path: string
  exists: boolean
  /** Total size of the regular files under the root; symlinks are not followed. */
  bytes: number
}

/** Host facts the resolution needs. A parameter so every platform is testable. */
export interface StateIsolationHost {
  platform: NodeJS.Platform
  homedir: string
  env: Readonly<Record<string, string | undefined>>
}

export function defaultStateIsolationHost(): StateIsolationHost {
  return { platform: process.platform, homedir: os.homedir(), env: process.env }
}

/** A state key is a configuration id, never a path. */
export function stateKeyValid(key: string): boolean {
  return AGENT_STATE_KEY_PATTERN.test(key)
}

/**
 * The per-user data directory the desktop app uses (`dirs::data_dir()`):
 * `~/Library/Application Support` on macOS, `$XDG_DATA_HOME` (only when
 * absolute) or `~/.local/share` on Linux, `%APPDATA%` on Windows.
 */
export function agentStateDataDir(
  platform: NodeJS.Platform,
  homedir: string | undefined,
  xdgDataHome?: string,
  appData?: string
): string | undefined {
  const home = homedir && path.isAbsolute(homedir) ? homedir : undefined
  switch (platform) {
    case "darwin":
      return home ? path.join(home, "Library", "Application Support") : undefined
    case "linux":
      if (xdgDataHome && path.isAbsolute(xdgDataHome)) return xdgDataHome
      return home ? path.join(home, ".local", "share") : undefined
    case "win32":
      return appData && path.win32.isAbsolute(appData) ? appData : undefined
    default:
      return undefined
  }
}

/** {@link agentStateDataDir} for this host, read from the HOST environment. */
export function hostAgentStateDataDir(
  host: StateIsolationHost = defaultStateIsolationHost()
): string | undefined {
  return agentStateDataDir(
    host.platform,
    host.homedir,
    host.env.XDG_DATA_HOME || undefined,
    host.env.APPDATA || undefined
  )
}

/** `<data_dir>/cognia/external-agents/<key>`. The key must already be valid. */
export function agentStateRoot(dataDir: string, key: string): string {
  return path.join(dataDir, "cognia", "external-agents", key)
}

/** Does this launch already run under a private home of its own? */
export function launchOwnsPrivateHome(env: Record<string, string> | undefined): boolean {
  return (
    env?.COGNIA_BOT_ISOLATION === "1" ||
    env?.COGNIA_GATEWAY_TASK_CONFIG !== undefined ||
    env?.COGNIA_GATEWAY_TASK_HOME !== undefined
  )
}

/**
 * Create `dir` owner-only, refusing a symlink. The root is writable by the
 * agent it belongs to, so an entry under it can have been swapped for a
 * symlink by a previous run; following it would move the next launch's home
 * (and this chmod) outside the root.
 */
function ensurePrivateDir(dir: string, platform: NodeJS.Platform): void {
  let stat: fs.Stats | undefined
  try {
    stat = fs.lstatSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (stat?.isSymbolicLink()) {
    throw new Error(`agent state directory ${dir} is a symlink; refusing to use it`)
  }
  if (stat && !stat.isDirectory()) {
    throw new Error(`agent state path ${dir} exists and is not a directory`)
  }
  if (!stat) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (platform !== "win32") fs.chmodSync(dir, 0o700)
}

/**
 * Apply the configuration's state root.
 *
 * - No key: the config is returned unchanged with no plan.
 * - A launch that owns a private home (Bot isolation, gateway task): the key
 *   is removed and ignored.
 * - Otherwise the key is removed and must be valid, the runtime must have an
 *   isolation rule (`state isolation unsupported for <command>`) and the data
 *   directory must be known. The root and every mapped subdirectory are created
 *   owner-only and the mapping replaces any caller value in the env.
 *
 * Never mutates `config`; returns a new one.
 */
export function applyStateIsolation<T extends StateIsolationSpawnConfig>(
  config: T,
  host: StateIsolationHost = defaultStateIsolationHost()
): { config: T; plan: StateIsolationPlan | null } {
  const key = config.env?.[AGENT_STATE_KEY_ENV]
  if (key === undefined) return { config, plan: null }
  const env = { ...config.env }
  delete env[AGENT_STATE_KEY_ENV]
  if (launchOwnsPrivateHome(env)) return { config: { ...config, env }, plan: null }
  if (!stateKeyValid(key)) {
    throw new Error(
      `invalid ${AGENT_STATE_KEY_ENV}: a state key is 1-128 characters of A-Z, a-z, 0-9, _ or -`
    )
  }
  const rule = agentStateIsolationFor(config.command, config.args ?? [])
  if (!rule) throw new Error(`state isolation unsupported for ${config.command}`)
  const dataDir = hostAgentStateDataDir(host)
  if (!dataDir) {
    throw new Error(
      "state isolation needs this host's per-user data directory, which could not be determined"
    )
  }
  if (!path.isAbsolute(host.homedir)) {
    throw new Error("state isolation needs an absolute home directory")
  }
  const root = agentStateRoot(dataDir, key)
  ensurePrivateDir(root, host.platform)
  const mapped: Record<string, string> = {}
  for (const [envKey, relative] of Object.entries(rule.env)) {
    let dir = root
    for (const part of relative.split("/").filter(Boolean)) {
      dir = path.join(dir, part)
      ensurePrivateDir(dir, host.platform)
    }
    mapped[envKey] = dir
  }
  const underHome = (relative: string) => path.join(host.homedir, ...relative.split("/"))
  return {
    config: { ...config, env: { ...env, ...mapped } },
    plan: {
      root,
      env: mapped,
      sharedRoots: rule.sharedRoots.map(underHome),
      denyReadable: rule.denyReadable.map(underHome),
    },
  }
}

function treeBytes(target: string): number {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(target)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.size
  let entries: string[]
  try {
    entries = fs.readdirSync(target)
  } catch {
    return 0
  }
  return entries.reduce((total, entry) => total + treeBytes(path.join(target, entry)), 0)
}

function requireDataDir(host: StateIsolationHost): string {
  const dataDir = hostAgentStateDataDir(host)
  if (!dataDir) throw new Error("this host's per-user data directory could not be determined")
  return dataDir
}

/** Where a configuration's state root lives on this host and how much it holds. */
export function stateRootInfo(
  key: string,
  host: StateIsolationHost = defaultStateIsolationHost()
): AgentStateRootInfo {
  if (!stateKeyValid(key)) throw new Error("invalid agent state key")
  const root = agentStateRoot(requireDataDir(host), key)
  let exists = true
  try {
    fs.lstatSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    exists = false
  }
  return { path: root, exists, bytes: exists ? treeBytes(root) : 0 }
}

/**
 * Delete a configuration's state root. A missing root is not an error; a root
 * that is a symlink loses only the link, never its target.
 */
export function removeStateRoot(
  key: string,
  host: StateIsolationHost = defaultStateIsolationHost()
): void {
  if (!stateKeyValid(key)) throw new Error("invalid agent state key")
  const root = agentStateRoot(requireDataDir(host), key)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (stat.isDirectory()) fs.rmSync(root, { recursive: true, force: true })
  else fs.unlinkSync(root)
}
