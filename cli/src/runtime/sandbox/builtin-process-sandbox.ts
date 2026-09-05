import path from "node:path"
import { findSandboxLauncher } from "../external/sandbox-launcher"
import type { ResolvedConfig } from "../../config/schema"

/** Reuse the stdio-preserving OS launcher for session-owned coding processes. */
export function resolveBuiltinProcessSandbox(
  config: ResolvedConfig,
  findLauncher: () => string | undefined = findSandboxLauncher
) {
  if (config.sandbox?.enabled !== true || config.sandbox.tier === "microvm") return undefined
  const policy = config.sandbox.policy
  const resolve = (root: string) => path.resolve(config.cwd, root)
  const launcher = findLauncher() ?? ""
  const unavailableReason =
    policy?.network === "allowlist"
      ? "The OS process sandbox does not support network allowlists. Set sandbox.policy.network to off, or use a sandbox tier that supports your network policy."
      : !launcher
        ? "The OS process sandbox launcher is unavailable. Reinstall cognia-agent or set COGNIA_EXTERNAL_AGENT_LAUNCHER to a built helper (repository: pnpm cli:external-host:build)."
        : undefined
  return {
    ...(unavailableReason ? { unavailableReason } : {}),
    // An unavailable launcher is an enforcing failure, never an unconfined fallback.
    launcher,
    writableRoots: [...new Set((policy?.writableRoots ?? [config.cwd]).map(resolve))],
    readableRoots: [...new Set([config.cwd, ...(policy?.readableRoots ?? []).map(resolve)])],
    network: policy?.network === "on",
  }
}
