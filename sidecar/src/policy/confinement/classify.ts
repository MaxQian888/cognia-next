// Workspace confinement for the Cognia built-in tools (ADR-0028 "lite").
//
// The heavy OS sandbox (`src-tauri/src/sandbox/`) is only active when a session
// opts into sandbox mode. In the common default-off case the sidecar file/bash
// tools resolve absolute paths verbatim and run unconfined. This module is the
// always-on, cross-platform (incl. native Windows) middle layer that confines
// those tools to the workspace roots, reusing the tested path-canonicalisation
// from `src/platform/fs/paths.ts`.
//
// Two enforcement surfaces:
//   1. PERMISSION LAYER (`classifyToolCallConfinement`): consulted by the
//      permission ladder both rails climb (`../permission/ladder.ts`). It
//      returns a verdict that composes with the ruleset verdict:
//        - mutator (write/edit/bash) whose target escapes every root → "ask"
//          (escalate to the existing permission_request round-trip);
//        - any op resolving into a protected credential path (.ssh/.aws/…) or
//          through a symlink escape into one → "deny" (hard);
//        - read-only op outside the roots → "allow" (reads are not confined,
//          matching Anthropic's "write=cwd, read=whole machine except secrets").
//   2. TOOL-BODY BACKSTOP (`assertNotSecretEscape`): a defence-in-depth call the
//      mutator tools make even when no confinement policy is configured, so a
//      write can never land in a credential directory regardless of the gate.
//
// Pure: no I/O beyond path canonicalisation (mirrors `src/platform/fs/paths.ts`).

import { assertPathInside, canonicalisePartial, resolveToolPath } from "../../platform/fs/paths.ts"
import { isSecretPath } from "./secret-paths.ts"

export type ConfinementVerdict = "allow" | "ask" | "deny"

/** A plugin tool's declared filesystem class and path-valued params. */
export interface PluginToolAccess {
  access: "read" | "write"
  pathKeys: string[]
}

/** Bare plugin tool name → access, as a Map or a plain object. */
export type PluginAccessMap =
  ReadonlyMap<string, PluginToolAccess> | Readonly<Record<string, PluginToolAccess>>

/** The session's confinement settings; `roots` arrives from the renderer unchecked. */
export interface ConfinementPolicy {
  enabled?: boolean
  roots?: unknown
}

/** True when the (symlink-resolved) target lives inside `root`. */
function isInsideRoot(target: string, root: string): boolean {
  try {
    assertPathInside(root, target)
    return true
  } catch {
    return false
  }
}

/**
 * Classify one path (absolute or cwd-relative) for a given operation class,
 * against the absolute workspace `roots`.
 */
export function classifyPathForConfinement(
  cwd: string | undefined,
  roots: readonly string[],
  target: string,
  op: "read" | "write"
): ConfinementVerdict {
  const abs = resolveToolPath(cwd, target)
  const real = canonicalisePartial(abs)
  // Credential paths are hard-denied for both reads and writes — including a
  // symlink escape that resolves into one from a lexically-innocent path.
  if (isSecretPath(abs) || isSecretPath(real)) return "deny"
  // Symlink-aware containment: use the canonicalised path so a link that
  // escapes the workspace is judged by where it really points.
  const inside = roots.some((r) => isInsideRoot(real, r))
  if (inside) return "allow"
  // Outside every root: writes escalate to approval; reads are unconfined.
  return op === "write" ? "ask" : "allow"
}

// --- Tool → operation-class mapping. Bare names (ai-sdk path) and the SDK's
// PascalCase spellings both resolve to the same class. Namespaced
// `mcp__cognia-tools__<name>` forms are reduced to the bare name first.

// Membership here is what makes a tool VISIBLE to confinement at all: an
// unlisted name yields a `null` verdict, which every downstream `!== "ask"`
// guard treats as permission. Any tool that writes, deletes, or executes must
// therefore be listed, or it silently bypasses both the out-of-root "ask" and
// the credential hard-deny (including under `acceptEdits`/`bypassPermissions`).
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  // core file suite (ai-sdk bare + SDK PascalCase spellings)
  "write",
  "edit",
  "multi_edit",
  "notebook_edit",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "str_replace_based_edit_tool",
  "apply_patch",
  // fileExtras mutators
  "file_append",
  "file_binary_write",
  "file_copy",
  "file_rename",
  "file_move",
  "directory_create",
  "directory_delete",
  // git mutators
  "git_stage",
  "git_commit",
  // process / shell / pty — they carry a `cwd` and run arbitrary programs
  "start_process",
  "shell_execute_advanced",
  "terminal_repl_spawn",
  // structural rewrite
  "ast_grep_replace",
  // network-sourced writers
  "clone_dep_source",
  "web_clone",
  "web_clone_convert",
  // recurring shell predicate with an arbitrary cwd
  "Monitor",
])
export const READ_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "ls",
  "grep",
  "glob",
  "Read",
  "Grep",
  "Glob",
  // fileExtras readers — these reach the same bytes as `read`/`grep` and were
  // previously unclassified, so the credential deny did not apply to them.
  "file_hash",
  "file_diff",
  "file_info",
  "file_exists",
  "file_search",
  "content_search",
  "ast_grep_search",
  "list_cloned_deps",
  // git readers (cwd-scoped)
  "git_status",
  "git_diff",
  "git_log",
  "git_history",
  "git_branch",
  "git_remote",
  "git_tag",
  "git_repo_inspect",
  "git_changes",
])
export const BASH_TOOLS: ReadonlySet<string> = new Set(["bash", "Bash"])

