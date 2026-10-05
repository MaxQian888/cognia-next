import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import {
  bundledCandidates,
  defaultNativeCandidates,
  findNativeBinary,
  isDevCheckout as isRepoCheckout,
  isExecutable as isExecutableFile,
  nativeBinaryName,
} from "../native-binary"

import {
  botRuntimeEnvironment,
  type ExternalAgentLaunch,
  type NodeExternalAgentSpawnConfig,
} from "./node-backend"
import { devinOwnedConfigRoot, devinOriginalConfigRoot } from "./devin-mcp-config"
import type { StateIsolationPlan } from "./state-isolation"
import { toolHostRuntimeDir } from "../../agent/tool-host/protocol"
import {
  SANDBOX_SUPPORTED_PLATFORMS,
  agentStateWritableRoots as policyAgentStateWritableRoots,
  isAgentStateFileRoot,
} from "@/lib/ai/agent/external/policy/security-policy"

/** Base name of the launcher binary built from `crates/cognia-automation`. */
const LAUNCHER_BASE_NAME = "cognia-external-agent-launcher"

export interface SandboxLauncherRuntime {
  platform: NodeJS.Platform
  homedir: string
  candidates: string[]
  isExecutable: (candidate: string) => boolean
  ensureDir?: (candidate: string) => void
  ensureFile?: (candidate: string) => void
  /** True when running from a repo checkout, which unlocks the build hint. */
  isDevCheckout?: () => boolean
  /** Probe only the selected host launcher; never execute a target command. */
  supportsBotIsolation?: (launcher: string) => boolean
}

/** Platform-correct launcher filename. `platform` is a parameter so the Windows
 * spelling is reachable from a test on any host. */
export const launcherName = (platform: NodeJS.Platform = process.platform): string =>
  nativeBinaryName(LAUNCHER_BASE_NAME, platform)

/** Resolve launcher locations for both a single-file bundle and a split `chunks/` bundle. */
export function bundledLauncherCandidates(moduleUrl: string, name: string): string[] {
  return bundledCandidates(moduleUrl, name)
}

function defaultCandidates(): string[] {
  return defaultNativeCandidates({
    base: LAUNCHER_BASE_NAME,
    envVar: "COGNIA_EXTERNAL_AGENT_LAUNCHER",
    moduleUrl: import.meta.url,
  })
}

const isExecutable = isExecutableFile

/** Is this an in-repo checkout (where `pnpm cli:external-host:build` is a real
 * remedy) rather than an installed CLI (where it is noise)? */
export function isDevCheckout(): boolean {
  return isRepoCheckout()
}

/**
 * Why external agents cannot start, phrased for whoever is actually reading it.
 *
 * The build command is a maintainer instruction and is meaningless to someone
 * running an installed `cognia-agent`, so it is appended only in a checkout.
 */
export function sandboxLauncherUnavailableMessage(command: string, devCheckout: boolean): string {
  const base =
    `Can't launch "${command}": the external-agent sandbox launcher is unavailable. ` +
    `Cognia only runs external agents inside a strict sandbox and never falls back to an ` +
    `unsandboxed process. Reinstall cognia-agent, or point COGNIA_EXTERNAL_AGENT_LAUNCHER at a ` +
    `built launcher.`
  return devCheckout ? `${base} (repo checkout: run \`pnpm cli:external-host:build\`)` : base
}

/**
 * The first executable launcher among the candidates, or `undefined`. Exported
 * so `/doctor` can report sandbox readiness WITHOUT attempting a spawn — the
 * external command being on PATH says nothing about whether we can sandbox it.
 */
export function findSandboxLauncher(
  runtime: Pick<SandboxLauncherRuntime, "candidates" | "isExecutable"> = {
    candidates: defaultCandidates(),
    isExecutable,
  }
): string | undefined {
  return findNativeBinary(runtime.candidates, runtime.isExecutable)
}

