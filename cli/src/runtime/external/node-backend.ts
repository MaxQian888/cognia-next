import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

import {
  agentSearchDirs,
  defaultAgentPathRuntime,
  resolveAgentSearchPath,
  type AgentPathRuntime,
} from "./agent-path"

export interface NodeExternalAgentSpawnConfig {
  id: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface ExternalAgentLaunch {
  command: string
  args: string[]
}

export type ExternalAgentLaunchResolver = (
  config: NodeExternalAgentSpawnConfig
) => Promise<ExternalAgentLaunch>

export interface NodeExternalAgentBackendOptions {
  workspacesRoot?: string
  allowSmokeAgent?: boolean
  resolveLaunch?: ExternalAgentLaunchResolver
}

const CHANNEL = {
  stdout: "external-agent://stdout",
  stderr: "external-agent://stderr",
  exit: "external-agent://exit",
  state: "external-agent://state-change",
  spawn: "external-agent://spawn",
} as const

const BINARY_ALLOWLIST = new Set([
  "claude",
  "claude-agent-acp",
  "claude-code-acp",
  "codex",
  "codex-acp",
  "opencode",
  "cursor-agent",
  "cline",
  "gemini",
  "copilot",
  "kiro-cli",
  "droid",
])
const NPX_ALLOWLIST = new Set([
  "@agentclientprotocol/claude-agent-acp",
  "@zed-industries/claude-code-acp",
  "@zed-industries/codex-acp",
  "@anthropic-ai/claude-code",
  "@google/gemini-cli",
  "@qwen-code/qwen-code",
  "pi-acp",
  "opencode-ai",
])
const CONFIG_ENV_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "TERM",
  "LANG",
  "LC_ALL",
])
const RUNTIME_ENV_KEYS = new Set([
  "PATH",
  "PWD",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "LC_CTYPE",
  "NVM_BIN",
  "NVM_DIR",
  "NVM_INC",
  "PNPM_HOME",
  "BUN_INSTALL",
  "__CF_USER_TEXT_ENCODING",
  "__CFBundleIdentifier",
  "XPC_FLAGS",
  "XPC_SERVICE_NAME",
  "MallocNanoZone",
  "OSLogRateLimit",
  // External CLIs perform their own update checks unless their launcher sets
  // this conventional switch. Preserve the parent's explicit opt-out so an
  // ACP session/new cannot stall behind an updater inside the sandbox.
  "DISABLE_AUTO_UPDATE",
])
const CONFIG_ENV_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_",
  "OPENAI_",
  "CODEX_",
  "GEMINI_",
  "GOOGLE_",
  "OPENCODE_",
  "CURSOR_",
  "COPILOT_",
  "GITHUB_",
  "GH_",
  "QWEN_",
  "KIRO_",
  "FACTORY_",
  "DROID_",
  "ACP_",
  "COGNIA_AGENT_",
]
const DANGEROUS_ENV =
  /^(?:LD_|DYLD_|NODE_OPTIONS$|GCONV_PATH$|GIT_CONFIG_|HOSTALIASES$|NLSPATH$|RESOLV_HOST_CONF$|PSMODULEPATH$|PSEXECUTIONPOLICYPREFERENCE$)/i

interface ProcessRecord {
  child: ChildProcessWithoutNullStreams
  stopping: boolean
}

function baseCommand(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, "")
}

function validateCommand(config: NodeExternalAgentSpawnConfig, smoke: boolean): void {
  const command = config.command.trim()
  if (!command) throw new Error("empty command")
  if (command.includes("/") || command.includes("\\")) {
    throw new Error(`command must be a bare allowlisted binary name, got a path: ${command}`)
  }
  const base = baseCommand(command)
  if (BINARY_ALLOWLIST.has(base)) return
  if (base === "npx") {
    const pkg = (config.args ?? []).find((arg) => !arg.startsWith("-"))
    if (pkg && NPX_ALLOWLIST.has(pkg)) return
    throw new Error(`npx package ${pkg ?? "<missing>"} is not in the allowlist`)
  }
  const stub = path.basename(config.args?.[0] ?? "") === "stub-acp-agent.mjs"
  if (base === "node" && smoke && stub) return
  throw new Error(`binary ${command} is not in the external-agent allowlist`)
}

function validateCwd(root: string, requested?: string): string {
  fs.mkdirSync(root, { recursive: true })
  const canonicalRoot = fs.realpathSync(root)
  const candidate = requested
    ? path.isAbsolute(requested)
      ? requested
      : path.join(canonicalRoot, requested)
    : canonicalRoot
  const canonical = fs.realpathSync(candidate)
  const relative = path.relative(canonicalRoot, canonical)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`cwd ${canonical} escapes the workspaces root ${canonicalRoot}`)
  }
  return canonical
}