/**
 * Every input key that can carry a filesystem path across the built-in tools.
 * `collectPathTargets` gathers ALL present keys — a tool carrying both
 * `file_path` and `path`, or both `source` and `destination`, must have every
 * one of them judged, not just the first that matches.
 */
const PATH_KEYS: readonly string[] = [
  "file_path",
  "filePath",
  "target",
  "target_path",
  "workdir",
  "path",
  "notebook_path",
  "source",
  "source_path",
  "destination",
  "destination_path",
  "dest",
  "oldPath",
  "newPath",
  "pathA",
  "pathB",
  "directory",
  "dir",
  "output",
  "output_path",
  "cwd",
]

/** Keys holding an array of paths (e.g. `ast_grep_replace.paths`). */
const PATH_ARRAY_KEYS: readonly string[] = ["paths"]

/** Reduce a namespaced tool name (`mcp__server__name`) to its bare `name`. */
export function bareToolName(toolName: unknown): string {
  const parts = String(toolName).split("__")
  return parts.length >= 3 && parts[0] === "mcp" && parts[1] === "cognia-tools"
    ? parts.slice(2).join("__")
    : String(toolName)
}

/**
 * Qualified-name prefix for the synthetic plugin-tools MCP server. A plugin
 * tool name is free-form (`ripgrep-tools:ripgrep_search` — colon included),
 * so we prefix-strip rather than `__`-split.
 */
const PLUGIN_TOOLS_PREFIX = "mcp__cognia-plugin-tools__"

/** Bare plugin tool name behind a `cognia-plugin-tools` name, else null. */
export function barePluginToolName(toolName: unknown): string | null {
  const s = String(toolName)
  return s.startsWith(PLUGIN_TOOLS_PREFIX) ? s.slice(PLUGIN_TOOLS_PREFIX.length) : null
}

/**
 * Names the host's sandboxed-tools plugin occupies under the plugin-tools
 * server. Their class is hardcoded in `sandboxAliases` below — a manifest
 * `access` declaration must not re-classify (let alone downgrade) them.
 */
const RESERVED_PLUGIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "sandbox_write",
  "sandbox_edit",
  "sandbox_text_editor",
  "sandbox_bash",
])

/**
 * Build the per-dispatch plugin-tools metadata map consumed by the
 * confinement gates. Keys are the FULL plugin tool name as sent on the wire
 * (`ripgrep-tools:ripgrep_search`); values are `{ access, pathKeys }` —
 * `access` is the declared filesystem class ("read"/"write"), `pathKeys`
 * the manifest-declared path-valued params that join PATH_KEYS as
 * confinement targets. Anything malformed is skipped — a tool that fails to
 * declare stays opaque, the historical default.
 *
 * `pluginTools` is `sendOptions.pluginTools`; non-arrays (older/foreign
 * senders) yield an empty map.
 */
export function buildPluginAccessMap(pluginTools: unknown): Map<string, PluginToolAccess> {
  const map = new Map<string, PluginToolAccess>()
  if (!Array.isArray(pluginTools)) return map
  for (const entry of pluginTools as unknown[]) {
    const t = entry as { name?: unknown; access?: unknown; pathParams?: unknown } | null
    if (!t || typeof t.name !== "string") continue
    if (t.access !== "read" && t.access !== "write") continue
    if (RESERVED_PLUGIN_TOOL_NAMES.has(t.name)) continue
    const pathKeys = Array.isArray(t.pathParams)
      ? (t.pathParams as unknown[]).filter(
          (k): k is string => typeof k === "string" && Boolean(k.trim())
        )
      : []
    map.set(t.name, { access: t.access, pathKeys })
  }
  return map
}

/**
 * The plugin-tools entry for `toolName`, looked up by bare name.
 * `pluginAccess` is a Map (or plain object) built once per dispatch by
 * `buildPluginAccessMap`. Tools that declared no class stay unclassified —
 * opaque to confinement, the historical default.
 */