/** An omitted target keeps this a parser-only capability check, before any sandbox or agent starts. */
export function launcherSupportsBotIsolation(launcher: string): boolean {
  try {
    const probe = spawnSync(launcher, ["--bot-isolation"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16_384,
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? "production" },
    })
    return (
      !probe.error &&
      probe.status === 1 &&
      probe.stderr.trim() === "cognia-external-agent-launcher: missing -- target separator"
    )
  } catch {
    return false
  }
}

/**
 * Can this platform host external agents at all? Fails closed off macOS/Linux.
 *
 * The platform list is the shared security policy's, not a literal here: the
 * settings UI has to be able to say "external agents cannot run on this
 * machine" BEFORE a user configures one, and it cannot import this Node-only
 * module to find out.
 */
export function sandboxSupportsPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return (SANDBOX_SUPPORTED_PLATFORMS as readonly string[]).includes(platform)
}

/**
 * The launcher argv for one spawn.
 *
 * `isolation` is the configuration's private state root (ADR-0216), resolved
 * by the backend. When present the root is writable, the runtime's shared
 * default roots leave the writable set and every `denyReadable` root is
 * hidden, so the CLI cannot fall back to the user's own login. Bot and
 * gateway launches never carry one: both already own a private home.
 */
export function buildSandboxLauncherArgs(
  config: NodeExternalAgentSpawnConfig,
  homedir: string,
  isolation: StateIsolationPlan | null = null
): string[] {
  if (!config.cwd) throw new Error("external-agent sandbox requires a working directory")
  qoderConfigRoot(config, homedir)
  clineConfigRoot(config, homedir)
  kimiConfigRoot(config, homedir)
  const taskHome = config.env?.COGNIA_GATEWAY_TASK_HOME
  const botIsolation = config.env?.COGNIA_BOT_ISOLATION === "1"
  const botState = config.env?.COGNIA_BOT_STATE_DIR
  if (botIsolation && (!botState || !path.isAbsolute(botState)))
    throw new Error("Bot isolation requires an owned state directory")
  const effectiveHome = taskHome ?? homedir
  const writable = [
    config.cwd,
    ...(botIsolation
      ? [botState!]
      : taskHome
        ? [taskHome]
        : agentStateWritableRoots(config, homedir, isolation)),
    ...(isolation && !botIsolation && !taskHome ? [isolation.root] : []),
    toolHostRuntimeDir(),
  ]
  const devinConfigRoot = devinOwnedConfigRoot(config)
  if (devinConfigRoot) writable.push(devinConfigRoot)
  return [
    ...(config.command === "aider"
      ? aiderImplicitConfigPaths(config.cwd, homedir).flatMap((file) => ["--deny-readable", file])
      : []),
    ...(isolation && !botIsolation && !taskHome
      ? isolation.denyReadable.flatMap((root) => ["--deny-readable", root])
      : []),
    ...(config.env?.COGNIA_BOT_ISOLATION === "1"
      ? [
          "--bot-isolation",
          "--deny-readable",
          homedir,
          ...[
            ".nvm",
            ".local/bin",
            ".local/share/pnpm",
            ".local/share/devin/cli/_versions",
            ".bun/bin",
            ".cargo/bin",
            ".rustup/toolchains",
            "Library/pnpm",
            ...(config.command === "qoder" ? [".qoder/entry", ".qoder/bin"] : []),
          ].flatMap((relative) => ["--readable", path.join(homedir, relative)]),
        ]
      : []),
    "--cwd",
    config.cwd,
    ...writable.flatMap((root) => ["--writable", root]),
    ...(!botIsolation ? ["--readable", effectiveHome] : []),
    ...(!botIsolation && devinOriginalConfigRoot(config)
      ? ["--readable", devinOriginalConfigRoot(config)!]
      : []),
    ...(taskHome
      ? [
          "--readable",
          homedir,
          ...[
            ".codex",
            ".claude",
            ".claude.json",
            ".pi",
            ".qwen",
            ".config/opencode",
            ".local/share/opencode",
            ".local/share/cognia-agent-tasks",
            // Kimi Code (and its archived Python CLI), Copilot CLI, Goose and
            // Aider keep logins and provider settings here; a task uses its own.
            ".kimi-code",
            ".kimi",
            ".copilot",
            ".config/goose",
            ".local/share/goose",
            ".local/state/goose",
            ".aider",
          ].flatMap((relative) => ["--deny-readable", path.join(homedir, relative)]),
        ]
      : []),
    "--network",
    "--",
    config.command,
    ...(config.args ?? []),
  ]
}

