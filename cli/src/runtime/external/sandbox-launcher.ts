import { validateExternalAgentSandboxPolicy } from "@cognia/agent-contracts"
import { resolveAgentSearchPath } from "./agent-path"
import { antigravityBundle } from "./version-probe"
import { validateCodexWritableRoots } from "@cognia/agent-codex/app-server-client"
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
import { hostAgentStateDataDir, type StateIsolationPlan } from "./state-isolation"
import {
  registeredNativeBridgeId,
  registeredNativeBridgeRoot,
  registeredHermesProbeStateRoot,
} from "./native-bridges"
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

/** Mirror the native wrapper's validation of the host-owned Codex hint. */
export function codexExtraWritableRoots(config: NodeExternalAgentSpawnConfig): string[] {
  const raw = config.env?.COGNIA_AGENT_CODEX_WRITABLE_ROOTS
  if (raw === undefined || config.command !== "codex") return []
  let requested: string[]
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.some((root) => typeof root !== "string"))
      throw new Error("expected paths")
    requested = value
  } catch {
    console.warn("Ignoring malformed Codex writable roots")
    return []
  }
  const report = (root: string, reason: string) =>
    console.warn("Ignoring Codex writable root", { root, reason })
  const canonicalize = (root: string): string => {
    let ancestor = root
    const tail: string[] = []
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
      tail.unshift(path.basename(ancestor))
      ancestor = path.dirname(ancestor)
    }
    return path.join(fs.realpathSync(ancestor), ...tail)
  }
  let ceiling: string[] | undefined
  const rawCeiling = config.env?.COGNIA_AGENT_CODEX_WRITABLE_CEILING
  if (rawCeiling !== undefined) {
    try {
      const value: unknown = JSON.parse(rawCeiling)
      if (
        !Array.isArray(value) ||
        value.some((root) => typeof root !== "string" || !path.isAbsolute(root))
      ) {
        throw new Error("expected absolute ceiling roots")
      }
      ceiling = value.map(canonicalize)
    } catch {
      console.warn("Ignoring Codex writable roots: invalid session writable ceiling")
      return []
    }
  }
  const canonical = validateCodexWritableRoots(requested, report).flatMap((root) => {
    if (!path.isAbsolute(root)) {
      report(root, "an absolute path on this host is required")
      return []
    }
    try {
      return [canonicalize(root)]
    } catch {
      report(root, "path cannot be resolved on this host")
      return []
    }
  })
  const configuredData = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "cognia")
    : undefined
  let dataRoot = configuredData
  if (configuredData) {
    try {
      dataRoot = canonicalize(configuredData)
    } catch {
      // A missing/unresolvable configured data root must not remove its lexical deny.
    }
  }
  return validateCodexWritableRoots(canonical, report).filter((root) => {
    if (
      ceiling &&
      !ceiling.some((allowed) => {
        const relative = path.relative(allowed, root)
        return (
          relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        )
      })
    ) {
      report(root, "outside the canonical session writable ceiling")
      return false
    }
    if (
      [dataRoot, configuredData].some(
        (data) => data && (root === data || root.startsWith(`${data}${path.sep}`))
      )
    ) {
      report(root, "Cognia app-data roots cannot be writable")
      return false
    }
    return true
  })
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
  validateExternalAgentSandboxPolicy(config.sandboxPolicy)
  const nativeBridgeRoot = registeredNativeBridgeRoot(config.command, config.args ?? [])
  const crushBridge = registeredNativeBridgeId(config.command, config.args ?? []) === "crush-http"
  const hermesProbeRoot = registeredHermesProbeStateRoot(
    config.command,
    config.args ?? [],
    config.env,
    hostAgentStateDataDir()
  )
  qoderConfigRoot(config, homedir)
  clineConfigRoot(config, homedir)
  kimiConfigRoot(config, homedir)
  grokConfigRoot(config, homedir)
  minimaxConfigRoot(config, homedir)
  const taskHome = config.env?.COGNIA_GATEWAY_TASK_HOME
  const botIsolation = config.env?.COGNIA_BOT_ISOLATION === "1"
  const botState = config.env?.COGNIA_BOT_STATE_DIR
  if (botIsolation && (!botState || !path.isAbsolute(botState)))
    throw new Error("Bot isolation requires an owned state directory")
  if (hermesProbeRoot)
    config = { ...config, sandboxPolicy: { ...config.sandboxPolicy, readableScope: "workspace" } }
  if (!config.cwd) throw new Error("external-agent sandbox requires a working directory")
  const effectiveHome = taskHome ?? homedir
  const writable = [
    config.cwd,
    ...codexExtraWritableRoots(config),
    ...(crushBridge
      ? policyAgentStateWritableRoots("crush", []).map((root) => path.join(homedir, root))
      : []),
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
    ...[nativeBridgeRoot, hermesProbeRoot]
      .filter((root): root is string => !!root)
      .flatMap((root) => ["--readable", root]),
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
    ...(!botIsolation
      ? config.sandboxPolicy?.readableScope === "workspace"
        ? [
            "--workspace-readable",
            ...workspaceToolchainReadableRoots(config.command, homedir).flatMap((root) => [
              "--readable",
              root,
            ]),
          ]
        : ["--readable", effectiveHome]
      : []),
    ...(!botIsolation && devinOriginalConfigRoot(config)
      ? ["--readable", devinOriginalConfigRoot(config)!]
      : []),
    ...(taskHome
      ? [
          ...(config.sandboxPolicy?.readableScope === "workspace" ? [] : ["--readable", homedir]),
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
            ".grok",
            ".minimax",
            ".kimi",
            ".copilot",
            ".config/goose",
            ".local/share/goose",
            ".local/state/goose",
            ".aider",
          ].flatMap((relative) => ["--deny-readable", path.join(homedir, relative)]),
        ]
      : []),
    ...(config.sandboxPolicy?.network === "off"
      ? []
      : config.sandboxPolicy?.network === "allowlist"
        ? (config.sandboxPolicy.allowedHosts ?? []).flatMap((host) => ["--network-allow", host])
        : ["--network"]),
    "--",
    config.command,
    ...(config.args ?? []),
  ]
}

