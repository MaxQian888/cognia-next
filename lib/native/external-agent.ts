/**
 * External Agent API
 *
 * Provides TypeScript wrappers for external agent and ACP terminal management.
 * Used for spawning, managing, and communicating with external agent processes.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, UnlistenFn } from "@tauri-apps/api/event"

// ============================================================================
// Types
// ============================================================================

/** External agent spawn configuration */
export interface ExternalAgentSpawnConfig {
  id: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  /**
   * How the host delivers stdout. Defaults to `"line"` (stripped lines on
   * `external-agent://stdout`); `"raw"` forwards undecoded base64 chunks on
   * `external-agent://stdout-raw`.
   *
   * Only `pi-rpc` opts into `"raw"` — its JSONL frames are delimited by the
   * `\n` byte alone and its adapter owns a strict LF codec with frame/buffer
   * ceilings that pre-split lines would put out of reach. Mirrors
   * `ExternalAgentStdoutFraming` in
   * `crates/cognia-external-agent/src/process.rs` and
   * `cli/src/runtime/external/node-backend.ts`.
   */
  framing?: "line" | "raw"
}

/** Terminal state */
export type TerminalState =
  | { type: "Running" }
  | { type: "Exited"; code: number }
  | { type: "Killed" }
  | { type: "Error"; message: string }

/** Terminal output result */
export interface TerminalExitStatus {
  exitCode: number | null
  signal: string | null
}

/** Terminal output result */
export interface TerminalOutputResult {
  output: string
  truncated: boolean
  exitStatus: TerminalExitStatus
  exitCode?: number | null
}

/** Terminal wait result */
export interface TerminalWaitResult {
  exitStatus: TerminalExitStatus
  exitCode?: number | null
}

/** Terminal info */
export interface TerminalInfo {
  id: string
  sessionId: string
  command: string
  state: TerminalState
  exitCode: number | null
  exitStatus?: TerminalExitStatus
}

/** External agent event payloads */
export interface ExternalAgentSpawnEvent {
  agentId: string
  status: string
}

export interface ExternalAgentStdoutEvent {
  agentId: string
  data: string
}

export interface ExternalAgentExitEvent {
  agentId: string
  code: number
  signal?: string | null
}

export interface ExternalAgentStateChangeEvent {
  agentId: string
  state: "Starting" | "Running" | "Stopping" | "Stopped" | "Failed"
}

export interface ExternalAgentStderrEvent {
  agentId: string
  data: string
}

// ============================================================================
// External Agent Commands
// ============================================================================

export async function spawnExternalAgent(config: ExternalAgentSpawnConfig): Promise<string> {
  return invoke<string>("spawn_external_agent", { config })
}

export async function sendToExternalAgent(agentId: string, message: string): Promise<void> {
  return invoke<void>("send_to_external_agent", { agentId, message })
}

export async function killExternalAgent(agentId: string): Promise<void> {
  return invoke<void>("kill_external_agent", { agentId })
}

export async function getExternalAgentStatus(agentId: string): Promise<string> {
  return invoke<string>("get_external_agent_status", { agentId })
}

export async function listExternalAgents(): Promise<string[]> {
  return invoke<string[]>("list_external_agents")
}

export async function killAllExternalAgents(): Promise<void> {
  return invoke<void>("kill_all_external_agents")
}

export async function isExternalAgentRunning(agentId: string): Promise<boolean> {
  return invoke<boolean>("is_external_agent_running", { agentId })
}

/**
 * Check whether a local command exists on PATH. Used by the ecosystem
 * readiness layer (`getExternalAgentEcosystemReadiness`) when deciding
 * whether a preset is executable.
 */
export async function checkExternalAgentCommandExists(command: string): Promise<boolean> {
  return invoke<boolean>("check_command_exists", { command })
}

export interface ExternalAgentInfo {
  id: string
  pid: number | null
  state: string
  command: string
  args: string[]
  cwd: string | null
  env: Record<string, string>
}

export async function getExternalAgentInfo(agentId: string): Promise<ExternalAgentInfo> {
  return invoke<ExternalAgentInfo>("get_external_agent_info", { agentId })
}

export async function setExternalAgentRunning(agentId: string): Promise<void> {
  return invoke<void>("set_external_agent_running", { agentId })
}

export async function setExternalAgentFailed(agentId: string): Promise<void> {
  return invoke<void>("set_external_agent_failed", { agentId })
}

// ============================================================================
// ACP Terminal Commands
// ============================================================================

export async function acpTerminalCreate(
  sessionId: string,
  command: string,
  args: string[] = [],
  cwd?: string,
  env?: Record<string, string>,
  outputByteLimit?: number
): Promise<string> {
  return invoke<string>("acp_terminal_create", {
    sessionId,
    command,
    args,
    cwd,
    env,
    outputByteLimit,
  })
}

export async function acpTerminalOutput(
  terminalId: string,
  outputByteLimit?: number
): Promise<TerminalOutputResult> {
  return invoke<TerminalOutputResult>("acp_terminal_output", {
    terminalId,
    outputByteLimit,
  })
}

export async function acpTerminalKill(terminalId: string): Promise<void> {
  return invoke<void>("acp_terminal_kill", { terminalId })
}

