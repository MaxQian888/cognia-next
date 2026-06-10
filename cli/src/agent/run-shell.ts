/**
 * Run a shell command locally for the TUI's `!command` shell-out. The spawner is
 * injectable so the orchestration unit-tests without launching a real process.
 */
import { spawn as nodeSpawn } from "node:child_process"

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
}

export function runShell(command: string, opts: RunShellOpts = {}): Promise<ShellResult> {
  const spawn = opts.spawn ?? realSpawn
  return new Promise<ShellResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let child: ShellChild
    try {
      child = spawn(command, { cwd: opts.cwd })
    } catch (err) {
      resolve({ stdout: "", stderr: err instanceof Error ? err.message : String(err), code: 1 })
      return
    }
    child.stdout?.on("data", (c) => {
      stdout += String(c)
    })
    child.stderr?.on("data", (c) => {
      stderr += String(c)
    })
    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr + (err.message ?? ""), code: 1 })
    })
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 })
    })
  })
}
