/**
 * CLI compatibility surface for the shared external-agent manager.
 *
 * Process operations are delegated to the strict Node host. ACP terminal
 * operations fail closed because terminal capability is disabled in CLI v1.
 */
import { agentInvoke, agentListen } from "./host-branch"

/** Configuration accepted by the shared external-agent spawn command. */
export interface ExternalAgentSpawnConfig {
  id: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}
/** Payload emitted after an external agent is spawned. */
export interface ExternalAgentSpawnEvent {
  agentId: string
  status: string
}
/** Chunk emitted from an external agent's standard output. */
export interface ExternalAgentStdoutEvent {
  agentId: string
  data: string
}
/** Chunk emitted from an external agent's standard error. */
export interface ExternalAgentStderrEvent {
  agentId: string
  data: string
}
/** Payload emitted when an external agent exits. */
export interface ExternalAgentExitEvent {
  agentId: string
  code: number
  signal?: string | null
}
/** Payload emitted when an external agent changes lifecycle state. */
export interface ExternalAgentStateChangeEvent {
  agentId: string
  state: "Starting" | "Running" | "Stopping" | "Stopped" | "Failed"
}
/** Runtime information returned for a hosted external agent. */
export interface ExternalAgentInfo {
  id: string
  pid: number | null
  state: string
  command: string
  args: string[]
  cwd: string | null
  env: Record<string, string>
}
/** Terminal state retained only for shared type compatibility. */
export type TerminalState =
  | { type: "Running" }
  | { type: "Exited"; code: number }
  | { type: "Killed" }
  | { type: "Error"; message: string }
export interface TerminalExitStatus {
  exitCode: number | null
  signal: string | null
}
export interface TerminalOutputResult {
  output: string
  truncated: boolean
  exitStatus: TerminalExitStatus
  exitCode?: number | null
}
export interface TerminalWaitResult {
  exitStatus: TerminalExitStatus
  exitCode?: number | null
}
export interface TerminalInfo {
  id: string
  sessionId: string
  command: string
  state: TerminalState
  exitCode: number | null
  exitStatus?: TerminalExitStatus
}

/** Spawn an allowlisted external agent through the strict CLI host. */
export const spawnExternalAgent = (config: ExternalAgentSpawnConfig): Promise<string> =>
  agentInvoke("spawn_external_agent", { config })
export const sendToExternalAgent = (agentId: string, message: string): Promise<void> =>
  agentInvoke("send_to_external_agent", { agentId, message })
export const killExternalAgent = (agentId: string): Promise<void> =>
  agentInvoke("kill_external_agent", { agentId })
export const checkExternalAgentCommandExists = (command: string): Promise<boolean> =>
  agentInvoke("check_command_exists", { command })
export const getExternalAgentStatus = (agentId: string): Promise<string> =>
  agentInvoke("get_external_agent_status", { agentId })
export const listExternalAgents = (): Promise<string[]> => agentInvoke("list_external_agents", {})
export const killAllExternalAgents = (): Promise<void> =>
  agentInvoke("kill_all_external_agents", {})
export const isExternalAgentRunning = (agentId: string): Promise<boolean> =>
  agentInvoke("is_external_agent_running", { agentId })
export const getExternalAgentInfo = (agentId: string): Promise<ExternalAgentInfo> =>
  agentInvoke("get_external_agent_info", { agentId })
export const setExternalAgentRunning = (agentId: string): Promise<void> =>
  agentInvoke("set_external_agent_running", { agentId })
export const setExternalAgentFailed = (agentId: string): Promise<void> =>
  agentInvoke("set_external_agent_failed", { agentId })

/** Reject terminal operations because CLI v1 advertises no ACP terminal capability. */
const terminalUnsupported = async (..._args: unknown[]): Promise<never> => {
  throw new Error("ACP terminals are unsupported in the CLI")
}
export const acpTerminalCreate = terminalUnsupported
export const acpTerminalOutput = terminalUnsupported
export const acpTerminalKill = terminalUnsupported
export const acpTerminalRelease = terminalUnsupported
export const acpTerminalWaitForExit = terminalUnsupported
export const acpTerminalWrite = terminalUnsupported
export const acpTerminalGetSessionTerminals = terminalUnsupported
export const acpTerminalKillSessionTerminals = terminalUnsupported
export const acpTerminalIsRunning = terminalUnsupported
export const acpTerminalGetInfo = terminalUnsupported
export const acpTerminalList = terminalUnsupported
export const executeCommand = terminalUnsupported
export const createInteractiveTerminal = terminalUnsupported
export const cleanupSessionTerminals = terminalUnsupported

/** Subscribe to external-agent spawn events from the Node host. */
export const onExternalAgentSpawn = (
  callback: (event: ExternalAgentSpawnEvent) => void
): Promise<() => void> => agentListen("external-agent://spawn", callback)
/** Subscribe to external-agent stdout chunks from the Node host. */
export const onExternalAgentStdout = (
  callback: (event: ExternalAgentStdoutEvent) => void
): Promise<() => void> => agentListen("external-agent://stdout", callback)
/** Subscribe to external-agent stderr chunks from the Node host. */
export const onExternalAgentStderr = (
  callback: (event: ExternalAgentStderrEvent) => void
): Promise<() => void> => agentListen("external-agent://stderr", callback)
/** Subscribe to external-agent exit events from the Node host. */
export const onExternalAgentExit = (
  callback: (event: ExternalAgentExitEvent) => void
): Promise<() => void> => agentListen("external-agent://exit", callback)
/** Subscribe to external-agent lifecycle transitions from the Node host. */
export const onExternalAgentStateChange = (
  callback: (event: ExternalAgentStateChangeEvent) => void
): Promise<() => void> => agentListen("external-agent://state-change", callback)
