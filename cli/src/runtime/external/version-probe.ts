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
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { findRuntimeById } from "@/lib/ai/agent/external/config/install-catalog"

import {
  agentSearchDirs,
  defaultAgentPathRuntime,
  resolveAgentSearchPath,
  type AgentPathRuntime,
} from "./agent-path"
import { hashHex } from "../crypto-hasher"
import {
  nativeBridgeInterpreterEnvironment,
  resolveNativeBridgeInterpreter,
} from "./native-bridges"

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
  resolveBridgeInterpreter?: () => string
}

/** Keep partial test/runtime env bags inside this repo's strict Node env contract. */
export function normalizeProbeNodeEnv(value: string | undefined): NodeJS.ProcessEnv["NODE_ENV"] {
  return value === "development" || value === "test" || value === "production"
    ? value
    : "production"
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
  const bareCommand =
    runtime.platform === "win32" && trimmed === "agy_acp_server.par" ? "agy_acp_server" : trimmed
  for (const dir of agentSearchDirs(runtime)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${bareCommand}${extension}`)
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
    return hashHex("sha256", fs.readFileSync(file))
  } catch {
    return null
  }
}

/** The official ACP release owns both executable files; caller-selected helpers are never trusted. */
export function antigravityBundle(
  command: string,
  runtime: AgentPathRuntime = defaultAgentPathRuntime()
): { executablePath: string; harnessPath: string } | undefined {
  const base = path
    .basename(command)
    .toLowerCase()
    .replace(/\.exe$/, "")
  if (base !== "agy_acp_server.par" && base !== "agy_acp_server") return undefined
  const resolved = resolveProbeExecutable(command, runtime)
  if (!resolved) throw new Error("Antigravity ACP server is not installed")
  const executablePath = fs.realpathSync(resolved)
  const harnessPath = path.join(
    path.dirname(executablePath),
    runtime.platform === "win32" ? "localharness_external.exe" : "localharness_external"
  )
  try {
    if (!fs.lstatSync(harnessPath).isFile() || fs.lstatSync(harnessPath).isSymbolicLink())
      throw new Error("helper must be a regular file")
    fs.accessSync(harnessPath, fs.constants.X_OK)
    fs.accessSync(executablePath, fs.constants.X_OK)
  } catch {
    throw new Error(
      "Antigravity ACP requires an executable localharness_external beside its server"
    )
  }
  return { executablePath, harnessPath }
}

/** Hash large native releases without blocking the event loop or retaining them in memory. */
export async function antigravityBundleDigest(bundle: {
  executablePath: string
  harnessPath: string
}): Promise<string> {
  const hashFile = async (file: string): Promise<string> => {
    const hash = createHash("sha256")
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    return hash.digest("hex")
  }
  const serverDigest = await hashFile(bundle.executablePath)
  const helperDigest = await hashFile(bundle.harnessPath)
  return hashHex("sha256", `antigravity-acp-v1\n${serverDigest}\n${helperDigest}\n`)
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
  // Codebuff runs on a verified plain Node, which need not be the host executable.
  // Its only interpreter probe is fixed here, independently of caller input.
  if (
    runtimeId === "codebuff" &&
    (entry.systemCommand !== "node" ||
      entry.versionProbe.args.length !== 1 ||
      entry.versionProbe.args[0] !== "--version")
  )
    throw new Error("Codebuff host Node probe must be exactly node --version")
  let executablePath: string | null
  try {
    executablePath =
      runtimeId === "codebuff"
        ? (
            deps.resolveBridgeInterpreter ??
            (() =>
              deps.runtime
                ? resolveNativeBridgeInterpreter({ runtime })
                : resolveNativeBridgeInterpreter())
          )()
        : resolveProbeExecutable(entry.systemCommand, runtime)
  } catch (error) {
    return { ...ABSENT, detail: error instanceof Error ? error.message : String(error) }
  }
  if (!executablePath) {
    return {
      ...ABSENT,
      detail: `${entry.systemCommand} is not on PATH or any known install root`,
    }
  }

  // The resolved file for a package runner is `npx`, not the runtime. Recording
  // its digest as the runtime's identity would make an unpinned runtime look
  // stable while the package under it changed on every launch.
  let executableDigest: string | null
  let harnessPath: string | undefined
  try {
    const bundle = antigravityBundle(entry.systemCommand, runtime)
    if (bundle) {
      executablePath = bundle.executablePath
      harnessPath = bundle.harnessPath
    }
    executableDigest = bundle
      ? await antigravityBundleDigest(bundle)
      : isPackageRunner(entry.systemCommand)
        ? null
        : digestOf(executablePath)
  } catch (error) {
    return {
      output: "",
      executablePath,
      executableDigest: null,
      exitCode: null,
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  const spawnFn = deps.spawnFn ?? spawn
  const { timeoutMs } = entry.versionProbe

  return new Promise<RuntimeVersionProbe>((resolve) => {
    let settled = false
    let collected = ""

    const child = spawnFn(executablePath, [...entry.versionProbe!.args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...(runtimeId === "codebuff"
          ? nativeBridgeInterpreterEnvironment(runtime.env)
          : runtime.env),
        NODE_ENV: normalizeProbeNodeEnv(runtime.env.NODE_ENV ?? process.env.NODE_ENV),
        PATH: resolveAgentSearchPath(runtime),
        ...(harnessPath ? { ANTIGRAVITY_HARNESS_PATH: harnessPath } : {}),
      },
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
