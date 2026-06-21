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
}

/** Minimal spawned-process surface the runner consumes. */
export interface ShellChild {
  stdout: { on(event: "data", cb: (chunk: unknown) => void): void } | null
  stderr: { on(event: "data", cb: (chunk: unknown) => void): void } | null
  on(event: "close", cb: (code: number | null) => void): void
  on(event: "error", cb: (err: Error) => void): void
}

export type ShellSpawn = (command: string, opts: { cwd?: string }) => ShellChild

const realSpawn: ShellSpawn = (command, opts) =>
  nodeSpawn(command, {
    shell: true,
    cwd: opts.cwd,
  }) as unknown as ShellChild

export interface RunShellOpts {
  cwd?: string
  spawn?: ShellSpawn
  /** Streamed incrementally as the process writes, so the TUI can show output
   * live instead of waiting for the process to exit. The resolved
   * {@link ShellResult} still carries the full accumulated text. */
  onChunk?: (text: string, stream: "stdout" | "stderr") => void
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
    child.stdout?.on("data", (c) => out.feed(c))
    child.stderr?.on("data", (c) => err.feed(c))
    child.on("error", (e) => {
      resolve({ stdout: out.final(), stderr: err.final() + (e.message ?? ""), code: 1 })
    })
    child.on("close", (code) => {
      resolve({ stdout: out.final(), stderr: err.final(), code: code ?? 0 })
    })
  })
}