/** Aider searches cwd, Git ancestors and home even with explicit --config.
 * Hide that implicit configuration so startup commands, extra files and .env
 * cannot replace Cognia's explicit prompt, policies or provider credentials. */
export function aiderImplicitConfigPaths(cwd: string, home: string): string[] {
  const roots = new Set([home])
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    roots.add(dir)
    if (dir === path.dirname(dir)) break
  }
  return [
    ...[...roots].flatMap((root) =>
      [".aider.conf.yml", ".env", ".aider.model.settings.yml", ".aider.model.metadata.json"].map(
        (name) => path.join(root, name)
      )
    ),
    path.join(home, ".aider/oauth-keys.env"),
  ]
}

/** Keep the documented config override writable without moving or copying CLI credentials. */
export function qoderConfigRoot(
  config: NodeExternalAgentSpawnConfig,
  homedir: string
): string | undefined {
  if (config.command !== "qoder") return undefined
  let selected = config.env?.QODER_CONFIG_DIR ?? process.env.QODER_CONFIG_DIR
  const args = config.args ?? []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config-dir") selected = args[++i] ?? ""
    else if (args[i].startsWith("--config-dir=")) selected = args[i].slice("--config-dir=".length)
  }
  if (selected !== undefined && !selected.trim())
    throw new Error("Qoder config directory must not be empty")
  const bot = config.env?.COGNIA_BOT_ISOLATION === "1"
  const botState = config.env?.COGNIA_BOT_STATE_DIR
  const home = bot ? botState : (config.env?.COGNIA_GATEWAY_TASK_HOME ?? homedir)
  if (!home || !path.isAbsolute(home)) throw new Error("Qoder requires an absolute state directory")
  const root = selected ? path.resolve(config.cwd ?? homedir, selected) : path.join(home, ".qoder")
  if (
    bot &&
    (path.relative(home, root).startsWith("..") || path.isAbsolute(path.relative(home, root)))
  )
    throw new Error("Qoder config directory must stay inside the Bot state directory")
  return root
}

/** ACP branches before upstream --data-dir setup; --config controls all persisted state. */
export function clineConfigRoot(
  config: NodeExternalAgentSpawnConfig,
  homedir: string
): string | undefined {
  if (config.command !== "cline") return undefined
  const args = config.args ?? []
  if (args.some((arg) => arg === "--data-dir" || arg.startsWith("--data-dir=")))
    throw new Error("Cline ACP requires --config or CLINE_DIR instead of --data-dir")
  let selected = config.env?.CLINE_DIR ?? process.env.CLINE_DIR
  // Upstream's early config pre-pass uses the first occurrence.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" || args[i].startsWith("--config=")) {
      selected = args[i] === "--config" ? (args[i + 1] ?? "") : args[i].slice("--config=".length)
      break
    }
  }
  if (selected !== undefined && !selected.trim())
    throw new Error("Cline config directory must not be empty")
  const bot = config.env?.COGNIA_BOT_ISOLATION === "1"
  const home = bot
    ? config.env?.COGNIA_BOT_STATE_DIR
    : (config.env?.COGNIA_GATEWAY_TASK_HOME ?? homedir)
  if (!home || !path.isAbsolute(home)) throw new Error("Cline requires an absolute state directory")
  const root = selected
    ? path.resolve(config.cwd ?? homedir, selected.trim())
    : path.join(home, ".cline")
  const relative = path.relative(home, root)
  if (
    bot &&
    (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  )
    throw new Error("Cline config directory must stay inside the Bot state directory")
  return root
}

