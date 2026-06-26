/**
 * Sidecar bootstrap: spawn `node claude-host.mjs`, wrap it in a
 * {@link StdioTransport}, install that as the process-wide transport, and wait
 * for the sidecar's `ready` line. After this resolves, the desktop's
 * `runAndCaptureAssistantReply` loop runs unchanged against the local sidecar.
 *
 * `spawn` is injectable so the wiring unit-tests without launching Node.
 */

import { spawn as nodeSpawn } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import { setTransport } from "@/lib/tauri"

import { StdioTransport, type SidecarHandle } from "./stdio-transport"

/** Minimal spawned-child surface the bootstrap consumes. */
export interface SpawnedChild {
  stdin: {
    write(chunk: string): void
    on?(event: "error", cb: (err: Error) => void): unknown
  } | null
  stdout: NodeJS.ReadableStream | null
  on(event: "exit", cb: (code: number | null) => void): unknown
  on(event: "error", cb: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): void
}

export type SpawnFn = (
  script: string,
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => SpawnedChild

export interface BootstrapOptions {
  /** Absolute path to `claude-host.mjs`. Defaults to {@link resolveSidecarScript}. */
  scriptPath?: string
  /** Working directory for the agent (passed per-turn anyway; used as spawn cwd fallback). */
  cwd?: string
  /** Environment for the sidecar process. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Injected spawner (tests). Defaults to the real `child_process.spawn`. */
  spawn?: SpawnFn
  /** How long to wait for the `ready` line. */
  readyTimeoutMs?: number
}

export interface SidecarBootstrap {
  transport: StdioTransport
  /** Stop the sidecar and detach. Safe to call more than once. */
  shutdown(): Promise<void>
}

/** Injectable seams for {@link resolveSidecarScript} (tests). */
export interface ResolveSidecarOptions {
  /** Path of the running executable. Defaults to `process.execPath`. */
  execPath?: string
  /** Existence probe. Defaults to `fs.existsSync`. */
  exists?: (p: string) => boolean
}

/**
 * Locate `sidecar/claude-host.mjs`. Resolution order:
 *   1. `$COGNIA_SIDECAR_SCRIPT` (explicit override / bundled layout)
 *   2. a `sidecar/` dir next to the executable (packaged-binary dist layout)
 *   3. a `sidecar/` dir walked up from this module (in-repo / dev)
 */
export function resolveSidecarScript(
  env: Record<string, string | undefined> = process.env,
  opts: ResolveSidecarOptions = {}
): string {
  const exists = opts.exists ?? fs.existsSync
  const execPath = opts.execPath ?? process.execPath

  const override = env.COGNIA_SIDECAR_SCRIPT?.trim()
  if (override) return override

  // In the packaged-binary dist the sidecar ships next to the executable:
  //   <bin-dir>/sidecar/claude-host.mjs
  const adjacent = path.join(path.dirname(execPath), "sidecar", "claude-host.mjs")
  if (exists(adjacent)) return adjacent

  // Walk up from this module looking for `sidecar/claude-host.mjs`. Works in the
  // repo (cli/src/runtime → repo root) regardless of cwd.
  let dir: string
  try {
    dir = path.dirname(fileURLToPath(import.meta.url))
  } catch {
    // CJS (ts-jest) fallback — __dirname is defined there.
    dir = typeof __dirname === "string" ? __dirname : process.cwd()
  }
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "sidecar", "claude-host.mjs")
    if (exists(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    "could not locate sidecar/claude-host.mjs — set COGNIA_SIDECAR_SCRIPT to its absolute path"
  )
}

/** True when running inside a `@yao-pkg/pkg` binary (it sets `process.pkg`). */
export function isPackaged(): boolean {
  return Boolean((process as { pkg?: unknown }).pkg)
}

/** How to spawn the sidecar process: as a self-exec in a binary, else `node`. */
export interface SpawnTarget {
  command: string
  args: string[]
  env: Record<string, string | undefined>
}

/**
 * Resolve the command/args/env for launching the sidecar.
 *
 * Inside a packaged binary there is no system `node`, so we self-exec the binary
 * (`process.execPath`) with `COGNIA_ROLE=sidecar`, making it run the sidecar
 * host instead of the CLI. No extra args are passed, so the sidecar never sees
 * `--smoke`. In dev we run `node <script>` exactly as before.
 */
export function resolveSpawnTarget(
  script: string,
  baseEnv: Record<string, string | undefined>,
  packaged: boolean
): SpawnTarget {
  if (packaged) {
    return {
      command: process.execPath,
      args: [],
      env: { ...baseEnv, COGNIA_ROLE: "sidecar", COGNIA_SIDECAR_SCRIPT: script },
    }
  }
  return { command: "node", args: [script], env: baseEnv }
}

const realSpawn: SpawnFn = (script, options) => {
  const { command, args, env } = resolveSpawnTarget(script, options.env, isPackaged())
  return nodeSpawn(command, args, {
    cwd: options.cwd,
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as SpawnedChild
}

/** Adapt a spawned child to the transport's {@link SidecarHandle}. */
function toHandle(child: SpawnedChild): SidecarHandle {
  if (!child.stdin || !child.stdout) {
    throw new Error("spawned sidecar is missing stdin/stdout pipes")
  }
  const stdin = child.stdin
  const stdout = child.stdout
  // Single teardown notifier, deduped: a crashed sidecar can fire both 'exit'
  // and an async stream 'error' — the transport must only see one.
  let exitCb: ((code: number | null) => void) | null = null
  let notified = false
  const notifyExit = (code: number | null) => {
    if (notified) return
    notified = true
    exitCb?.(code)
  }
  child.on("exit", notifyExit)
  // A sidecar crash makes the next `stdin.write` emit an asynchronous 'error'
  // (EPIPE), and a spawn fault (ENOENT) fires 'error' on the child. Without
  // these handlers Node treats them as unhandled stream errors and crashes the
  // whole CLI. Route every fault to the same teardown as a clean exit so the
  // transport rejects pending waiters / emits `sidecar_exited` instead.
  child.on("error", () => notifyExit(null))
  stdin.on?.("error", () => notifyExit(null))
  stdout.on?.("error", () => notifyExit(null))
  return {
    stdin: {
      write: (chunk) => {
        try {
          stdin.write(chunk)
        } catch {
          notifyExit(null)
        }
      },
    },
    stdout,
    onExit: (cb) => {
      exitCb = cb
    },
  }
}

/** Spawn the sidecar, install the StdioTransport, and await readiness. */
export async function bootstrapSidecar(opts: BootstrapOptions = {}): Promise<SidecarBootstrap> {
  const env = opts.env ?? process.env
  const script = opts.scriptPath ?? resolveSidecarScript(env)
  const cwd = opts.cwd ?? path.dirname(script)
  const spawn = opts.spawn ?? realSpawn

  const child = spawn(script, { cwd, env })
  const transport = new StdioTransport(toHandle(child))
  setTransport(transport)

  try {
    await transport.whenReady(opts.readyTimeoutMs)
  } catch (err) {
    try {
      child.kill()
    } catch {
      // ignore — already dead
    }
    throw err
  }

  let stopped = false
  return {
    transport,
    shutdown: async () => {
      if (stopped) return
      stopped = true
      try {
        child.kill()
      } catch {
        // ignore
      }
    },
  }
}
