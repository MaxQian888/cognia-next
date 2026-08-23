/**
 * Agent launcher for `cognia x <agent>`.
 *
 * Spawns an external coding agent CLI (Claude Code, Codex) with environment
 * variables injected so its API calls route through the cognia gateway/proxy.
 * The process inherits stdio (takes over the terminal) and the launcher waits
 * for it to exit.
 */

import { spawn, type SpawnOptions } from "node:child_process"
import { constants as osConstants } from "node:os"

import type { SupportedAgent } from "./detect-cli"

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface AgentLaunchConfig {
  /** Which agent to launch. */
  agent: SupportedAgent
  /** Model to pass to the agent (--model flag). */
  model?: string
  /** Base URL for the proxy/gateway. */
  gatewayBaseUrl: string
  /** API key for the proxy/gateway. */
  gatewayApiKey: string
  /** Working directory for the agent process. */
  cwd: string
  /** Absolute path to the agent binary (from detect-cli). Falls back to name. */
  binaryPath?: string
  /** Extra args to pass through to the agent CLI (after `--`). */
  passthrough?: string[]
  /** Whether to enable auto-approve mode (skip all permission prompts). */
  bypass?: boolean
  /** Resume a previous session by id. */
  resume?: string
}

export interface AgentLaunchDeps {
  /** Injectable process spawner for testing. Returns exit code. */
  spawnAgent?: (cmd: string, args: string[], options: SpawnOptions) => Promise<number>
  /** Bun-native subprocess runtime. Null explicitly selects the Node fallback. */
  bunRuntime?: BunAgentLaunchRuntime | null
}

interface BunInheritedSubprocess {
  exited: Promise<number>
  signalCode: string | number | null
  kill(signal?: NodeJS.Signals): void
}

export interface BunAgentLaunchRuntime {
  spawn(
    command: string[],
    options: {
      cwd: string
      env: NodeJS.ProcessEnv
      stdin: "inherit"
      stdout: "inherit"
      stderr: "inherit"
    }
  ): BunInheritedSubprocess
}

function defaultBunRuntime(): BunAgentLaunchRuntime | undefined {
  const runtime = (globalThis as { Bun?: Partial<BunAgentLaunchRuntime> }).Bun
  return typeof runtime?.spawn === "function" ? (runtime as BunAgentLaunchRuntime) : undefined
}

// ────────────────────────────────────────────────────────────────────────────
// Agent-specific configuration
// ────────────────────────────────────────────────────────────────────────────

interface AgentEnvConfig {
  /** Environment variables to inject. */
  env: Record<string, string>
  /** Command to run. */
  command: string
  /** Arguments to the command. */
  args: string[]
}

function buildClaudeConfig(config: AgentLaunchConfig): AgentEnvConfig {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: config.gatewayBaseUrl,
    ANTHROPIC_API_KEY: config.gatewayApiKey,
    // Suppress Claude Code's own update checker (we manage the lifecycle)
    CLAUDE_CODE_DISABLE_UPDATE_CHECK: "1",
  }

  const args: string[] = []
  if (config.model) {
    args.push("--model", config.model)
  }
  if (config.bypass) {
    args.push("--dangerously-skip-permissions")
  }
  if (config.resume) {
    args.push("--resume", config.resume)
  }
  if (config.passthrough?.length) {
    args.push(...config.passthrough)
  }

  return { env, command: config.binaryPath ?? "claude", args }
}

function buildCodexConfig(config: AgentLaunchConfig): AgentEnvConfig {
  const env: Record<string, string> = {
    OPENAI_BASE_URL: config.gatewayBaseUrl,
    OPENAI_API_KEY: config.gatewayApiKey,
  }

  const args: string[] = []
  if (config.model) {
    args.push("--model", config.model)
  }
  if (config.bypass) {
    args.push("--full-auto")
  }
  if (config.resume) {
    args.push("resume", config.resume)
  }
  if (config.passthrough?.length) {
    args.push(...config.passthrough)
  }

  return { env, command: config.binaryPath ?? "codex", args }
}