/** Kimi Code resolves its native state home from the environment, relative to cwd. */
export function kimiConfigRoot(
  config: NodeExternalAgentSpawnConfig,
  homedir: string
): string | undefined {
  if (config.command !== "kimi") return undefined
  const selected = config.env?.KIMI_CODE_HOME ?? process.env.KIMI_CODE_HOME
  if (selected !== undefined && !selected.trim())
    throw new Error("Kimi state directory must not be empty")
  const bot = config.env?.COGNIA_BOT_ISOLATION === "1"
  const home = bot
    ? config.env?.COGNIA_BOT_STATE_DIR
    : (config.env?.COGNIA_GATEWAY_TASK_HOME ?? homedir)
  if (!home || !path.isAbsolute(home)) throw new Error("Kimi requires an absolute state directory")
  // Preserve whitespace in nonempty native paths; upstream does not trim these.
  const root =
    selected !== undefined
      ? path.resolve(config.cwd ?? homedir, selected)
      : path.join(home, ".kimi-code")
  const relative = path.relative(home, root)
  if (
    bot &&
    (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  )
    throw new Error("Kimi state directory must stay inside the Bot state directory")
  if (bot) {
    const existingPath = (candidate: string): string => {
      const missing: string[] = []
      for (let current = candidate; ; current = path.dirname(current)) {
        try {
          return path.join(fs.realpathSync(current), ...missing.reverse())
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          if (current === path.dirname(current)) return candidate
          missing.push(path.basename(current))
        }
      }
    }
    const physicalRelative = path.relative(existingPath(home), existingPath(root))
    if (
      physicalRelative === ".." ||
      physicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(physicalRelative)
    )
      throw new Error("Kimi state directory must stay inside the Bot state directory")
  }
  return root
}

/**
 * The agent's own state directories, absolute.
 *
 * The RULES live in `protocol/external-agent-security-policy.json` (shared with
 * the Rust launcher, which keeps compiled-in literals and is checked against
 * the same file by `pnpm audit:agent-capabilities`). Only the join to the real
 * home directory happens here. While this list was hand-maintained in two
 * places it lacked an OpenCode rule on both sides, so `opencode serve` could
 * not persist a session inside the sandbox and resume started over every time.
 */
function agentStateWritableRoots(
  config: NodeExternalAgentSpawnConfig,
  homedir: string,
  isolation: StateIsolationPlan | null = null
): string[] {
  const kimiRoot = kimiConfigRoot(config, homedir)
  if (kimiRoot) return [kimiRoot]
  const clineRoot = clineConfigRoot(config, homedir)
  if (clineRoot) return [clineRoot]
  const qoderRoot = qoderConfigRoot(config, homedir)
  if (qoderRoot) return [qoderRoot]
  // An isolated launch writes its own root instead of the shared login roots.
  const shared = new Set(isolation?.sharedRoots ?? [])
  return policyAgentStateWritableRoots(config.command, config.args ?? [])
    .map((root) => path.join(homedir, ...root.split("/")))
    .filter((root) => !shared.has(root))
}

function agentStateDirectoryRoots(
  config: NodeExternalAgentSpawnConfig,
  homedir: string,
  isolation: StateIsolationPlan | null
): string[] {
  return agentStateWritableRoots(config, homedir, isolation).filter(
    (root) => !isAgentStateFileRoot(root)
  )
}

function agentStateFileRoots(
  config: NodeExternalAgentSpawnConfig,
  homedir: string,
  isolation: StateIsolationPlan | null
): string[] {
  return agentStateWritableRoots(config, homedir, isolation).filter((root) =>
    isAgentStateFileRoot(root)
  )
}

/** The real host runtime. Exported so its fs shims are directly testable — as an
 * inline default-parameter literal they could only be reached by a call that
 * actually spawned an agent and wrote to the user's home. */
export function defaultSandboxRuntime(): SandboxLauncherRuntime {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    candidates: defaultCandidates(),
    isExecutable,
    ensureDir: (candidate) => fs.mkdirSync(candidate, { recursive: true }),
    ensureFile: (candidate) => fs.closeSync(fs.openSync(candidate, "a", 0o600)),
    isDevCheckout,
  }
}

