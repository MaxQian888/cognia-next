/**
 * Run a shell command locally for the TUI's `!command` shell-out. The spawner is
 * injectable so the orchestration unit-tests without launching a real process.
 */
import { spawn as nodeSpawn } from "node:child_process"

import { decodeConsoleBytes } from "./console-encoding"

export interface ShellResult {
  stdout: string
  stderr: string
  code: number
  /** True when the run was terminated via the abort signal (Ctrl+C), not by the
   * process exiting on its own. Omitted (falsy) on a normal exit. */
  aborted?: boolean
}

/** Minimal spawned-process surface the runner consumes. */
export interface ShellChild {
  stdout: { on(event: "data", cb: (chunk: unknown) => void): void } | null
  stderr: { on(event: "data", cb: (chunk: unknown) => void): void } | null
  /** Write interactive input to the process stdin. Optional so the injected test
   * child can omit it; the real spawn surfaces the Node `child.stdin`. */
  stdin?: { write(data: string): void } | null
  on(event: "close", cb: (code: number | null) => void): void
  on(event: "error", cb: (err: Error) => void): void
  /** Terminate the process (and, for the real spawn, its whole tree). Optional so
   * the injected test child can omit it. */
  kill?(signal?: NodeJS.Signals | number): void
}

export type ShellSpawn = (command: string, opts: { cwd?: string }) => ShellChild

const isWindows = process.platform === "win32"

/**
 * Kill a spawned shell command and everything it started. A leading `!` command
 * is run through a shell (`shell: true`), so the direct child is the shell and
 * the real workload (a dev server, a watcher) is a grandchild — `child.kill()`
 * alone leaves it orphaned and still holding the port. We kill the whole tree:
 * `taskkill /T` on Windows, the negative-pid process group on POSIX (the child
 * is spawned `detached`, so it leads its own group).
 */
function killTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals | number): boolean },
  signal: NodeJS.Signals
): void {
  const pid = child.pid
  if (pid == null) {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
    return
  }
  if (isWindows) {
    try {
      nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"])
      return
    } catch {
      // fall through to the direct kill
    }
  } else {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // process group already gone — fall through
    }
  }
  try {
    child.kill(signal)
  } catch {
    // already gone
  }
}

const realSpawn: ShellSpawn = (command, opts) => {
  const child = nodeSpawn(command, {
    shell: true,
    cwd: opts.cwd,
    // POSIX: lead a new process group so `killTree` can signal the whole group.
    detached: !isWindows,
  })
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    stdin: child.stdin,
    on: (event: "close" | "error", cb: never) => child.on(event, cb),
    kill: (signal) => killTree(child, (signal as NodeJS.Signals) ?? "SIGTERM"),
  } as ShellChild
}

/** Grace period before escalating an abort from SIGTERM to SIGKILL. */
const ABORT_KILL_GRACE_MS = 2000

export interface RunShellOpts {
  cwd?: string
  spawn?: ShellSpawn
  /** Streamed incrementally as the process writes, so the TUI can show output
   * live instead of waiting for the process to exit. The resolved
   * {@link ShellResult} still carries the full accumulated text. */
  onChunk?: (text: string, stream: "stdout" | "stderr") => void
  /** Abort kills the running process tree (Ctrl+C on a blocking command). The
   * resolved {@link ShellResult} carries `aborted: true`. */
  signal?: AbortSignal
  /** Called once, after a successful spawn, with a writer that appends to the
   * child's stdin. Lets the TUI feed a line-based interactive prompt (a `y/n`,
   * a passphrase) into a running foreground `!command`. No-op after the process
   * exits or is aborted. */
  registerInput?: (write: (data: string) => void) => void
}

/** Minimal inherited-terminal process surface used by
 * {@link runInteractiveShell}. Unlike {@link ShellChild}, it deliberately has
 * no captured stdout/stderr: the child owns the real terminal while Ink is
 * suspended. */
export interface InteractiveShellChild {
  on(event: "close", cb: (code: number | null, signal?: NodeJS.Signals | null) => void): void
  on(event: "error", cb: (err: Error) => void): void
  kill?(signal?: NodeJS.Signals | number): void
}

export interface InteractiveShellSpawnOpts {
  cwd?: string
  shell: true
  stdio: "inherit"
}

export type InteractiveShellSpawn = (
  command: string,
  opts: InteractiveShellSpawnOpts
) => InteractiveShellChild

export interface RunInteractiveShellOpts {
  cwd?: string
  spawn?: InteractiveShellSpawn
  signal?: AbortSignal
}

const realInteractiveSpawn: InteractiveShellSpawn = (command, opts) =>
  nodeSpawn(command, opts) as InteractiveShellChild

/**
 * Run a command with the real terminal attached. The caller must first suspend
 * Ink (via `useApp().suspendTerminal`) so full-screen programs and REPLs receive
 * a genuine TTY and can handle native keys such as `q` and Ctrl+C.
 */