// ────────────────────────────────────────────────────────────────────────────
// Launcher
// ────────────────────────────────────────────────────────────────────────────

/**
 * Launch an external coding agent CLI.
 *
 * The agent process inherits the current terminal (stdio: "inherit") and the
 * function resolves when the process exits. SIGINT/SIGTERM/SIGWINCH are
 * forwarded to the child so the agent TUI handles terminal resize and
 * graceful shutdown correctly.
 *
 * @returns The agent process exit code.
 */
export async function launchAgent(
  config: AgentLaunchConfig,
  deps: AgentLaunchDeps = {}
): Promise<number> {
  const agentConfig =
    config.agent === "claude" ? buildClaudeConfig(config) : buildCodexConfig(config)

  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...agentConfig.env,
  }

  const options: SpawnOptions = {
    cwd: config.cwd,
    env: mergedEnv,
    stdio: "inherit",
  }

  if (deps.spawnAgent) {
    return deps.spawnAgent(agentConfig.command, agentConfig.args, options)
  }

  const bunRuntime =
    deps.bunRuntime === undefined ? defaultBunRuntime() : (deps.bunRuntime ?? undefined)
  if (bunRuntime) {
    return spawnAndWaitBun(agentConfig.command, agentConfig.args, mergedEnv, config.cwd, bunRuntime)
  }

  return spawnAndWait(agentConfig.command, agentConfig.args, options)
}

async function spawnAndWaitBun(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  runtime: BunAgentLaunchRuntime
): Promise<number> {
  let child: BunInheritedSubprocess
  try {
    child = runtime.spawn([cmd, ...args], {
      cwd,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to start ${cmd}: ${message}`)
  }

  const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal)
  process.on("SIGINT", forwardSignal)
  process.on("SIGTERM", forwardSignal)
  process.on("SIGWINCH", forwardSignal)
  try {
    const code = await child.exited
    if (child.signalCode !== null) {
      const signal = child.signalCode
      return 128 + (typeof signal === "number" ? signal : (signalNumber(signal) ?? 1))
    }
    return code
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to run ${cmd}: ${message}`)
  } finally {
    process.removeListener("SIGINT", forwardSignal)
    process.removeListener("SIGTERM", forwardSignal)
    process.removeListener("SIGWINCH", forwardSignal)
  }
}

/**
 * Spawn a process and wait for exit. Forwards SIGINT/SIGTERM/SIGWINCH to the
 * child so signals and terminal resizes propagate correctly.
 */
function spawnAndWait(cmd: string, args: string[], options: SpawnOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, options)

    // Forward signals to the child process
    const forwardSignal = (signal: NodeJS.Signals) => {
      child.kill(signal)
    }
    process.on("SIGINT", forwardSignal)
    process.on("SIGTERM", forwardSignal)
    process.on("SIGWINCH", forwardSignal)

    child.on("error", (err) => {
      process.removeListener("SIGINT", forwardSignal)
      process.removeListener("SIGTERM", forwardSignal)
      process.removeListener("SIGWINCH", forwardSignal)
      reject(new Error(`Failed to start ${cmd}: ${err.message}`))
    })

    child.on("exit", (code, signal) => {
      process.removeListener("SIGINT", forwardSignal)
      process.removeListener("SIGTERM", forwardSignal)
      process.removeListener("SIGWINCH", forwardSignal)
      if (signal) {
        // Map signal to conventional exit code (128 + signal number)
        resolve(128 + (signalNumber(signal) ?? 1))
      } else {
        resolve(code ?? 1)
      }
    })
  })
}

/** Map common signal names to their numeric code. */
function signalNumber(signal: string): number | undefined {
  return osConstants.signals[signal as keyof typeof osConstants.signals]
}

// ────────────────────────────────────────────────────────────────────────────
// Exported for testing
// ────────────────────────────────────────────────────────────────────────────

/** Build the env+args config without spawning (exposed for unit tests). */
export function buildAgentConfig(config: AgentLaunchConfig): AgentEnvConfig {
  return config.agent === "claude" ? buildClaudeConfig(config) : buildCodexConfig(config)
}
