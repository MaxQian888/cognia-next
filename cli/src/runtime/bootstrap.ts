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
  stdin: { write(chunk: string): void } | null
  stdout: NodeJS.ReadableStream | null
  on(event: "exit", cb: (code: number | null) => void): unknown
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

/**
 * Locate `sidecar/claude-host.mjs`. Resolution order:
 *   1. `$COGNIA_SIDECAR_SCRIPT` (explicit override / bundled layout)
 *   2. a `sidecar/` dir walked up from this module (in-repo / dev)
 */
export function resolveSidecarScript(
  env: Record<string, string | undefined> = process.env
): string {
  const override = env.COGNIA_SIDECAR_SCRIPT?.trim()
  if (override) return override

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
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    "could not locate sidecar/claude-host.mjs — set COGNIA_SIDECAR_SCRIPT to its absolute path"
  )
}

const realSpawn: SpawnFn = (script, options) =>
  nodeSpawn("node", [script], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as SpawnedChild

/** Adapt a spawned child to the transport's {@link SidecarHandle}. */
function toHandle(child: SpawnedChild): SidecarHandle {
  if (!child.stdin || !child.stdout) {
    throw new Error("spawned sidecar is missing stdin/stdout pipes")
  }
  const stdin = child.stdin
  return {
    stdin: { write: (chunk) => stdin.write(chunk) },
    stdout: child.stdout,
    onExit: (cb) => {
      child.on("exit", cb)
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
