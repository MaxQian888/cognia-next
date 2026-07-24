/**
 * Cognia's tool policy, re-applied at the host boundary.
 *
 * Projecting a Cognia tool through MCP hands an external agent a capability it
 * did not have. That is only safe if Cognia decides — every time — what is
 * visible and what may run. The external agent's own permission callback governs
 * ITS tools; it is never evidence about ours.
 *
 * Two questions live here:
 *   1. `visibleBuiltinTools` — what may appear in `tools/list` at all, derived
 *      from the SAME resolved `SendOptions` the built-in backend consumes
 *      (category toggles, agent-mode/character allowlists, disabled overlays,
 *      plan mode). Anything filtered out is also denied at call time, so a name
 *      the model guessed cannot be invoked.
 *   2. `authorizeToolCall` — whether one concrete call may run: still visible,
 *      inside the workspace, and either pre-approved or approved by the user.
 *
 * The confinement check MIRRORS `sidecar/builtin-tools/confinement.mjs`. It is
 * re-derived here rather than imported because that module is part of the
 * sidecar bundle (a separate Node project outside the CLI's TS graph); the
 * duplication is intentional and narrow — Cognia must not trust a check that
 * runs inside the process it is confining.
 */

import path from "node:path"

import type { SendOptions } from "@cognia/agent-config-types"
import {
  BUILTIN_SERVER_NAME,
  BUILTIN_TOOL_CATEGORIES,
  listBuiltinTools,
  namespaced,
} from "@/lib/settings/builtin-tools"

import type { ResolvedCliSessionContext } from "../session-context"

/** Bare names of the built-ins that never require approval (read-only). */
export const READ_ONLY_BUILTIN_TOOLS: ReadonlySet<string> = new Set(
  listBuiltinTools()
    .filter((t) => !t.requiresApproval)
    .map((t) => t.name)
)

/** Bare tool names per category id, from the shared metadata. */
const TOOLS_BY_CATEGORY: ReadonlyMap<string, readonly string[]> = new Map(
  BUILTIN_TOOL_CATEGORIES.map((c) => [c.id, c.tools.map((t) => t.name)] as const)
)

/**
 * The `cognia-plugin-tools` names that must stay callable in plan mode.
 *
 * Mirrors the ai-sdk bridge's `PLAN_ALLOWED_PLUGIN_TOOLS`: plan mode's own
 * prompt tells the model to dispatch the read-only Explore/Plan subagents and to
 * ask clarifying questions, so blocking these would break the explore→plan flow.
 * Permitting the CALL does not widen the read-only guarantee — the dispatched
 * child inherits plan mode, and `ask_user` / `load_skill` have no side effects.
 */
const PLAN_ALLOWED_HOST_TOOLS: ReadonlySet<string> = new Set([
  "dispatch_agent",
  "Task",
  "load_skill",
  "ask_user",
])

/** Namespaced form for a host (plugin) tool. */
export function namespacedHostTool(name: string): string {
  return `mcp__cognia-plugin-tools__${name}`
}

export { BUILTIN_SERVER_NAME }

/**
 * Bare names of the built-in tools this session may advertise.
 *
 * Order follows the metadata (prompt-cache stability), and the result is exactly
 * what the built-in backend would expose for the same config — that equality is
 * the parity invariant the external path is held to.
 */
export function visibleBuiltinTools(options: SendOptions): string[] {
  const enabled = (options.builtinTools ?? {}) as Record<string, unknown>
  const allowed = options.allowedTools?.length ? new Set(options.allowedTools) : null
  const disallowed = new Set(options.disallowedTools ?? [])
  const planMode = options.permissionMode === "plan"
  const out: string[] = []
  for (const [category, names] of TOOLS_BY_CATEGORY) {
    if (enabled[category] !== true) continue
    for (const name of names) {
      const full = namespaced(name)
      if (disallowed.has(full) || disallowed.has(name)) continue
      // A non-empty allowlist is exhaustive — anything unlisted is out.
      if (allowed && !allowed.has(full) && !allowed.has(name)) continue
      // Plan mode is read-only: a mutating tool must not even be discoverable,
      // or the model wastes a turn calling something that will be refused.
      if (planMode && !READ_ONLY_BUILTIN_TOOLS.has(name)) continue
      out.push(name)
    }
  }
  return out
}

/** Bare names of the host/plugin tools this session may advertise. */
export function visibleHostTools(options: SendOptions): string[] {
  const disallowed = new Set(options.disallowedTools ?? [])
  const allowed = options.allowedTools?.length ? new Set(options.allowedTools) : null
  const planMode = options.permissionMode === "plan"
  const out: string[] = []
  for (const entry of options.pluginTools ?? []) {
    const full = namespacedHostTool(entry.name)
    if (disallowed.has(full) || disallowed.has(entry.name)) continue
    if (allowed && !allowed.has(full) && !allowed.has(entry.name)) continue
    if (planMode && !PLAN_ALLOWED_HOST_TOOLS.has(entry.name)) continue
    out.push(entry.name)
  }
  return out
}