export async function acpTerminalRelease(terminalId: string): Promise<void> {
  return invoke<void>("acp_terminal_release", { terminalId })
}

export async function acpTerminalWaitForExit(
  terminalId: string,
  timeout?: number
): Promise<TerminalWaitResult> {
  return invoke<TerminalWaitResult>("acp_terminal_wait_for_exit", {
    terminalId,
    timeout,
  })
}

export async function acpTerminalWrite(terminalId: string, data: string): Promise<void> {
  return invoke<void>("acp_terminal_write", { terminalId, data })
}

export async function acpTerminalGetSessionTerminals(sessionId: string): Promise<string[]> {
  return invoke<string[]>("acp_terminal_get_session_terminals", { sessionId })
}

export async function acpTerminalKillSessionTerminals(sessionId: string): Promise<void> {
  return invoke<void>("acp_terminal_kill_session_terminals", { sessionId })
}

export async function acpTerminalIsRunning(terminalId: string): Promise<boolean> {
  return invoke<boolean>("acp_terminal_is_running", { terminalId })
}

export async function acpTerminalGetInfo(terminalId: string): Promise<TerminalInfo> {
  return invoke<TerminalInfo>("acp_terminal_get_info", { terminalId })
}

export async function acpTerminalList(): Promise<string[]> {
  return invoke<string[]>("acp_terminal_list")
}

// ============================================================================
// Event Listeners
// ============================================================================

export async function onExternalAgentSpawn(
  callback: (event: ExternalAgentSpawnEvent) => void
): Promise<UnlistenFn> {
  return listen<ExternalAgentSpawnEvent>("external-agent://spawn", (event) => {
    callback(event.payload)
  })
}

export async function onExternalAgentStdout(
  callback: (event: ExternalAgentStdoutEvent) => void
): Promise<UnlistenFn> {
  return listen<ExternalAgentStdoutEvent>("external-agent://stdout", (event) => {
    callback(event.payload)
  })
}

export async function onExternalAgentExit(
  callback: (event: ExternalAgentExitEvent) => void
): Promise<UnlistenFn> {
  return listen<ExternalAgentExitEvent>("external-agent://exit", (event) => {
    callback(event.payload)
  })
}

export async function onExternalAgentStateChange(
  callback: (event: ExternalAgentStateChangeEvent) => void
): Promise<UnlistenFn> {
  return listen<ExternalAgentStateChangeEvent>("external-agent://state-change", (event) => {
    callback(event.payload)
  })
}

export async function onExternalAgentStderr(
  callback: (event: ExternalAgentStderrEvent) => void
): Promise<UnlistenFn> {
  return listen<ExternalAgentStderrEvent>("external-agent://stderr", (event) => {
    callback(event.payload)
  })
}

// ============================================================================
// High-level Helpers
// ============================================================================

/**
 * Execute a command in a terminal and wait for it to complete
 */
export async function executeCommand(
  sessionId: string,
  command: string,
  args: string[] = [],
  options?: {
    cwd?: string
    timeout?: number
    onOutput?: (output: string) => void
  }
): Promise<{ output: string; exitCode: number }> {
  const terminalId = await acpTerminalCreate(sessionId, command, args, options?.cwd)

  try {
    if (options?.onOutput) {
      const pollInterval = setInterval(async () => {
        try {
          const result = await acpTerminalOutput(terminalId)
          if (result.output) {
            options.onOutput!(result.output)
          }
        } catch {
          // Terminal may have been released
        }
      }, 100)

      try {
        const waitResult = await acpTerminalWaitForExit(terminalId, options?.timeout)
        clearInterval(pollInterval)

        const result = await acpTerminalOutput(terminalId)
        return {
          output: result.output,
          exitCode: waitResult.exitStatus.exitCode ?? -1,
        }
      } catch (error) {
        clearInterval(pollInterval)
        throw error
      }
    }

    const waitResult = await acpTerminalWaitForExit(terminalId, options?.timeout)
    const result = await acpTerminalOutput(terminalId)
    return {
      output: result.output,
      exitCode: waitResult.exitStatus.exitCode ?? -1,
    }
  } finally {
    await acpTerminalRelease(terminalId).catch(() => {
      // ignore
    })
  }
}

export async function createInteractiveTerminal(
  sessionId: string,
  command: string,
  args: string[] = [],
  cwd?: string
): Promise<{
  terminalId: string
  write: (data: string) => Promise<void>
  read: () => Promise<TerminalOutputResult>
  isRunning: () => Promise<boolean>
  kill: () => Promise<void>
  waitForExit: (timeout?: number) => Promise<TerminalWaitResult>
  release: () => Promise<void>
}> {
  const terminalId = await acpTerminalCreate(sessionId, command, args, cwd)

  return {
    terminalId,
    write: (data: string) => acpTerminalWrite(terminalId, data),
    read: () => acpTerminalOutput(terminalId),
    isRunning: () => acpTerminalIsRunning(terminalId),
    kill: () => acpTerminalKill(terminalId),
    waitForExit: (timeout?: number) => acpTerminalWaitForExit(terminalId, timeout),
    release: () => acpTerminalRelease(terminalId),
  }
}

export async function cleanupSessionTerminals(sessionId: string): Promise<void> {
  await acpTerminalKillSessionTerminals(sessionId)
}