/** Match the native wrapper: exact install prefixes, never the whole home. */
export function workspaceToolchainReadableRoots(command: string, home: string): string[] {
  const roots = new Set(
    [".local/bin", ".cargo/bin", ".rustup/toolchains", ".gitconfig", ".config/git"].map((root) =>
      path.join(home, root)
    )
  )
  if (command === "npx") roots.add(path.join(home, ".npm"))
  const broadRoots = new Set([home, path.join(home, ".local"), path.join(home, ".cargo")])
  try {
    const canonicalHome = fs.realpathSync(home)
    for (const root of [
      canonicalHome,
      path.join(canonicalHome, ".local"),
      path.join(canonicalHome, ".cargo"),
    ])
      broadRoots.add(root)
  } catch {
    /* A not-yet-created home still has lexical scope guards. */
  }
  for (const binary of [command, "node"]) {
    const candidates = path.isAbsolute(binary)
      ? [binary]
      : resolveAgentSearchPath()
          .split(path.delimiter)
          .map((dir) => path.join(dir, binary))
    const found = candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile()
      } catch {
        return false
      }
    })
    if (!found) continue
    const executables = [found]
    try {
      executables.push(fs.realpathSync(found))
    } catch {
      /* Lexical install path remains readable. */
    }
    for (const executable of executables) {
      const parent = path.dirname(executable)
      let prefix = path.basename(parent) === "bin" ? path.dirname(parent) : parent
      for (let dir = parent; dir !== path.dirname(dir); dir = path.dirname(dir)) {
        if (path.basename(dir) === "node_modules") {
          prefix = dir
          break
        }
      }
      if ([home, path.join(home, ".local"), path.join(home, ".cargo")].includes(prefix))
        prefix = parent
      if (prefix !== home && prefix !== path.parse(prefix).root) roots.add(prefix)
    }
  }
  return [...roots]
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

/** Grok Build uses its native home; gateway tasks never inherit the host login. */
export function grokConfigRoot(
  config: NodeExternalAgentSpawnConfig,
  homedir: string
): string | undefined {
  if (config.command !== "grok") return undefined
  const selected =
    config.env?.GROK_HOME ??
    (config.env?.COGNIA_GATEWAY_TASK_HOME ? undefined : process.env.GROK_HOME)
  return nativeStateRoot(config, homedir, selected, ".grok", "Grok")
}

