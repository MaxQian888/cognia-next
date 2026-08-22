/**
 * The headless arm of the external-Agent version probe.
 *
 * Same command name and same answer shape as the desktop host
 * (`crates/cognia-external-agent/src/version_probe.rs`), so the renderer runs
 * one certification flow everywhere — the arrangement `check_command_exists`,
 * `resolve_pi_extension` and the four `dsh_runtime_*` commands already use.
 *
 * The caller passes a catalog id and nothing else. The command, its argument
 * vector and its timeout are read here from the shared catalog, so this can
 * never widen into an arbitrary-exec RPC arm reachable from a paired device.
 *
 * Facts only, no verdict: `assessRuntimeVersion()` decides what a version
 * means, and lives in one place so the two hosts cannot drift.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

import { findRuntimeById } from "@/lib/ai/agent/external/runtime-catalog"

import {
  agentSearchDirs,
  defaultAgentPathRuntime,
  resolveAgentSearchPath,
  type AgentPathRuntime,
} from "./agent-path"

/** Commands that run *another* package rather than being the runtime itself. */
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx"])

/** Matches the desktop cap; a failing probe can print a whole install log. */
const MAX_OUTPUT_BYTES = 8 * 1024

/** Mirrors `RuntimeVersionProbe` in Rust, field for field. */
export interface RuntimeVersionProbe {
  output: string | null
  executablePath: string | null
  executableDigest: string | null
  exitCode: number | null
  detail: string | null
}

const ABSENT: RuntimeVersionProbe = {
  output: null,
  executablePath: null,
  executableDigest: null,
  exitCode: null,
  detail: null,
}

export interface ProbeRuntimeVersionDeps {
  runtime?: AgentPathRuntime
  spawnFn?: typeof spawn
}

/** Resolve a bare command against the enriched search path, as the spawn does. */
export function resolveProbeExecutable(
  command: string,
  runtime: AgentPathRuntime = defaultAgentPathRuntime()
): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return fs.existsSync(trimmed) ? trimmed : null
  }

  const extensions =
    runtime.platform === "win32" ? (runtime.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""]
  for (const dir of agentSearchDirs(runtime)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${trimmed}${extension}`)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // Next candidate.
      }
    }
  }
  return null
}

/** Is this the runtime's own executable, or a runner that fetches one? */
export function isPackageRunner(command: string): boolean {
  const base = command.split(/[/\\]/).pop()?.toLowerCase() ?? ""
  return PACKAGE_RUNNERS.has(base.replace(/\.(?:exe|cmd|bat)$/, ""))
}

function truncate(text: string): string {
  return Buffer.byteLength(text) <= MAX_OUTPUT_BYTES
    ? text
    : Buffer.from(text).subarray(0, MAX_OUTPUT_BYTES).toString("utf8")
}

function digestOf(file: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  } catch {
    return null
  }
}

/**
 * Run one runtime's catalogued version probe.
 *
 * A timeout or a non-zero exit still returns `output`, because "the version is
 * unreadable" and "the runtime is not installed" are different facts and the
 * certification policy treats them differently. Only a command that cannot be
 * found at all reports `output: null`.
 */
export async function probeRuntimeVersion(
  runtimeId: string,
  deps: ProbeRuntimeVersionDeps = {}
): Promise<RuntimeVersionProbe> {
  const entry = findRuntimeById(runtimeId)
  if (!entry) throw new Error(`unknown runtime: ${runtimeId}`)

  if (!entry.versionProbe) {
    return { ...ABSENT, detail: `${runtimeId} declares no version probe` }
  }
  if (!entry.systemCommand) {
    return { ...ABSENT, detail: `${runtimeId} has no system command to probe` }
  }

  const runtime = deps.runtime ?? defaultAgentPathRuntime()
  const executablePath = resolveProbeExecutable(entry.systemCommand, runtime)
  if (!executablePath) {
    return {
      ...ABSENT,
      detail: `${entry.systemCommand} is not on PATH or any known install root`,
    }
  }

  // The resolved file for a package runner is `npx`, not the runtime. Recording
  // its digest as the runtime's identity would make an unpinned runtime look
  // stable while the package under it changed on every launch.
  const executableDigest = isPackageRunner(entry.systemCommand) ? null : digestOf(executablePath)

  const spawnFn = deps.spawnFn ?? spawn
  const { timeoutMs } = entry.versionProbe

  return new Promise<RuntimeVersionProbe>((resolve) => {
    let settled = false
    let collected = ""

    const child = spawnFn(executablePath, [...entry.versionProbe!.args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...runtime.env, PATH: resolveAgentSearchPath(runtime) } as NodeJS.ProcessEnv,
      // Own group, so the timeout kill takes the whole tree: `npx` forks
      // `node`, and killing only the parent leaves it running.
      detached: process.platform !== "win32",
    })

    const settle = (result: RuntimeVersionProbe) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      killTree(child.pid)
      settle({
        output: "",
        executablePath,
        executableDigest,
        exitCode: null,
        detail: `probe timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)

    // Several of these CLIs print their version on stderr.
    child.stdout?.on("data", (chunk: Buffer) => {
      collected += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      collected += chunk.toString()
    })

    child.on("error", (error: Error) => {
      settle({
        // It started resolving, so it is not "missing"; it just told us nothing.
        output: "",
        executablePath,
        executableDigest,
        exitCode: null,
        detail: `probe failed: ${error.message}`,
      })
    })

    child.on("close", (code: number | null) => {
      settle({
        output: truncate(collected),
        executablePath,
        executableDigest,
        exitCode: code,
        detail: null,
      })
    })
  })
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    // Negative pid = the whole group created by `detached`.
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL")
  } catch {
    // Already gone.
  }
}
