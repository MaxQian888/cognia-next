/**
 * The CLI's ACP terminals, backed by node-pty (ADR-0217).
 *
 * The CLI installs these as its external-agent host's terminal plane
 * (`./host-branch.ts`), so the shared `acpTerminal*` calls in
 * `@/lib/native/external-agent` reach them. On Unix hosts every terminal is a
 * PTY; Windows fails closed and the host omits the capability at initialize.
 */
import { randomUUID } from "node:crypto"
import { chmodSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { IDisposable, IPty } from "node-pty"

import type { InstalledExternalAgentTerminalPlane } from "@/lib/ai/agent/external/host/installed-host"
import type {
  TerminalExitStatus,
  TerminalInfo,
  TerminalOutputResult,
  TerminalState,
  TerminalWaitResult,
} from "@/lib/native/external-agent"

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
  // Linux forks directly in the native addon and ships no spawn-helper.
  if (ptyHelperReady || process.platform !== "darwin") return
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
  const { spawn: spawnPty } = await import("node-pty")
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

/** The terminal plane the CLI's external-agent host installs. */
export const cliTerminalPlane: InstalledExternalAgentTerminalPlane = Object.freeze({
  create: acpTerminalCreate,
  output: acpTerminalOutput,
  kill: acpTerminalKill,
  release: acpTerminalRelease,
  waitForExit: acpTerminalWaitForExit,
  write: acpTerminalWrite,
  sessionTerminals: acpTerminalGetSessionTerminals,
  killSessionTerminals: acpTerminalKillSessionTerminals,
  isRunning: acpTerminalIsRunning,
  info: acpTerminalGetInfo,
  list: acpTerminalList,
})