// ── Workspace confinement (mirror of sidecar/builtin-tools/confinement.mjs) ───

/** Argument keys that carry a filesystem path on the built-in tool surface. */
const PATH_ARG_KEYS = [
  "path",
  "file_path",
  "filePath",
  "target",
  "target_path",
  "source",
  "source_path",
  "destination",
  "destination_path",
  "dest",
  "dir",
  "directory",
  "cwd",
  "notebook_path",
  "output_path",
]

/** Directory names whose contents are credentials, never workspace material. */
const SECRET_DIR_SEGMENTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".npmrc",
  ".cognia",
])

const SECRET_FILE_NAMES = new Set([
  ".netrc",
  ".pgpass",
  "credentials",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  "known_hosts",
])

/** True when `abs` reaches into a credential store, wherever it lives. */
export function isSecretPath(abs: string): boolean {
  const segments = abs.split(path.sep).filter(Boolean)
  if (segments.some((s) => SECRET_DIR_SEGMENTS.has(s))) return true
  const base = segments[segments.length - 1]
  return base !== undefined && SECRET_FILE_NAMES.has(base)
}

/** True when `target` resolves inside one of `roots`. */
export function isInsideRoots(roots: string[], target: string): boolean {
  const abs = path.resolve(target)
  return roots.some((root) => {
    const base = path.resolve(root)
    if (abs === base) return true
    return abs.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`)
  })
}

/** Every path-shaped argument in a tool call, resolved against `cwd`. */
export function extractPathArguments(args: unknown, cwd: string): string[] {
  if (!args || typeof args !== "object") return []
  const record = args as Record<string, unknown>
  const out: string[] = []
  for (const key of PATH_ARG_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) {
      out.push(path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value))
    }
  }
  // `edits`/`files` batches carry their own per-entry paths.
  for (const key of ["edits", "files", "operations"]) {
    const list = record[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) out.push(...extractPathArguments(entry, cwd))
  }
  return out
}

export interface ConfinementVerdict {
  allowed: boolean
  reason?: string
}

/**
 * Re-check workspace confinement for one call.
 *
 * Runs even when the external agent is sandboxed: a sandbox bounds the AGENT's
 * own syscalls, and a Cognia tool executed on its behalf is a different subject.
 * Secret paths are refused unconditionally — being inside the workspace does not
 * make `.ssh/id_rsa` workspace material.
 */
export function checkConfinement(roots: string[], cwd: string, args: unknown): ConfinementVerdict {
  const targets = extractPathArguments(args, cwd)
  for (const target of targets) {
    if (isSecretPath(target)) {
      return { allowed: false, reason: `refused: "${target}" is a credential path` }
    }
    if (roots.length > 0 && !isInsideRoots(roots, target)) {
      return {
        allowed: false,
        reason: `refused: "${target}" is outside the session workspace`,
      }
    }
  }
  return { allowed: true }
}

/** The roots a confined session may touch: cwd + policy roots + `/add-dir`. */
export function confinementRoots(session: ResolvedCliSessionContext): string[] {
  const policy = session.sendOptions.confinement
  if (!policy?.enabled) return []
  return [...new Set([session.cwd, ...policy.roots, ...session.additionalDirectories])]
}

/**
 * Does this call need a user decision, or is it already settled by policy?
 *
 * `suppressApprovalForTools` is where the session's read-only auto-approval and
 * the user's persisted "Allow always" rules land, so honouring it is what stops
 * a Cognia-projected call from prompting twice for something already trusted.
 */
export function needsApproval(options: SendOptions, namespacedName: string): boolean {
  const suppressed = new Set(options.suppressApprovalForTools ?? [])
  if (suppressed.has(namespacedName)) return false
  if (options.permissionMode === "bypassPermissions") return false
  if (options.permissionMode === "acceptEdits" && ACCEPT_EDITS_TOOLS.has(namespacedName)) {
    return false
  }
  return true
}

/**
 * Built-ins auto-approved in `acceptEdits` — the write/edit family a user who
 * "accepted edits" implicitly trusts. Mirrors the ai-sdk bridge's set;
 * deliberately excludes exec/process/git-mutation and rename/move ops.
 */
const ACCEPT_EDITS_TOOLS: ReadonlySet<string> = new Set(
  [
    "write",
    "edit",
    "multi_edit",
    "apply_patch",
    "NotebookEdit",
    "file_append",
    "file_binary_write",
  ].map(namespaced)
)
