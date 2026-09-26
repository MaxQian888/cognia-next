// The throwing half of workspace confinement, called from tool bodies right
// before they touch the filesystem. The permission-layer verdicts live in
// ./classify.ts.

import { canonicalisePartial, resolveToolPath } from "../../platform/fs/paths.ts"
import {
  BASH_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
  bareToolName,
  classifyPathForConfinement,
  collectPathTargets,
  pluginAccessFor,
} from "./classify.ts"
import type { PluginAccessMap } from "./classify.ts"
import { isSecretPath } from "./secret-paths.ts"

/** The host-owned sandbox scope a native tool body must stay inside. */
export interface SandboxScopePolicy {
  writableRoots?: string[]
}

/** Enforce the host-owned scope immediately before a native tool body runs. */
export function assertToolCallWithinRoots(
  policy: SandboxScopePolicy | null | undefined,
  toolName: string,
  input: unknown,
  cwd: string | undefined,
  pluginAccess?: PluginAccessMap | null
): void {
  if (!policy) return
  const command = (input as { command?: unknown } | null | undefined)?.command
  const sandboxAliases: Record<string, string> = {
    "mcp__cognia-plugin-tools__sandbox_write": "write",
    "mcp__cognia-plugin-tools__sandbox_edit": "edit",
    "mcp__cognia-plugin-tools__sandbox_text_editor": command === "view" ? "read" : "edit",
    "mcp__cognia-plugin-tools__sandbox_bash": "bash",
  }
  const bare = sandboxAliases[toolName] ?? bareToolName(toolName)
  let isWrite = WRITE_TOOLS.has(bare)
  let isRead = READ_TOOLS.has(bare)
  let isBash = BASH_TOOLS.has(bare)
  let pluginPathKeys: string[] | undefined
  if (!isWrite && !isRead && !isBash) {
    // Plugin tools opt into scope enforcement via manifest `access`; the
    // four sandbox_* aliases above keep their hardcoded class.
    const entry = pluginAccessFor(toolName, pluginAccess)
    isWrite = entry?.access === "write"
    isRead = entry?.access === "read"
    pluginPathKeys = entry?.pathKeys
  }
  if (!isWrite && !isRead && !isBash) return
  const write = isWrite || isBash
  for (const target of collectPathTargets(
    bare,
    input && typeof input === "object" ? (input as Record<string, unknown>) : {},
    pluginPathKeys
  )) {
    const verdict = classifyPathForConfinement(
      cwd,
      policy.writableRoots ?? [],
      target,
      write ? "write" : "read"
    )
    if (verdict !== "allow")
      throw new Error(
        `workspace sandbox refused ${toolName}: ${target} is outside sandbox.policy.writableRoots or is protected. Add the required directory to sandbox.policy.writableRoots and retry; approval cannot widen this fixed scope.`
      )
  }
}

/**
 * Tool-body defence-in-depth: throw if a write target resolves into a protected
 * credential path (directly or via a symlink escape). Called by the mutator
 * tools regardless of whether a confinement policy is configured, so a write
 * can never backdoor `~/.ssh`, `~/.aws`, `.git-credentials`, etc. `target` is
 * the absolute or cwd-relative write path.
 */
export function assertNotSecretEscape(cwd: string | undefined, target: string): void {
  const abs = resolveToolPath(cwd, target)
  const real = canonicalisePartial(abs)
  if (isSecretPath(abs) || isSecretPath(real)) {
    throw new Error(`refusing to write into a protected credential path: ${real}`)
  }
}
