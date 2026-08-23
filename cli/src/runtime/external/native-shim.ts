/**
 * CLI compatibility surface for the shared external-agent manager.
 *
 * Process operations are delegated to the strict Node host. On Unix hosts the
 * ACP terminal family is backed by node-pty; Windows continues to fail closed
 * and omits the capability at initialize time.
 */
import { randomUUID } from "node:crypto"
import { chmodSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { spawn as spawnPty, type IDisposable, type IPty } from "node-pty"

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

interface CliAcpTerminal {
  id: string
  sessionId: string
  command: string
  pty: IPty
  output: string
  defaultOutputByteLimit?: number
  exitStatus: TerminalExitStatus
  killed: boolean
  dataSubscription: IDisposable
  exitSubscription: IDisposable
  exited: Promise<TerminalExitStatus>
}

const terminals = new Map<string, CliAcpTerminal>()
let ptyHelperReady = false

function requireTerminal(terminalId: string): CliAcpTerminal {
  const terminal = terminals.get(terminalId)
  if (!terminal) throw new Error(`Terminal not found: ${terminalId}`)
  return terminal
}

function assertPtyHost(): void {
  if (process.platform === "win32") {
    throw new Error("ACP terminals are unsupported in the Windows CLI")
  }
}

function ensurePtyHelperExecutable(): void {
  if (ptyHelperReady || process.platform === "win32") return
  const resolvedEntry = import.meta.resolve("node-pty")
  const entry = resolvedEntry.startsWith("file:") ? fileURLToPath(resolvedEntry) : resolvedEntry
  const packageRoot = path.dirname(path.dirname(entry))
  const helper = path.join(
    packageRoot,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper"
  )
  try {
    // node-pty 1.1.0's published Darwin tarball can lose this mode bit when
    // materialized by pnpm. Repair only the package-owned helper selected for
    // this exact host before the first fork; no user command/path is involved.
    chmodSync(helper, 0o755)
  } catch (error) {
    throw new Error(`ACP terminal PTY helper is unavailable: ${helper}`, { cause: error })
  }
  ptyHelperReady = true
}

function normalizeByteLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("ACP terminal outputByteLimit must be a non-negative safe integer")
  }
  return value
}

/** Keep the newest complete UTF-8 scalar values within the requested byte ceiling. */
export function truncateTerminalOutputUtf8(
  output: string,
  outputByteLimit: number | undefined
): { output: string; truncated: boolean } {
  const limit = normalizeByteLimit(outputByteLimit)
  if (limit === undefined) return { output, truncated: false }
  const bytes = Buffer.from(output, "utf8")
  if (bytes.length <= limit) return { output, truncated: false }
  if (limit === 0) return { output: "", truncated: bytes.length > 0 }

  let start = bytes.length - limit
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
  return { output: bytes.subarray(start).toString("utf8"), truncated: true }
}