export function pluginAccessFor(
  toolName: string,
  pluginAccess: PluginAccessMap | null | undefined
): PluginToolAccess | undefined {
  const bare = barePluginToolName(toolName)
  if (bare == null || pluginAccess == null) return undefined
  return typeof (pluginAccess as { get?: unknown }).get === "function"
    ? (pluginAccess as ReadonlyMap<string, PluginToolAccess>).get(bare)
    : (pluginAccess as Readonly<Record<string, PluginToolAccess>>)[bare]
}

/** Pull the file/dir path targets from a tool-call input. `extraKeys` lets a
 * plugin tool's manifest-declared path params join the built-in PATH_KEYS. */
export function collectPathTargets(
  bare: string,
  obj: Record<string, unknown>,
  extraKeys?: readonly string[]
): string[] {
  if (BASH_TOOLS.has(bare)) {
    // Default workdir is the cwd (inside the root) — only an explicit,
    // out-of-tree workdir is a target worth checking. The command string is
    // deliberately NOT parsed; see the module header.
    const directory = obj.workdir ?? obj.cwd
    const wd = typeof directory === "string" && directory.trim() ? directory : null
    return wd ? [wd] : []
  }
  const out: string[] = []
  const keys = extraKeys?.length ? [...PATH_KEYS, ...extraKeys] : PATH_KEYS
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === "string" && v.trim()) out.push(v)
  }
  for (const key of PATH_ARRAY_KEYS) {
    const arr = obj[key]
    if (!Array.isArray(arr)) continue
    for (const v of arr as unknown[]) if (typeof v === "string" && v.trim()) out.push(v)
  }
  for (const key of ["edits", "files", "operations"]) {
    const list = obj[key]
    if (Array.isArray(list)) {
      for (const entry of list as unknown[]) {
        if (entry && typeof entry === "object")
          out.push(...collectPathTargets(bare, entry as Record<string, unknown>, extraKeys))
      }
    }
  }
  return out
}

/** Verdict rank for composing confinement + ruleset decisions. */
const RANK: Record<ConfinementVerdict, number> = { allow: 0, ask: 1, deny: 2 }

/**
 * Compose two verdicts (either may be null) into the more-restrictive one.
 * deny > ask > allow. Returns null only when both are null.
 */
export function combineVerdict(
  a: ConfinementVerdict | null | undefined,
  b: ConfinementVerdict | null | undefined
): ConfinementVerdict | null {
  if (a == null) return b ?? null
  if (b == null) return a
  return RANK[b] > RANK[a] ? b : a
}

/**
 * Confinement verdict for a whole tool call, or `null` when confinement does
 * not apply (policy disabled/rootless, or the tool carries no path target).
 *
 * `pluginAccess` maps a bare plugin tool name to its declared access class
 * and path params (built from `sendOptions.pluginTools` by
 * `buildPluginAccessMap`), letting a plugin tool opt into the same read/write
 * classification the built-in sets get.
 */
export function classifyToolCallConfinement(
  policy: ConfinementPolicy | null | undefined,
  toolName: string,
  input: unknown,
  cwd: string | undefined,
  pluginAccess?: PluginAccessMap | null
): ConfinementVerdict | null {
  if (!policy || !policy.enabled) return null
  const roots: string[] = Array.isArray(policy.roots)
    ? (policy.roots as unknown[]).filter((root): root is string => Boolean(root))
    : []
  if (roots.length === 0) return null
  const bare = bareToolName(toolName)
  let isWrite = WRITE_TOOLS.has(bare) || BASH_TOOLS.has(bare)
  let isRead = READ_TOOLS.has(bare)
  let pluginPathKeys: string[] | undefined
  if (!isWrite && !isRead) {
    const entry = pluginAccessFor(toolName, pluginAccess)
    isWrite = entry?.access === "write"
    isRead = entry?.access === "read"
    pluginPathKeys = entry?.pathKeys
  }
  if (!isWrite && !isRead) return null
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const targets = collectPathTargets(bare, obj, pluginPathKeys)
  if (targets.length === 0) return null
  const op = isWrite ? "write" : "read"
  // Confinement only ever ADDS restriction — it must never upgrade a no-rule
  // ("null") verdict into an auto-approval. So an in-root "allow" contributes
  // nothing (null); only "ask" / "deny" are surfaced to compose with the ruleset.
  let worst: ConfinementVerdict | null = null
  for (const t of targets) {
    const v = classifyPathForConfinement(cwd, roots, t, op)
    if (v === "deny") return "deny"
    if (v === "ask") worst = "ask"
  }
  return worst
}
