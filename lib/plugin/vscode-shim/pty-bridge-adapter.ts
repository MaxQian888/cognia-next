"use client"

/**
 * Production adapter that wires the VS Code-shim terminal bridge to a
 * real PTY (`lib/terminal/session.ts`).
 *
 * The bridge's public surface — `ShellSpawnFn` / `ShellChildProcess` /
 * `TerminalOutputSink` — is unchanged (so `terminal-bridge.test.ts`
 * keeps passing untouched). What changes is *what gets injected* into
 * `configureTerminalBridge()` at app boot: this adapter, instead of the
 * historical line-buffered stub.
 *
 * Semantics on a real PTY vs the legacy line-buffered fake:
 *   * PTYs combine stdout + stderr — every byte the child writes lands
 *     on the single `onStdout` channel (utf-8 decoded). `onStderr`
 *     subscribers still receive listeners back but never fire. This
 *     matches every real terminal on Unix and ConPTY on Windows.
 *   * `pid` is set to `0` because the renderer never sees the real OS
 *     pid (it'd be in `PtySession.info` only — not part of the bridge
 *     API the extensions consume).
 *   * Spawn is asynchronous on the wire (Tauri `invoke`). Writes /
 *     kills issued before the session lands are queued and replayed
 *     once `TerminalSession.spawn` resolves.
 *   * `finished` resolves with `{ exitCode, signal: null }`. PTYs don't
 *     surface POSIX signal numbers through portable-pty; if the child
 *     was killed, exitCode is `null` and signal stays `null`.
 *
 * Shell integration (`COGNIA_TERM_NONCE`/OSC 633) is disabled on
 * extension-driven spawns: extensions like Cline expect a vanilla
 * shell and would mis-parse our prompt markers. User-driven terminals
 * created through the dock's "+ New" affordance go through
 * `lib/terminal/session.ts` directly and DO enable integration.
 */

import type { ShellChildProcess, ShellSpawnFn, ShellSpawnOptions } from "./terminal-bridge"
import { TerminalSession } from "@/lib/terminal/session"

/**
 * Optional spawner override — injected by the initializer in production,
 * stubbed in unit tests so the adapter can run without Tauri.
 */
export type TerminalSessionSpawner = (req: {
  shell: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  rows: number
  cols: number
  enableShellIntegration: boolean
  extensionId?: string
}) => Promise<{
  write(bytes: Uint8Array): Promise<void>
  kill(): Promise<void>
  onData(listener: (bytes: Uint8Array) => void): () => void
  onExit(listener: (code: number | null) => void): () => void
}>

const defaultSpawner: TerminalSessionSpawner = async (req) => {
  const session = await TerminalSession.spawn(req)
  return {
    write: (bytes) => session.write(bytes),
    kill: () => session.kill(),
    onData: (listener) => session.onData(listener),
    onExit: (listener) => session.onExit(listener),
  }
}

export interface PtyShellSpawnOptions {
  /** Default 80; the bridge doesn't expose cols/rows to extensions yet. */
  defaultCols?: number
  /** Default 24. */
  defaultRows?: number
  /** Override the spawner for tests. */
  spawner?: TerminalSessionSpawner
  /** Surfaced through `PtySession.extension_id` for plugin audit. */
  extensionIdResolver?: (command: string) => string | undefined
}

/**
 * Build a `ShellSpawnFn` that fronts the real PTY. The returned function
 * is what gets passed to `configureTerminalBridge({ spawn: …, … })`.
 */
export function createPtyShellSpawn(opts: PtyShellSpawnOptions = {}): ShellSpawnFn {
  const spawner = opts.spawner ?? defaultSpawner
  const defaultCols = opts.defaultCols ?? 80
  const defaultRows = opts.defaultRows ?? 24

  return (command: string, args: string[], spawnOptions: ShellSpawnOptions): ShellChildProcess => {
    return adaptSession({
      command,
      args,
      spawnOptions,
      spawner,
      defaultRows,
      defaultCols,
      extensionId: opts.extensionIdResolver?.(command),
    })
  }
}

interface AdaptInput {
  command: string
  args: string[]
  spawnOptions: ShellSpawnOptions
  spawner: TerminalSessionSpawner
  defaultRows: number
  defaultCols: number
  extensionId: string | undefined
}

function adaptSession(input: AdaptInput): ShellChildProcess {
  const stdoutListeners = new Set<(chunk: string) => void>()
  // PTYs merge stderr into the master stream. We keep the listener set
  // alive so existing subscribe→unsubscribe code paths don't crash, but
  // we never fan out into them.
  const stderrListeners = new Set<(chunk: string) => void>()
  const decoder = new TextDecoder("utf-8", { fatal: false })

  let resolveFinished:
    | ((value: { exitCode: number | null; signal: string | null }) => void)
    | null = null
  const finished = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    resolveFinished = resolve
  })

  type LiveSession = Awaited<ReturnType<TerminalSessionSpawner>>
  let live: LiveSession | null = null
  let killRequested = false
  const writeQueue: Uint8Array[] = []

  input
    .spawner({
      shell: input.command,
      args: input.args,
      cwd: input.spawnOptions.cwd,
      env: input.spawnOptions.env,
      rows: input.defaultRows,
      cols: input.defaultCols,
      enableShellIntegration: false,
      extensionId: input.extensionId,
    })
    .then((session) => {
      live = session
      session.onData((bytes) => {
        const text = decoder.decode(bytes, { stream: true })
        if (text.length === 0) return
        for (const listener of stdoutListeners) {
          try {
            listener(text)
          } catch (err) {
            console.warn("pty-bridge-adapter: stdout listener threw:", err)
          }
        }
      })
      session.onExit((code) => {
        resolveFinished?.({ exitCode: code, signal: null })
      })
      for (const bytes of writeQueue) {
        void session.write(bytes)
      }
      writeQueue.length = 0
      if (killRequested) {
        void session.kill()
      }
    })
    .catch((err) => {
      console.warn("pty-bridge-adapter: spawn failed:", err)
      resolveFinished?.({ exitCode: null, signal: null })
    })

  return {
    // We don't have the real OS pid in the renderer — `PtySession.info`
    // doesn't expose it (Tauri side doesn't need to either). Extensions
    // historically don't read pid except for diagnostics.
    pid: 0,
    write(data: string) {
      const bytes = new TextEncoder().encode(data)
      if (live) {
        void live.write(bytes)
      } else {
        writeQueue.push(bytes)
      }
    },
    kill(_signal?: string) {
      if (live) {
        void live.kill()
      } else {
        killRequested = true
      }
    },
    finished,
    onStdout(listener) {
      stdoutListeners.add(listener)
      return () => {
        stdoutListeners.delete(listener)
      }
    },
    onStderr(listener) {
      stderrListeners.add(listener)
      return () => {
        stderrListeners.delete(listener)
      }
    },
  }
}