/** Kimi Code resolves its native state home from the environment, relative to cwd. */
export function kimiConfigRoot(
  config: NodeExternalAgentSpawnConfig,
  homedir: string
): string | undefined {
  if (config.command !== "kimi") return undefined
  const selected = config.env?.KIMI_CODE_HOME ?? process.env.KIMI_CODE_HOME
  return nativeStateRoot(config, homedir, selected, ".kimi-code", "Kimi")
}

/** MiniMax resolves its first nonempty directory alias before ~/.minimax. */
export function minimaxConfigRoot(
  config: NodeExternalAgentSpawnConfig,
  homedir: string
): string | undefined {
  if (config.command !== "mcode") return undefined
  const selected = ["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"]
    .map((key) => config.env?.[key] ?? process.env[key])
    .find((value) => value !== undefined && value.trim().length > 0)
  return nativeStateRoot(config, homedir, selected, ".minimax", "MiniMax")
}

/** GEMINI_HOME redirects file state only; native Keychain credentials remain shared. */
export function antigravityConfigRoot(
  config: NodeExternalAgentSpawnConfig,
  homedir: string
): string | undefined {
  const base = path
    .basename(config.command)
    .toLowerCase()
    .replace(/\.exe$/, "")
  if (base !== "agy_acp_server.par" && base !== "agy_acp_server") return undefined
  if (config.env?.COGNIA_BOT_ISOLATION === "1")
    throw new Error("Antigravity ACP cannot isolate native Keychain credentials for Bot execution")
  let selected = config.env?.GEMINI_HOME ?? process.env.GEMINI_HOME
  if (selected === "~") selected = homedir
  else if (selected?.startsWith("~/")) selected = path.join(homedir, selected.slice(2))
  return nativeStateRoot(config, homedir, selected || undefined, ".gemini", "Antigravity ACP")
}

/** Documented native relocation variables, with the same ownership checks as other agents. */
export function additionalNativeHome(
  config: NodeExternalAgentSpawnConfig,
  homedir: string
): { key: string; root: string } | undefined {
  const definitions: Record<string, readonly [string, string]> = {
    openclaude: ["OPENCLAUDE_CONFIG_DIR", ".openclaude"],
    "vibe-acp": ["VIBE_HOME", ".vibe"],
    mimo: ["MIMOCODE_HOME", ".local/share/mimocode"],
    hermes: ["HERMES_HOME", ".hermes"],
  }
  const definition =
    definitions[
      path
        .basename(config.command)
        .replace(/\.exe$/i, "")
        .toLowerCase()
    ]
  if (!definition) return undefined
  const [key, directory] = definition
  const selected = config.env?.[key] ?? process.env[key]
  if (selected === undefined) return undefined
  return { key, root: nativeStateRoot(config, homedir, selected, directory, key) }
}