export async function resolveSandboxedExternalAgentLaunch(
  config: NodeExternalAgentSpawnConfig,
  runtime: SandboxLauncherRuntime = defaultSandboxRuntime(),
  isolation: StateIsolationPlan | null = null
): Promise<ExternalAgentLaunch> {
  if (!sandboxSupportsPlatform(runtime.platform)) {
    throw new Error(
      `External agents are not available on ${runtime.platform}: they require a strict sandbox ` +
        `(macOS Seatbelt or Linux bubblewrap), and Cognia never runs them unsandboxed.`
    )
  }
  const launcher = findSandboxLauncher(runtime)
  if (!launcher) {
    throw new Error(
      sandboxLauncherUnavailableMessage(config.command, runtime.isDevCheckout?.() ?? false)
    )
  }
  if (
    config.env?.COGNIA_BOT_ISOLATION === "1" &&
    !(runtime.supportsBotIsolation ?? launcherSupportsBotIsolation)(launcher)
  ) {
    throw new Error(
      `BOT_ISOLATION_LAUNCHER_UNSUPPORTED: Selected launcher ${launcher} does not support Bot isolation. ` +
        "Rebuild or reinstall the external-agent launcher and set COGNIA_EXTERNAL_AGENT_LAUNCHER to that executable."
    )
  }
  for (const root of agentStateDirectoryRoots(config, runtime.homedir, isolation))
    runtime.ensureDir?.(root)
  const botRuntime = botRuntimeEnvironment(config.env)
  if (config.env?.COGNIA_BOT_ISOLATION === "1") {
    runtime.ensureDir?.(config.env.COGNIA_BOT_STATE_DIR)
    for (const root of new Set(Object.values(botRuntime))) runtime.ensureDir?.(root)
  }
  const qoderRoot = qoderConfigRoot(config, runtime.homedir)
  if (qoderRoot) runtime.ensureDir?.(qoderRoot)
  // Goose's platform extensions create temporary files during session/new.
  // macOS's ambient /var/folders temp root is outside the sandbox write scope.
  let env: Record<string, string> | undefined
  const kimiRoot = kimiConfigRoot(config, runtime.homedir)
  if (kimiRoot) {
    env = {
      KIMI_CODE_HOME: kimiRoot,
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: "0",
    }
    const temp = path.join(kimiRoot, "tmp")
    runtime.ensureDir?.(temp)
    Object.assign(env, { TMPDIR: temp, TMP: temp, TEMP: temp })
  }
  const clineRoot = clineConfigRoot(config, runtime.homedir)
  if (clineRoot) {
    env = { CLINE_DIR: clineRoot, CLINE_NO_AUTO_UPDATE: "1" }
    if (config.env?.COGNIA_BOT_ISOLATION !== "1") {
      const temp = path.join(clineRoot, "tmp")
      runtime.ensureDir?.(temp)
      Object.assign(env, { TMPDIR: temp, TMP: temp, TEMP: temp })
    }
  }
  if (qoderRoot) {
    env = { QODER_CONFIG_DIR: qoderRoot }
    if (config.env?.COGNIA_BOT_ISOLATION !== "1") {
      const temp = path.join(qoderRoot, "tmp")
      runtime.ensureDir?.(temp)
      Object.assign(env, { TMPDIR: temp, TMP: temp, TEMP: temp })
    }
  }
  if (config.command === "goose" && config.env?.COGNIA_BOT_ISOLATION !== "1") {
    const temp = path.join(
      config.env?.COGNIA_GATEWAY_TASK_HOME ?? runtime.homedir,
      ".local/state/goose/tmp"
    )
    runtime.ensureDir?.(temp)
    env = { TMPDIR: temp, TMP: temp, TEMP: temp }
  }
  runtime.ensureDir?.(toolHostRuntimeDir())
  for (const root of agentStateFileRoots(config, runtime.homedir, isolation))
    runtime.ensureFile?.(root)
  return {
    command: launcher,
    args: buildSandboxLauncherArgs(config, runtime.homedir, isolation),
    ...(env ? { env } : {}),
  }
}
