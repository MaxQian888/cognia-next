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
async function whichBinary(name: string): Promise<string | undefined> {
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
async function readVersion(binPath: string, flags: string[]): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, flags, { timeout: 10_000 })
    // Some CLIs print version to stderr; use whichever has content.
    const raw = (stdout || stderr).trim()
    // Strip common prefixes: "claude v1.2.3" → "1.2.3"
    return raw.replace(/^[a-zA-Z\s]+v?/i, "").split("\n")[0] || raw
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
  deps: { which?: typeof whichBinary } = {}
): Promise<DetectResult> {
  const binary = AGENT_BINARY[agent]
  const resolve = deps.which ?? whichBinary

  const binPath = await resolve(binary)
  if (!binPath) {
    return {
      installed: false,
      installHint: INSTALL_HINTS[agent],
    }
  }

  const version = await readVersion(binPath, VERSION_FLAGS[agent])
  return {
    installed: true,
    path: binPath,
    version,
  }
}
