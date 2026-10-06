/**
 * The external-agent host a non-app shell installs at startup (ADR-0217).
 *
 * The app reaches its process plane through Tauri, a paired Host or the
 * headless brain (`../agent-transport.ts`), its ACP terminals through Tauri
 * commands (`@/lib/native/external-agent`) and its hook runtime through
 * `run_agent_hook` (`../agent-hooks.ts`). A shell that owns its own process
 * table, today the standalone CLI, installs one object implementing those three
 * planes before any agent code runs. Each of the three modules asks
 * {@link getInstalledExternalAgentHost} at call time and, when a host is
 * installed, delegates to it instead of to the app's own transports. Nothing in
 * the shared graph is swapped at build time.
 *
 * The process plane keeps the app's command vocabulary (`spawn_external_agent`,
 * `check_command_exists`, the `external-agent://*` event channels), because the
 * typed ports the packages consume (`./process-host.ts`, `./file-host.ts`,
 * `./terminal-host.ts`) are built over those calls for every host.
 */

import type { AcpHostCapabilities } from "@cognia/agent-acp/feature-profile"
import type {
  TerminalInfo,
  TerminalOutputResult,
  TerminalWaitResult,
} from "@/lib/native/external-agent"
import type { AgentHookContext, AgentHookDecision } from "../agent-hooks"

/** Process commands, event channels, workspace files and capability truth. */
export interface InstalledExternalAgentProcessPlane {
  supportsExternalAgents(): boolean
  runsExternalAgentProcessesLocally(): boolean
  supportsAgentFs(): boolean
  supportsAgentTerminal(): boolean
  getAcpHostCapabilities(): AcpHostCapabilities
  /** A process-plane command by its app name; the host owns spawn placement. */
  invoke<T>(name: string, args: Record<string, unknown>): Promise<T>
  /** An `external-agent://*` channel; the handler receives the raw payload. */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>
  readTextFile(path: string, allowedRoots: string[]): Promise<string>
  writeTextFile(path: string, content: string, allowedRoots: string[]): Promise<void>
  deleteTextFile(path: string, allowedRoots: string[]): Promise<void>
  /** Base64 content of a runtime attachment inside the session roots. */
  readBinaryFile(path: string, allowedRoots: string[]): Promise<string>
  writeBinaryFile(path: string, base64: string, allowedRoots: string[]): Promise<void>
  /** Immediate files of a directory inside the session roots. */
  listFiles(path: string, allowedRoots: string[]): Promise<string[]>
}

/** The ACP terminal commands (`acp_terminal_*` in the desktop app). */
export interface InstalledExternalAgentTerminalPlane {
  create(
    sessionId: string,
    command: string,
    args: string[],
    cwd?: string,
    env?: Record<string, string>,
    outputByteLimit?: number
  ): Promise<string>
  output(terminalId: string, outputByteLimit?: number): Promise<TerminalOutputResult>
  kill(terminalId: string): Promise<void>
  release(terminalId: string): Promise<void>
  waitForExit(terminalId: string, timeout?: number): Promise<TerminalWaitResult>
  write(terminalId: string, data: string): Promise<void>
  sessionTerminals(sessionId: string): Promise<string[]>
  killSessionTerminals(sessionId: string): Promise<void>
  isRunning(terminalId: string): Promise<boolean>
  info(terminalId: string): Promise<TerminalInfo>
  list(): Promise<string[]>
}

/** The plugin event hooks an external-agent run dispatches (System A). */
export interface InstalledExternalAgentPluginHooks {
  dispatchExternalAgentToolCall(
    agentId: string,
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>
  ): void
  dispatchExternalAgentPermissionRequest(
    agentId: string,
    sessionId: string,
    toolName: string,
    reason?: string
  ): void
}

/** The hook runtime: settings hooks (System B) and plugin event hooks (System A). */
export interface InstalledExternalAgentHookPlane {
  /** One settings-hook event; `null` when no hook ran or the host runs none. */
  run(
    event: string,
    ctx: AgentHookContext,
    opts?: { toolName?: string; payload?: Record<string, unknown> }
  ): Promise<AgentHookDecision | null>
  /** `null` when the host loads no plugin event hooks. */
  pluginHooks: InstalledExternalAgentPluginHooks | null
}

export interface InstalledExternalAgentHost {
  /** Which shell installed it, for diagnostics. */
  readonly kind: string
  readonly process: InstalledExternalAgentProcessPlane
  readonly terminals: InstalledExternalAgentTerminalPlane
  readonly hooks: InstalledExternalAgentHookPlane
}

let installed: InstalledExternalAgentHost | null = null

/**
 * Install the shell's external-agent host. Returns the uninstall function.
 * A second install while one is active is refused: two hosts would split the
 * process table, and a process id would no longer name one process.
 */
export function installExternalAgentHost(host: InstalledExternalAgentHost): () => void {
  if (installed && installed !== host) {
    throw new Error(
      `An external-agent host (${installed.kind}) is already installed; uninstall it first`
    )
  }
  installed = host
  return () => {
    if (installed === host) installed = null
  }
}

/** The installed host, or `null` in the app, which uses its own transports. */
export function getInstalledExternalAgentHost(): InstalledExternalAgentHost | null {
  return installed
}
