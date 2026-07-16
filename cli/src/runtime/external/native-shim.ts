import { agentInvoke, agentListen } from "./host-branch"

export interface ExternalAgentSpawnConfig {
  id: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}
export interface ExternalAgentSpawnEvent {
  agentId: string
  status: string
}
export interface ExternalAgentStdoutEvent {
  agentId: string
  data: string
}
export interface ExternalAgentStderrEvent {
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
export interface ExternalAgentInfo {
  id: string
  pid: number | null
  state: string
  command: string
  args: string[]
  cwd: string | null
  env: Record<string, string>
}
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

export const onExternalAgentSpawn = (
  callback: (event: ExternalAgentSpawnEvent) => void
): Promise<() => void> => agentListen("external-agent://spawn", callback)
export const onExternalAgentStdout = (
  callback: (event: ExternalAgentStdoutEvent) => void
): Promise<() => void> => agentListen("external-agent://stdout", callback)
export const onExternalAgentStderr = (
  callback: (event: ExternalAgentStderrEvent) => void
): Promise<() => void> => agentListen("external-agent://stderr", callback)
export const onExternalAgentExit = (
  callback: (event: ExternalAgentExitEvent) => void
): Promise<() => void> => agentListen("external-agent://exit", callback)
export const onExternalAgentStateChange = (
  callback: (event: ExternalAgentStateChangeEvent) => void
): Promise<() => void> => agentListen("external-agent://state-change", callback)
