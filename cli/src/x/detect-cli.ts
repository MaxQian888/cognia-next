/**
 * Agent CLI detection for `cognia x <agent>`.
 *
 * Probes whether a supported external coding agent CLI (e.g. `claude`, `codex`)
 * is installed on the user's PATH. Returns the resolved binary path and version
 * when available, plus actionable install instructions when missing.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

interface BunTextStream {
  text(): Promise<string>
}

interface BunVersionSubprocess {
  exited: Promise<number>
  stdout: BunTextStream
  stderr: BunTextStream
}

export interface BunAgentCliRuntime {
  which(command: string, options?: { PATH?: string; cwd?: string }): string | null
  spawn(
    command: string[],
    options: {
      stdin: "ignore"
      stdout: "pipe"
      stderr: "pipe"
      timeout: number
      killSignal: NodeJS.Signals
      maxBuffer: number
    }
  ): BunVersionSubprocess
}

function defaultBunRuntime(): BunAgentCliRuntime | undefined {
  const runtime = (globalThis as { Bun?: Partial<BunAgentCliRuntime> }).Bun
  return typeof runtime?.which === "function" && typeof runtime.spawn === "function"
    ? (runtime as BunAgentCliRuntime)
    : undefined
}

/** Agents supported by `cognia x`. */
export type SupportedAgent = "claude" | "codex"

export interface DetectResult {
  installed: boolean
  /** Absolute path to the agent binary (only set when installed). */
  path?: string
  /** Version string returned by `<agent> --version` (best-effort). */
  version?: string
  /** Human-readable install instruction (only set when NOT installed). */
  installHint?: string
}

/** Command name on PATH for each agent. */
const AGENT_BINARY: Record<SupportedAgent, string> = {
  claude: "claude",
  codex: "codex",
}

/** Install instructions shown when the agent is missing. */
const INSTALL_HINTS: Record<SupportedAgent, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
}

/** Version flags per agent. Some may use `--version`, others `-v`. */
const VERSION_FLAGS: Record<SupportedAgent, string[]> = {
  claude: ["--version"],
  codex: ["--version"],
}

/**
 * Resolve the absolute path of a binary via the system `which` (macOS/Linux)
 * or `where` (Windows). Returns `undefined` when not found.
 */
async function whichBinary(
  name: string,
  bunRuntime: BunAgentCliRuntime | undefined
): Promise<string | undefined> {
  if (bunRuntime) return bunRuntime.which(name) ?? undefined
  const cmd = process.platform === "win32" ? "where" : "which"
  try {
    const { stdout } = await execFileAsync(cmd, [name], { timeout: 5_000 })
    const first = stdout.trim().split("\n")[0]
    return first || undefined
  } catch {
    return undefined
  }
}

/**
 * Attempt to read the version of an installed agent CLI.
 * Returns `undefined` on any failure (silent — version is best-effort).
 */
async function readVersion(
  binPath: string,
  flags: string[],
  bunRuntime: BunAgentCliRuntime | undefined
): Promise<string | undefined> {
  try {
    let stdout: string
    let stderr: string
    if (bunRuntime) {
      const child = bunRuntime.spawn([binPath, ...flags], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      })
      const [exitCode, stdoutText, stderrText] = await Promise.all([
        child.exited,
        child.stdout.text(),
        child.stderr.text(),
      ])
      if (exitCode !== 0) return undefined
      stdout = stdoutText
      stderr = stderrText
    } else {
      const result = await execFileAsync(binPath, flags, { timeout: 10_000 })
      stdout = result.stdout
      stderr = result.stderr
    }
    // Some CLIs print version to stderr; use whichever has content.
    const raw = (stdout || stderr).trim()
    const firstLine = raw.split("\n")[0] ?? ""
    // Common outputs include `claude v1.2.3` and `codex-cli 0.145.0`.
    return (
      firstLine.match(/(?:^|\s)v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/)?.[1] ?? firstLine
    )
  } catch {
    return undefined
  }
}

/**
 * Detect whether the given agent CLI is available on PATH.
 *
 * @param agent - Which agent to look for (`claude` or `codex`)
 * @param deps  - Injectable `which` for testing
 */
export async function detectAgentCli(
  agent: SupportedAgent,
  deps: {
    which?: (name: string) => Promise<string | undefined>
    bunRuntime?: BunAgentCliRuntime | null
  } = {}
): Promise<DetectResult> {
  const binary = AGENT_BINARY[agent]
  const bunRuntime =
    deps.bunRuntime === undefined ? defaultBunRuntime() : (deps.bunRuntime ?? undefined)
  const resolve = deps.which ?? ((name: string) => whichBinary(name, bunRuntime))

  const binPath = await resolve(binary)
  if (!binPath) {
    return {
      installed: false,
      installHint: INSTALL_HINTS[agent],
    }
  }

  const version = await readVersion(binPath, VERSION_FLAGS[agent], bunRuntime)
  return {
    installed: true,
    path: binPath,
    version,
  }
}