function terminalState(terminal: CliAcpTerminal): TerminalState {
  if (terminal.killed) return { type: "Killed" }
  if (terminal.exitStatus.exitCode !== null || terminal.exitStatus.signal !== null) {
    return { type: "Exited", code: terminal.exitStatus.exitCode ?? -1 }
  }
  return { type: "Running" }
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

export async function acpTerminalCreate(
  sessionId: string,
  command: string,
  args: string[] = [],
  cwd?: string,
  env?: Record<string, string>,
  outputByteLimit?: number
): Promise<string> {
  assertPtyHost()
  ensurePtyHelperExecutable()
  const defaultOutputByteLimit = normalizeByteLimit(outputByteLimit)
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  const pty = spawnPty(command, args, {
    name: process.env.TERM ?? "xterm-256color",
    cols: 80,
    rows: 24,
    ...(cwd ? { cwd } : {}),
    env: { ...inheritedEnv, ...(env ?? {}) },
  })
  const id = `acp-cli-${randomUUID()}`
  let resolveExit!: (status: TerminalExitStatus) => void
  const exited = new Promise<TerminalExitStatus>((resolve) => {
    resolveExit = resolve
  })
  const terminal = {
    id,
    sessionId,
    command,
    pty,
    output: "",
    ...(defaultOutputByteLimit === undefined ? {} : { defaultOutputByteLimit }),
    exitStatus: { exitCode: null, signal: null },
    killed: false,
    exited,
  } as Omit<CliAcpTerminal, "dataSubscription" | "exitSubscription"> &
    Partial<Pick<CliAcpTerminal, "dataSubscription" | "exitSubscription">>
  terminal.dataSubscription = pty.onData((data) => {
    terminal.output += data
  })
  terminal.exitSubscription = pty.onExit(({ exitCode, signal }) => {
    terminal.exitStatus = terminal.killed
      ? { exitCode: null, signal: "killed" }
      : { exitCode, signal: signal ? String(signal) : null }
    resolveExit({ ...terminal.exitStatus })
  })
  terminals.set(id, terminal as CliAcpTerminal)
  return id
}

export async function acpTerminalOutput(
  terminalId: string,
  outputByteLimit?: number
): Promise<TerminalOutputResult> {
  const terminal = requireTerminal(terminalId)
  const limited = truncateTerminalOutputUtf8(
    terminal.output,
    outputByteLimit ?? terminal.defaultOutputByteLimit
  )
  return {
    ...limited,
    exitStatus: { ...terminal.exitStatus },
    exitCode: terminal.exitStatus.exitCode,
  }
}

export async function acpTerminalKill(terminalId: string): Promise<void> {
  const terminal = requireTerminal(terminalId)
  if (terminalState(terminal).type !== "Running") return
  terminal.killed = true
  terminal.pty.kill()
}

export async function acpTerminalRelease(terminalId: string): Promise<void> {
  const terminal = requireTerminal(terminalId)
  if (terminalState(terminal).type === "Running") await acpTerminalKill(terminalId)
  terminal.dataSubscription.dispose()
  terminal.exitSubscription.dispose()
  terminals.delete(terminalId)
}

export async function acpTerminalWaitForExit(
  terminalId: string,
  timeout?: number
): Promise<TerminalWaitResult> {
  const terminal = requireTerminal(terminalId)
  if (terminalState(terminal).type !== "Running") {
    return { exitStatus: { ...terminal.exitStatus }, exitCode: terminal.exitStatus.exitCode }
  }
  const timeoutSeconds = timeout === undefined ? undefined : normalizeByteLimit(timeout)
  let timer: NodeJS.Timeout | undefined
  try {
    const exitStatus = await (timeoutSeconds === undefined
      ? terminal.exited
      : Promise.race([
          terminal.exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Timeout waiting for terminal to exit")),
              timeoutSeconds * 1000
            )
          }),
        ]))
    return { exitStatus: { ...exitStatus }, exitCode: exitStatus.exitCode }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function acpTerminalWrite(terminalId: string, data: string): Promise<void> {
  const terminal = requireTerminal(terminalId)
  if (terminalState(terminal).type !== "Running") {
    throw new Error(`Terminal is not running: ${terminalId}`)
  }
  terminal.pty.write(data)
}

export async function acpTerminalGetSessionTerminals(sessionId: string): Promise<string[]> {
  return [...terminals.values()]
    .filter((terminal) => terminal.sessionId === sessionId)
    .map((terminal) => terminal.id)
}

export async function acpTerminalKillSessionTerminals(sessionId: string): Promise<void> {
  const ids = await acpTerminalGetSessionTerminals(sessionId)
  await Promise.all(
    ids.map(async (id) => {
      await acpTerminalKill(id).catch(() => undefined)
      await acpTerminalRelease(id).catch(() => undefined)
    })
  )
}

export async function acpTerminalIsRunning(terminalId: string): Promise<boolean> {
  return terminalState(requireTerminal(terminalId)).type === "Running"
}

export async function acpTerminalGetInfo(terminalId: string): Promise<TerminalInfo> {
  const terminal = requireTerminal(terminalId)
  return {
    id: terminal.id,
    sessionId: terminal.sessionId,
    command: terminal.command,
    state: terminalState(terminal),
    exitCode: terminal.exitStatus.exitCode,
    exitStatus: { ...terminal.exitStatus },
  }
}

export async function acpTerminalList(): Promise<string[]> {
  return [...terminals.keys()]
}

/** Non-ACP helpers stay unavailable: shared callers only use these in Tauri. */
const terminalHelperUnsupported = async (..._args: unknown[]): Promise<never> => {
  throw new Error("This terminal helper is unavailable in the CLI")
}
export const executeCommand = terminalHelperUnsupported
export const createInteractiveTerminal = terminalHelperUnsupported
export const cleanupSessionTerminals = acpTerminalKillSessionTerminals

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
