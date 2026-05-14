/**
 * Terminal bridge for the VS Code reuse layer.
 *
 * `vscode.window.createTerminal(options)` returns a Terminal-shaped object
 * that the extension uses to send text + observe lifecycle events.
 * cognia's reuse layer maps each VS Code Terminal to:
 *
 *   - A `ctx.shell.spawn` child process (the real subprocess).
 *   - A "terminal output" panel mounted under the `vscode.terminal.output`
 *     UI extension point (Phase M1.C, see
 *     `components/extensions/vscode-terminal-panel.tsx`).
 *
 * cognia ships NO xterm.js TTY emulator — Cline-class extensions only
 * need RPC stdin/stdout, not a real pseudo-terminal. If a Phase 2 user
 * needs xterm we'll add it then.
 *
 * Like the Monaco bridge, this module accepts injected adapters so tests
 * can verify behaviour without spawning real processes.
 */

import { nanoid } from "nanoid"

export interface ShellSpawnOptions {
  cwd?: string
  env?: Record<string, string>
  shell?: boolean
}

export interface ShellChildProcess {
  /** Process id (real OS pid in production; deterministic in tests). */
  pid: number
  /** Write to the process's stdin. */
  write(data: string): void
  /** Send a signal — SIGTERM by default. */
  kill(signal?: string): void
  /** Resolves with the exit object once the process exits. */
  finished: Promise<{ exitCode: number | null; signal: string | null }>
  /** Streamed output. Listeners are invoked synchronously. */
  onStdout(listener: (chunk: string) => void): () => void
  onStderr(listener: (chunk: string) => void): () => void
}

export type ShellSpawnFn = (
  command: string,
  args: string[],
  options: ShellSpawnOptions
) => ShellChildProcess

export interface TerminalOutputSink {
  /** Push a new logical line to the panel under `vscode.terminal.output`. */
  appendLine(terminalId: string, kind: "stdout" | "stderr" | "system", text: string): void
  /** Mark a terminal closed. The panel keeps its scrollback. */
  markClosed(terminalId: string, exitCode: number | null): void
}

export interface TerminalCreationRequest {
  /** Owning extension id. */
  extensionId: string
  /** Display name surfaced in the panel header. */
  name: string
  /** Optional command to run. When omitted, the terminal is "input-only". */
  shellPath?: string
  /** Args for `shellPath`. Ignored when `shellPath` is unset. */
  shellArgs?: string[]
  cwd?: string
  env?: Record<string, string>
  /**
   * Whether the terminal is hidden by default in the panel. Some VS Code
   * extensions create background terminals they show on demand.
   */
  hideFromUser?: boolean
}

export interface TerminalRecord {
  /** Stable terminal id. */
  id: string
  /** Owning extension id. */
  extensionId: string
  /** Display name. */
  name: string
  /** Backing child process, or `null` when the terminal is input-only. */
  child: ShellChildProcess | null
  /** Whether the terminal has been disposed. */
  disposed: boolean
  /** Last known exit code (set when the process exits or the terminal is killed). */
  exitCode: number | null
}

let spawnFn: ShellSpawnFn | null = null
let outputSink: TerminalOutputSink | null = null

const terminals = new Map<string, TerminalRecord>()
const listeners = new Set<(event: TerminalEvent) => void>()

export type TerminalEventType = "open" | "close" | "stdout" | "stderr" | "user-input"

export interface TerminalEvent {
  type: TerminalEventType
  terminalId: string
  extensionId: string
  chunk?: string
  exitCode?: number | null
}

export function configureTerminalBridge(input: {
  spawn: ShellSpawnFn
  outputSink: TerminalOutputSink
}): void {
  spawnFn = input.spawn
  outputSink = input.outputSink
}

function emit(event: TerminalEvent): void {
  queueMicrotask(() => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (err) {
        console.warn("terminal-bridge: listener threw:", err)
      }
    }
  })
}

