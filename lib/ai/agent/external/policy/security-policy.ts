/**
 * Typed access to `protocol/external-agent-security-policy.json`.
 *
 * The launch-side twin of the capability manifest: that one says what an agent
 * CAN do, this one says what Cognia is willing to LAUNCH. Both are single
 * sources, and for the same reason — the allowlist, the sandbox platform gate
 * and the per-agent writable roots each used to exist twice (a TypeScript copy
 * in the CLI's sandbox launcher and a Rust copy in `cognia-external-agent`),
 * with a comment asking future readers to keep them in union. They had already
 * drifted: Rust rejected the `claude-agent-acp` binary the `claude-code` preset
 * actually spawns, carried a `cline` entry no preset references, and neither
 * side gave OpenCode a state root.
 *
 * TypeScript consumes this file directly. Rust keeps compiled-in literals — a
 * security allowlist must not depend on parsing a file at runtime — and
 * `pnpm audit:agent-capabilities` fails when the two disagree.
 */

import POLICY from "@/protocol/external-agent-security-policy.json"

export type SandboxPlatform = "darwin" | "linux" | "win32" | string

export interface AgentStateRootRule {
  /**
   * `contains` — substring of the resolved target.
   * `target` — the resolved target equals one of `values`.
   * `base` — the base command equals one of `values`.
   *
   * Pi needs the exact forms: "copilot" contains "pi".
   */
  match: "contains" | "target" | "base"
  values: string[]
  roots: string[]
}

interface RawPolicy {
  version: number
  sandbox: { supportedPlatforms: string[]; reasonKey: string }
  binaryAllowlist: { commands: string[] }
  npxPackageAllowlist: { packages: string[] }
  agentStateWritableRoots: { rules: AgentStateRootRule[] }
  fileRoots: { prefixes: string[] }
}

const policy = POLICY as unknown as RawPolicy

export const EXTERNAL_AGENT_SECURITY_POLICY_VERSION = policy.version

/** Platforms that can run the mandatory sandbox. */
export const SANDBOX_SUPPORTED_PLATFORMS: readonly string[] = policy.sandbox.supportedPlatforms

/** i18n key for "this platform cannot run external agents at all". */
export const SANDBOX_UNSUPPORTED_REASON_KEY = policy.sandbox.reasonKey

/** Bare binary names an external-agent spawn may execute. */
export const EXTERNAL_AGENT_BINARY_ALLOWLIST: readonly string[] = policy.binaryAllowlist.commands

/** Packages `npx` may execute. */
export const EXTERNAL_AGENT_NPX_ALLOWLIST: readonly string[] = policy.npxPackageAllowlist.packages

export const AGENT_STATE_ROOT_RULES: readonly AgentStateRootRule[] =
  policy.agentStateWritableRoots.rules

export const AGENT_STATE_FILE_ROOT_PREFIXES: readonly string[] = policy.fileRoots.prefixes

/**
 * Tauri's `@tauri-apps/plugin-os` spells platforms differently from Node.
 * Accepting both means a caller never has to remember which side it is on.
 */
const PLATFORM_ALIASES: Record<string, string> = {
  macos: "darwin",
  windows: "win32",
  win: "win32",
}

/**
 * Can this platform host an external agent?
 *
 * Answered from the policy rather than from `process.platform` directly so the
 * renderer, the CLI and the settings UI all refuse on the same platforms — the
 * Windows case is the one that matters, and it has to be visible in the UI
 * BEFORE a user configures an agent that could never start. Previously the only
 * place that knew was a `throw` deep inside the CLI's launcher, so a Windows
 * user could configure a Codex agent, save it, connect it, and only then learn
 * that Cognia never runs an external agent unsandboxed.
 */
export function externalAgentSandboxSupportsPlatform(platform?: string): boolean {
  const raw =
    platform ??
    (typeof process !== "undefined" && typeof process.platform === "string"
      ? process.platform
      : // A browser renderer has no platform and no spawn path either, so
        // there is nothing to sandbox and nothing to refuse.
        "darwin")
  const normalized = PLATFORM_ALIASES[raw] ?? raw
  return SANDBOX_SUPPORTED_PLATFORMS.includes(normalized)
}

/** Strip a Windows executable suffix and lower-case, as both launchers do. */
export function baseCommandName(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, "")
}

/**
 * The state directories an agent must be able to write, home-relative.
 *
 * `npx <package>` runs the package, so the state belongs to the package rather
 * than to npx — which is why the target and the base command are two different
 * inputs to the match.
 */
export function agentStateWritableRoots(command: string, args: readonly string[] = []): string[] {
  const base = baseCommandName(command)
  const npxPackage = base === "npx" ? args.find((arg) => !arg.startsWith("-")) : undefined
  const target = npxPackage ?? base

  const roots: string[] = []
  for (const rule of AGENT_STATE_ROOT_RULES) {
    const hit =
      rule.match === "contains"
        ? rule.values.some((value) => target.includes(value))
        : rule.match === "target"
          ? rule.values.includes(target)
          : rule.values.includes(base)
    if (hit) {
      for (const root of rule.roots) if (!roots.includes(root)) roots.push(root)
    }
  }
  return roots
}

/** Is this root a file (pre-created with `open`) rather than a directory? */
export function isAgentStateFileRoot(root: string): boolean {
  const name = root.split("/").pop() ?? root
  return AGENT_STATE_FILE_ROOT_PREFIXES.some((prefix) => name.startsWith(prefix))
}
