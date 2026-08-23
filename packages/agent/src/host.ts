// static-export-exempt: Agent host lifecycle runs exclusively in the Node CLI/sidecar.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
// static-export-exempt: Agent host lifecycle runs exclusively in the Node CLI/sidecar.
import { createRequire } from "node:module"
// static-export-exempt: Agent host lifecycle runs exclusively in the Node CLI/sidecar.
import { existsSync, readFileSync } from "node:fs"
// static-export-exempt: Agent host lifecycle runs exclusively in the Node CLI/sidecar.
import path from "node:path"

import { HostNotFoundError } from "./host-errors"
import type { RpcReadable, RpcWritable } from "./rpc/duplex"
import type { CogniaDiagnostic } from "./types"

export { HostNotFoundError }

export type CogniaHostOption =
  | { kind: "bundled"; startupTimeoutMs?: number }
  | {
      kind: "path"
      path: string
      args?: string[]
      cwd?: string
      env?: Record<string, string>
      startupTimeoutMs?: number
    }
  | {
      kind: "streams"
      readable: RpcReadable
      writable: RpcWritable
      /**
       * Rebuilds the transport after a drop, enabling reconnection for an
       * injected-stream host.
       *
       * Without it the SDK cannot reconnect a `streams` host at all: it was
       * handed one pair of pipes and has no way to make another. `bundled` and
       * `path` hosts need no factory — the SDK can respawn the binary itself.
       */
      factory?: () => Promise<HostStreams> | HostStreams
    }

export interface HostStreams {
  readable: RpcReadable
  writable: RpcWritable
}

export interface OpenHostResult {
  readable: RpcReadable
  writable: RpcWritable
  startupTimeoutMs: number
  close(): Promise<void>
  process?: ChildProcessWithoutNullStreams
  startupFailure?: Promise<never>
  searchedLocations: readonly string[]
}

const PLATFORM_PACKAGES: Partial<Record<`${NodeJS.Platform}-${string}`, string>> = {
  "darwin-arm64": "@cognia/agent-host-darwin-arm64",
  "linux-x64": "@cognia/agent-host-linux-x64",
  "win32-x64": "@cognia/agent-host-win32-x64",
}

export function resolveBundledHost(): { command: string; searchedLocations: string[] } | null {
  const packageName = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`]
  if (!packageName) return null
  const searchedLocations = [packageName]

  try {
    const require = createRequire(import.meta.url)
    const packageJsonPath = require.resolve(`${packageName}/package.json`)
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>
    }
    const relativeBin =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : (packageJson.bin?.["cognia-agent"] ?? packageJson.bin?.cognia)
    if (!relativeBin) return null
    const command = path.resolve(path.dirname(packageJsonPath), relativeBin)
    if (!existsSync(command)) return null
    return { command, searchedLocations: [...searchedLocations, command] }
  } catch {
    return null
  }
}

export function openHost(
  host: CogniaHostOption | undefined,
  onDiagnostic?: (diagnostic: CogniaDiagnostic) => void
): OpenHostResult {
  if (host?.kind === "streams") {
    return {
      readable: host.readable,
      writable: host.writable,
      startupTimeoutMs: 15_000,
      searchedLocations: ["injected streams"],
      async close() {},
    }
  }

  const searchedLocations: string[] = []
  let command: string
  let args: string[]
  let cwd: string | undefined
  let env: Record<string, string> | undefined
  let startupTimeoutMs: number

  if (host?.kind === "path") {
    command = host.path
    args = host.args ?? ["rpc"]
    cwd = host.cwd
    env = host.env
    startupTimeoutMs = host.startupTimeoutMs ?? 15_000
    searchedLocations.push(command)
    if (command.includes(path.sep) && !existsSync(command))
      throw new HostNotFoundError(searchedLocations)
  } else {
    const bundled = resolveBundledHost()
    if (bundled) {
      command = bundled.command
      searchedLocations.push(...bundled.searchedLocations)
    } else {
      const packageName = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`]
      if (packageName) searchedLocations.push(packageName)
      command = "cognia-agent"
    }
    searchedLocations.push("cognia-agent on PATH")
    args = ["rpc"]
    startupTimeoutMs = host?.startupTimeoutMs ?? 15_000
  }

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const startupFailure = new Promise<never>((_, reject) => {
    child.once("error", reject)
  })
  child.stderr.on("data", (chunk: Buffer | string) => {
    const message = String(chunk).trim()
    if (message) onDiagnostic?.({ level: "info", message })
  })

  return {
    readable: child.stdout,
    writable: child.stdin,
    startupTimeoutMs,
    process: child,
    startupFailure,
    searchedLocations,
    async close() {
      if (child.exitCode !== null || child.killed) return
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL")
          resolve()
        }, 3_000)
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}