export function runInteractiveShell(
  command: string,
  opts: RunInteractiveShellOpts = {}
): Promise<ShellResult> {
  const spawn = opts.spawn ?? realInteractiveSpawn
  return new Promise<ShellResult>((resolve) => {
    let child: InteractiveShellChild
    try {
      child = spawn(command, { cwd: opts.cwd, shell: true, stdio: "inherit" })
    } catch (e) {
      resolve({ stdout: "", stderr: e instanceof Error ? e.message : String(e), code: 1 })
      return
    }

    let settled = false
    let aborted = false
    const finish = (result: ShellResult) => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }
    const onAbort = () => {
      aborted = true
      try {
        child.kill?.("SIGINT")
      } catch {
        // The child already exited; its close event will settle the run.
      }
    }

    child.on("error", (error) => {
      finish({
        stdout: "",
        stderr: error.message,
        code: 1,
        ...(aborted ? { aborted: true } : {}),
      })
    })
    child.on("close", (code, signal) => {
      finish({
        stdout: "",
        stderr: "",
        code: code ?? (aborted || signal === "SIGINT" ? 130 : 1),
        ...(aborted ? { aborted: true } : {}),
      })
    })
    // Subscribe to child completion before honoring a pre-aborted signal: an
    // injected (or unusually fast) child may emit `close` synchronously in
    // response to `kill`.
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

/** Coerce a `data` event payload to a Buffer (real child) or keep a string (the
 * injected test spawn, which emits already-decoded strings). */
function toBytes(chunk: unknown): Uint8Array | null {
  if (typeof chunk === "string") return null
  if (chunk instanceof Uint8Array) return chunk
  return null
}

/**
 * Accumulate one output stream. Real Node `data` events arrive as Buffers, which
 * we keep raw and decode once at the end (so the OEM/UTF-8 auto-detection sees
 * the whole sequence, not a chunk that might split a multibyte char). The
 * injected test spawn emits strings, which are already text — pass them through.
 * The live `onChunk` preview decodes Buffers best-effort as UTF-8 (it's only a
 * transient preview; the final `ShellResult` is re-decoded correctly).
 */
function makeCollector(onChunk?: (text: string) => void) {
  const bytes: Uint8Array[] = []
  let str = ""
  let sawBytes = false
  const live = new TextDecoder("utf-8", { fatal: false })
  return {
    feed(chunk: unknown) {
      const b = toBytes(chunk)
      if (b) {
        sawBytes = true
        bytes.push(b)
        onChunk?.(live.decode(b, { stream: true }))
      } else {
        const s = String(chunk)
        str += s
        onChunk?.(s)
      }
    },
    final(): string {
      return sawBytes ? decodeConsoleBytes(concat(bytes)) : str
    },
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

export function runShell(command: string, opts: RunShellOpts = {}): Promise<ShellResult> {
  const spawn = opts.spawn ?? realSpawn
  return new Promise<ShellResult>((resolve) => {
    const out = makeCollector(opts.onChunk ? (t) => opts.onChunk!(t, "stdout") : undefined)
    const err = makeCollector(opts.onChunk ? (t) => opts.onChunk!(t, "stderr") : undefined)
    let child: ShellChild
    try {
      child = spawn(command, { cwd: opts.cwd })
    } catch (e) {
      resolve({ stdout: "", stderr: e instanceof Error ? e.message : String(e), code: 1 })
      return
    }
    let aborted = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      aborted = true
      // SIGTERM first so the process can clean up, then SIGKILL if it ignores it.
      child.kill?.("SIGTERM")
      killTimer = setTimeout(() => child.kill?.("SIGKILL"), ABORT_KILL_GRACE_MS)
      // Don't keep the event loop alive just to escalate a kill.
      ;(killTimer as { unref?: () => void }).unref?.()
    }
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer)
      opts.signal?.removeEventListener("abort", onAbort)
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener("abort", onAbort, { once: true })
    }
    if (opts.registerInput && child.stdin) {
      const stdin = child.stdin
      opts.registerInput((data: string) => {
        if (aborted) return
        try {
          stdin.write(data)
        } catch {
          // stdin closed / EPIPE — the process is gone; drop the input.
        }
      })
    }
    child.stdout?.on("data", (c) => out.feed(c))
    child.stderr?.on("data", (c) => err.feed(c))
    child.on("error", (e) => {
      cleanup()
      resolve({
        stdout: out.final(),
        stderr: err.final() + (e.message ?? ""),
        code: 1,
        ...(aborted ? { aborted: true } : {}),
      })
    })
    child.on("close", (code) => {
      cleanup()
      // A killed process reports a null/signal code; surface the conventional
      // 130 (128 + SIGINT) so the cell shows a non-zero exit.
      resolve({
        stdout: out.final(),
        stderr: err.final(),
        code: code ?? (aborted ? 130 : 0),
        ...(aborted ? { aborted: true } : {}),
      })
    })
  })
}