function nativeStateRoot(
  config: NodeExternalAgentSpawnConfig,
  homedir: string,
  selected: string | undefined,
  defaultDirectory: string,
  label: string
): string {
  if (selected !== undefined && !selected.trim())
    throw new Error(`${label} state directory must not be empty`)
  const bot = config.env?.COGNIA_BOT_ISOLATION === "1"
  const home = bot
    ? config.env?.COGNIA_BOT_STATE_DIR
    : (config.env?.COGNIA_GATEWAY_TASK_HOME ?? homedir)
  if (!home || !path.isAbsolute(home))
    throw new Error(`${label} requires an absolute state directory`)
  // Preserve whitespace in nonempty native paths; upstream does not trim these.
  const root =
    selected !== undefined
      ? path.resolve(config.cwd ?? homedir, selected)
      : path.join(home, defaultDirectory)
  const relative = path.relative(home, root)
  if (
    bot &&
    (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  )
    throw new Error(`${label} state directory must stay inside the Bot state directory`)
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
      throw new Error(`${label} state directory must stay inside the Bot state directory`)
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
  if (registeredNativeBridgeId(config.command, config.args ?? []) === "crush-http")
    return policyAgentStateWritableRoots("crush", []).map((root) => path.join(homedir, root))
  const additional = additionalNativeHome(config, homedir)
  if (additional) return [additional.root]
  const antigravityRoot = antigravityConfigRoot(config, homedir)
  if (antigravityRoot)
    return [path.join(antigravityRoot, "antigravity-acp"), path.join(antigravityRoot, "artifacts")]
  const grokRoot = grokConfigRoot(config, homedir)
  if (grokRoot) return [grokRoot]
  const minimaxRoot = minimaxConfigRoot(config, homedir)
  if (minimaxRoot) return [minimaxRoot]
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
  validateExternalAgentSandboxPolicy(config.sandboxPolicy)
  const hermesHelperRoot = registeredHermesProbeStateRoot(
    config.command,
    config.args ?? [],
    config.env,
    hostAgentStateDataDir()
  )
  if (hermesHelperRoot)
    config = {
      ...config,
      env: { ...config.env, HERMES_HOME: path.join(hermesHelperRoot, "hermes") },
      sandboxPolicy: { ...config.sandboxPolicy, readableScope: "workspace" },
    }
  const antigravity = antigravityBundle(config.command)
  if (antigravity)
    config = {
      ...config,
      args:
        runtime.platform === "linux" &&
        !(config.args ?? []).some((arg) => arg === "--uid" || arg.startsWith("--uid="))
          ? ["--uid=", ...(config.args ?? [])]
          : config.args,
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
  let env: Record<string, string> | undefined = hermesHelperRoot
    ? { HERMES_HOME: path.join(hermesHelperRoot, "hermes"), HERMES_TUI_GATEWAY_URL: "" }
    : undefined
  const antigravityRoot = antigravityConfigRoot(config, runtime.homedir)
  if (antigravity && antigravityRoot) {
    const temp = path.join(antigravityRoot, "antigravity-acp", "tmp")
    runtime.ensureDir?.(temp)
    env = {
      GEMINI_HOME: antigravityRoot,
      ANTIGRAVITY_HARNESS_PATH: antigravity.harnessPath,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
    }
  }
  if (registeredNativeBridgeId(config.command, config.args ?? []) === "crush-http")
    env = { TMPDIR: toolHostRuntimeDir(), TMP: toolHostRuntimeDir(), TEMP: toolHostRuntimeDir() }
  const additional = additionalNativeHome(config, runtime.homedir)
  if (additional) {
    const helperRoot = registeredHermesProbeStateRoot(
      config.command,
      config.args ?? [],
      config.env,
      hostAgentStateDataDir()
    )
    const temp = path.join(additional.root, "tmp")
    if (!helperRoot) runtime.ensureDir?.(temp)
    env = {
      [additional.key]: additional.root,
      ...(!helperRoot ? { TMPDIR: temp, TMP: temp, TEMP: temp } : {}),
    }
  }
  const grokRoot = grokConfigRoot(config, runtime.homedir)
  if (grokRoot) {
    const temp = path.join(grokRoot, "tmp")
    runtime.ensureDir?.(temp)
    env = {
      GROK_HOME: grokRoot,
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_CHANGELOG_OFFLINE: "1",
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
    }
  }
  const minimaxRoot = minimaxConfigRoot(config, runtime.homedir)
  if (minimaxRoot) {
    const temp = path.join(minimaxRoot, "tmp")
    runtime.ensureDir?.(temp)
    env = {
      MINIMAX_DATA_DIR: minimaxRoot,
      MAVIS_DATA_DIR: minimaxRoot,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
    }
  }
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
  if (
    /(?:^|[\\/])goose(?:\.exe)?$/i.test(config.command) &&
    config.env?.COGNIA_BOT_ISOLATION !== "1"
  ) {
    const temp =
      isolation && config.env?.GOOSE_PATH_ROOT
        ? path.join(config.env.GOOSE_PATH_ROOT, "state/tmp")
        : path.join(
            config.env?.COGNIA_GATEWAY_TASK_HOME ?? runtime.homedir,
            ".local/state/goose/tmp"
          )
    runtime.ensureDir?.(temp)
    env = { TMPDIR: temp, TMP: temp, TEMP: temp }
  }
  runtime.ensureDir?.(toolHostRuntimeDir())
  for (const root of agentStateFileRoots(config, runtime.homedir, isolation))
    runtime.ensureFile?.(root)
  const args = buildSandboxLauncherArgs(config, runtime.homedir, isolation)
  // Preserve the configured runtime identity while deriving state roots; a
  // system-installed symlink may point at a release executable with another name.
  if (antigravity) args[args.indexOf("--") + 1] = antigravity.executablePath
  return {
    command: launcher,
    args,
    ...(env ? { env } : {}),
  }
}