export function subscribeTerminalEvents(listener: (event: TerminalEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Create a VS Code-style terminal. Returns the terminal record; callers
 * keep the id and use `sendText` / `dispose` to drive it.
 *
 * When `shellPath` is set, we spawn it immediately via the injected
 * `spawnFn` and wire stdout/stderr into the output sink. When unset, the
 * terminal is "input-only" — sendText pushes lines into the output panel
 * but no subprocess runs.
 */
export function createTerminal(req: TerminalCreationRequest): TerminalRecord {
  if (!spawnFn || !outputSink) {
    throw new Error("terminal-bridge not configured. Call configureTerminalBridge() first.")
  }
  const id = nanoid()
  let child: ShellChildProcess | null = null
  if (req.shellPath) {
    child = spawnFn(req.shellPath, req.shellArgs ?? [], {
      cwd: req.cwd,
      env: req.env,
    })
    child.onStdout((chunk) => {
      outputSink!.appendLine(id, "stdout", chunk)
      emit({ type: "stdout", terminalId: id, extensionId: req.extensionId, chunk })
    })
    child.onStderr((chunk) => {
      outputSink!.appendLine(id, "stderr", chunk)
      emit({ type: "stderr", terminalId: id, extensionId: req.extensionId, chunk })
    })
    void child.finished.then(({ exitCode }) => {
      const record = terminals.get(id)
      if (record) record.exitCode = exitCode
      outputSink!.markClosed(id, exitCode)
      emit({
        type: "close",
        terminalId: id,
        extensionId: req.extensionId,
        exitCode,
      })
    })
  }
  const record: TerminalRecord = {
    id,
    extensionId: req.extensionId,
    name: req.name,
    child,
    disposed: false,
    exitCode: null,
  }
  terminals.set(id, record)
  outputSink.appendLine(
    id,
    "system",
    `[${req.name}] ${req.shellPath ?? "input-only"} ${req.shellArgs?.join(" ") ?? ""}`.trim()
  )
  emit({ type: "open", terminalId: id, extensionId: req.extensionId })
  return record
}

/**
 * `Terminal.sendText(text, addNewLine)` — pipe text into the subprocess's
 * stdin. When the terminal is input-only (no child), the text is
 * appended to the panel as user input only.
 */
export function sendText(terminalId: string, text: string, addNewLine = true): void {
  const record = terminals.get(terminalId)
  if (!record || record.disposed) return
  const payload = addNewLine ? `${text}\n` : text
  if (record.child) {
    record.child.write(payload)
  }
  outputSink?.appendLine(terminalId, "system", `> ${text}`)
  emit({
    type: "user-input",
    terminalId,
    extensionId: record.extensionId,
    chunk: text,
  })
}

/**
 * `Terminal.dispose()` — kill the subprocess and drop the terminal from
 * the pool. Idempotent.
 */
export function disposeTerminal(terminalId: string): boolean {
  const record = terminals.get(terminalId)
  if (!record) return false
  if (record.disposed) return false
  record.disposed = true
  if (record.child) {
    try {
      record.child.kill("SIGTERM")
    } catch (err) {
      console.warn(`terminal-bridge: kill threw for ${terminalId}:`, err)
    }
  } else {
    // Input-only terminal — emit close immediately.
    outputSink?.markClosed(terminalId, 0)
    emit({
      type: "close",
      terminalId,
      extensionId: record.extensionId,
      exitCode: 0,
    })
  }
  return true
}

export function disposeTerminalsByExtension(extensionId: string): number {
  let count = 0
  for (const [id, record] of terminals) {
    if (record.extensionId === extensionId) {
      if (disposeTerminal(id)) count += 1
    }
  }
  return count
}

export function listTerminals(): TerminalRecord[] {
  return [...terminals.values()]
}

export function getTerminal(terminalId: string): TerminalRecord | undefined {
  return terminals.get(terminalId)
}

export function __resetTerminalBridgeForTesting(): void {
  spawnFn = null
  outputSink = null
  terminals.clear()
  listeners.clear()
}
