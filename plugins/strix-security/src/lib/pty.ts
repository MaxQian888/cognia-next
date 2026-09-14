// PTY orchestration over the plugin terminal API. Wraps a spawned shell so the
// runner + preflight can: run a command and await its exit code, or capture a
// command's output — all via the sentinel protocol in `pty-read.ts`. Kept thin
// and dependency-injected (sleep/signal) so it's unit-testable with a mock
// terminal.

import type { PluginTerminalAPI } from "@cognia/plugin-sdk"
import { stripAnsi } from "./ansi"
import {
  buildCaptureCommand,
  buildRunCommand,
  extractCapture,
  findDone,
  stripMarkers,
} from "./pty-read"

export interface PtyPollDeps {
  sleep: (ms: number) => Promise<void>
  pollMs?: number
  signal?: AbortSignal
}

export interface PtyHandle {
  readonly id: string
  buffer(): string
  /** Toggle whether raw output is forwarded to the console callback. */
  forward(on: boolean): void
  dispose(): void
}

export class ScanAbortError extends Error {
  constructor() {
    super("scan aborted")
    this.name = "ScanAbortError"
  }
}

/**
 * Cap on the PTY buffer while a scan's output is being forwarded to the
 * console. Completion sentinels are emitted at the END of a command, so only
 * the tail matters while streaming; an hours-long scan would otherwise grow
 * the buffer without bound. When forwarding is OFF (artifact captures) the
 * full buffer is kept — a capture's begin marker must survive to be found.
 */
const FORWARD_BUFFER_TAIL = 256 * 1024

/** Spawn a shell tagged to this plugin and start buffering its output. */
export async function openPty(
  terminal: PluginTerminalAPI,
  opts: { env?: Record<string, string>; onConsole?: (text: string) => void } = {}
): Promise<PtyHandle> {
  // enableShellIntegration:false — we frame completion ourselves, so OSC-633
  // injection would only add noise to the buffer.
  const { id } = await terminal.spawn({ enableShellIntegration: false, env: opts.env })
  let buf = ""
  let forwarding = false
  const decoder = new TextDecoder()
  const unsubscribe = terminal.onData(id, (bytes) => {
    // `{ stream: true }` — PTY chunks are byte-aligned, not UTF-8-aligned; a
    // multibyte character split across two chunks must not decode to two
    // replacement characters.
    const text = decoder.decode(bytes, { stream: true })
    buf += text
    if (forwarding) {
      if (opts.onConsole) {
        const clean = stripMarkers(stripAnsi(text))
        if (clean) opts.onConsole(clean)
      }
      if (buf.length > FORWARD_BUFFER_TAIL) buf = buf.slice(-FORWARD_BUFFER_TAIL)
    }
  })
  return {
    id,
    buffer: () => buf,
    forward: (on) => {
      forwarding = on
    },
    dispose: () => {
      unsubscribe()
      // Flush any partial multibyte sequence still held by the decoder so a
      // final capture or completion marker is not lost to a dangling byte.
      try {
        buf += decoder.decode()
      } catch {
        // already-flushed or abandoned decoder — nothing left to recover.
      }
    },
  }
}

/** Best-effort local-echo + prompt suppression so the console shows only program output. */
export async function quietShell(terminal: PluginTerminalAPI, pty: PtyHandle): Promise<void> {
  await terminal.write(
    pty.id,
    "stty -echo 2>/dev/null; export PS1= 2>/dev/null; export PS2= 2>/dev/null\n"
  )
}

async function poll<T>(
  check: () => T | null,
  terminal: PluginTerminalAPI,
  pty: PtyHandle,
  deps: PtyPollDeps
): Promise<T> {
  const pollMs = deps.pollMs ?? 500
  for (;;) {
    if (deps.signal?.aborted) {
      await safeKill(terminal, pty.id)
      throw new ScanAbortError()
    }
    const result = check()
    if (result !== null) return result
    await deps.sleep(pollMs)
  }
}

/** Write a command, stream its output, and resolve with its exit code. */
export async function runCommand(
  terminal: PluginTerminalAPI,
  pty: PtyHandle,
  command: string,
  token: string,
  deps: PtyPollDeps
): Promise<number> {
  await terminal.write(pty.id, buildRunCommand(command, token) + "\n")
  const done = await poll(() => findDone(pty.buffer(), token), terminal, pty, deps)
  return done.exitCode
}

/** Write a command and resolve with its captured output + exit code. */
export async function captureCommand(
  terminal: PluginTerminalAPI,
  pty: PtyHandle,
  command: string,
  token: string,
  deps: PtyPollDeps
): Promise<{ raw: string; exitCode: number }> {
  await terminal.write(pty.id, buildCaptureCommand(command, token) + "\n")
  return poll(() => extractCapture(pty.buffer(), token), terminal, pty, deps)
}

export async function safeKill(terminal: PluginTerminalAPI, id: string): Promise<void> {
  try {
    await terminal.kill(id)
  } catch {
    // session may already be gone — ignore.
  }
}