export function buildExternalAgentChildEnv(
  ambient: NodeJS.ProcessEnv,
  overrides: Record<string, string> | undefined
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: ambient.NODE_ENV ?? "production" }
  for (const [key, value] of Object.entries(ambient)) {
    if (
      !DANGEROUS_ENV.test(key) &&
      (RUNTIME_ENV_KEYS.has(key) ||
        CONFIG_ENV_KEYS.has(key) ||
        CONFIG_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
    ) {
      env[key] = value
    }
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (
      !DANGEROUS_ENV.test(key) &&
      (CONFIG_ENV_KEYS.has(key) || CONFIG_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
    ) {
      env[key] = value
    }
  }
  return env
}

async function defaultResolveLaunch(
  config: NodeExternalAgentSpawnConfig
): Promise<ExternalAgentLaunch> {
  const { resolveSandboxedExternalAgentLaunch } = await import("./sandbox-launcher")
  return resolveSandboxedExternalAgentLaunch(config)
}

export class NodeExternalAgentBackend {
  private readonly events = new EventEmitter()
  private readonly processes = new Map<string, ProcessRecord>()
  private readonly workspacesRoot: string
  private readonly allowSmokeAgent: boolean
  private readonly resolveLaunch: ExternalAgentLaunchResolver

  constructor(options: NodeExternalAgentBackendOptions = {}) {
    this.workspacesRoot = path.resolve(
      options.workspacesRoot ?? process.env.COGNIA_WORKSPACES_DIR ?? process.cwd()
    )
    this.allowSmokeAgent = options.allowSmokeAgent ?? process.env.COGNIA_SMOKE_AGENT === "1"
    this.resolveLaunch = options.resolveLaunch ?? defaultResolveLaunch
  }

  listen<T>(channel: string, handler: (payload: T) => void): () => void {
    this.events.on(channel, handler)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.events.off(channel, handler)
    }
  }

  async invoke<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    switch (name) {
      case "spawn_external_agent":
        return (await this.spawn(args.config as NodeExternalAgentSpawnConfig)) as T
      case "send_to_external_agent":
        await this.send(String(args.agentId), String(args.message))
        return undefined as T
      case "kill_external_agent":
        await this.kill(String(args.agentId))
        return undefined as T
      case "check_command_exists":
        return (await commandExists(String(args.command))) as T
      default:
        throw new Error(`unsupported external-agent command: ${name}`)
    }
  }

  private emit(channel: string, payload: unknown): void {
    this.events.emit(channel, payload)
  }

  private async spawn(config: NodeExternalAgentSpawnConfig): Promise<string> {
    if (this.processes.has(config.id)) throw new Error(`agent already running: ${config.id}`)
    validateCommand(config, this.allowSmokeAgent)
    const cwd = validateCwd(this.workspacesRoot, config.cwd)
    const normalized = { ...config, cwd }
    const launch = await this.resolveLaunch(normalized)
    this.emit(CHANNEL.spawn, { agentId: config.id, status: "starting" })
    this.emit(CHANNEL.state, { agentId: config.id, state: "Starting" })
    const env = buildExternalAgentChildEnv(process.env, config.env)
    // The launcher child (and the sandboxed exec it starts) resolves the agent
    // binary from PATH, so it must see the SAME enriched search path the
    // readiness probe used — otherwise a binary the probe found in a fallback
    // install root (Homebrew, ~/.cargo/bin, a native installer's dir) would be
    // reported present yet fail to spawn.
    env.PATH = resolveAgentSearchPath()
    const child = spawn(launch.command, launch.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    const record: ProcessRecord = { child, stopping: false }
    this.processes.set(config.id, record)
    readline.createInterface({ input: child.stdout }).on("line", (data) => {
      this.emit(CHANNEL.stdout, { agentId: config.id, data })
    })
    readline.createInterface({ input: child.stderr }).on("line", (data) => {
      this.emit(CHANNEL.stderr, { agentId: config.id, data })
    })
    child.once("spawn", () => {
      this.emit(CHANNEL.state, { agentId: config.id, state: "Running" })
    })
    child.once("error", (error) => {
      this.processes.delete(config.id)
      this.emit(CHANNEL.state, { agentId: config.id, state: "Failed" })
      this.emit(CHANNEL.stderr, { agentId: config.id, data: error.message })
    })
    child.once("exit", (code, signal) => {
      this.processes.delete(config.id)
      this.emit(CHANNEL.state, { agentId: config.id, state: "Stopped" })
      this.emit(CHANNEL.exit, { agentId: config.id, code: code ?? 0, signal })
    })
    return config.id
  }

  private async send(agentId: string, message: string): Promise<void> {
    const record = this.processes.get(agentId)
    if (!record) throw new Error(`agent not running: ${agentId}`)
    await new Promise<void>((resolve, reject) => {
      record.child.stdin.write(message.endsWith("\n") ? message : `${message}\n`, (error) =>
        error ? reject(error) : resolve()
      )
    })
  }

  private async kill(agentId: string): Promise<void> {
    const record = this.processes.get(agentId)
    if (!record) throw new Error(`agent not running: ${agentId}`)
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(escalate)
        resolve()
      }
      const signal = (name: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && record.child.pid) {
            process.kill(-record.child.pid, name)
          } else {
            record.child.kill(name)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") done()
          else throw error
        }
      }
      record.child.once("exit", done)
      const escalate = setTimeout(() => signal("SIGKILL"), 2_000)
      escalate.unref()
      if (!record.stopping) {
        record.stopping = true
        this.emit(CHANNEL.state, { agentId, state: "Stopping" })
        signal("SIGTERM")
      }
      if (record.child.exitCode !== null || record.child.signalCode !== null) done()
    })
  }
}

export async function commandExists(
  command: string,
  runtime: AgentPathRuntime = defaultAgentPathRuntime()
): Promise<boolean> {
  const trimmed = command.trim()
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) return false
  // Search the enriched set — process PATH plus the well-known install roots a
  // minimal (non-login-shell) environment omits — so an installed agent binary
  // is never reported missing merely because PATH was stripped. Mirrors the Rust
  // `command_resolver::check_command_exists`.
  const dirs = agentSearchDirs(runtime)
  const extensions =
    runtime.platform === "win32" ? (runtime.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""]
  return dirs.some((dir) =>
    extensions.some((extension) => {
      try {
        fs.accessSync(path.join(dir, `${trimmed}${extension}`), fs.constants.X_OK)
        return true
      } catch {
        return false
      }
    })
  )
}
