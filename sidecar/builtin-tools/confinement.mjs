// Workspace confinement for the Cognia built-in tools (ADR-0028 "lite").
//
// The heavy OS sandbox (`src-tauri/src/sandbox/`) is only active when a session
// opts into sandbox mode. In the common default-off case the sidecar file/bash
// tools resolve absolute paths verbatim and run unconfined. This module is the
// always-on, cross-platform (incl. native Windows) middle layer that confines
// those tools to the workspace roots, reusing the tested path-canonicalisation
// from `safety.mjs`.
//
// Two enforcement surfaces:
//   1. PERMISSION LAYER (`classifyToolCallConfinement`): consulted by the
//      `canUseTool` gates in `anthropic.mjs` / `ai-sdk-tools.mjs`. It returns a
//      verdict that composes with the ruleset verdict:
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
// Pure: no I/O beyond path canonicalisation (mirrors `safety.mjs`).

import path from "node:path"

import { assertPathInside, canonicalisePartial } from "./safety.mjs"

// --- Protected credential paths (mirror of Rust `sandbox/protected.rs`
// `is_secret_protected`). Neither readable nor writable inside the sandbox; here
// they are the hard-deny set for every tool. `.env` is deliberately NOT listed —
// it is a normal project file the agent legitimately reads/writes.

/**
 * Directory segments that mark a credential store.
 *
 * Kept in union with `cli/src/agent/tool-host/policy.ts`. The two enforcement
 * points stay separate on purpose (Cognia must not trust a check running inside
 * the process it confines), but the DATA must not drift — and it had: `.cognia`
 * existed only CLI-side, while `.gpg` / `.config/gcloud` existed only here.
 */
const SECRET_DIR_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".kube",
  ".docker",
  ".npmrc",
  ".cognia",
  ".config/gcloud",
])

/** Basenames that are themselves credential files anywhere on disk. */
const SECRET_FILE_NAMES = new Set([
  ".git-credentials",
  ".npmrc",
  ".netrc",
  "_netrc",
  ".pypirc",
  ".pgpass",
  "credentials",
  "id_rsa",
  "id_ed25519",
  "known_hosts",
])

/** Two-segment secret paths (`<dir>/<child>`), e.g. `~/.config/gh`. */
const SECRET_SEGMENT_PAIRS = [[".config", "gh"]]

/**
 * Case-fold on the platforms with case-insensitive filesystems. macOS was
 * missing, so a first write to `~/.AWS/credentials` on a machine with no
 * existing `~/.aws` slipped past (an existing path is normally saved by
 * `realpathSync.native` returning the true on-disk case).
 */
function foldCase(s) {
  return process.platform === "win32" || process.platform === "darwin" ? s.toLowerCase() : s
}

/** Split an absolute path into normalized, case-folded segments. */
function segmentsOf(abs) {
  return foldCase(path.normalize(abs))
    .split(/[\\/]+/)
    .filter(Boolean)
}

/**
 * True when `abs` is, sits under, or names a protected credential path.
 * Segment-based so it is drive/UNC/`~`-agnostic and case-correct per platform.
 */
export function isSecretPath(abs) {
  if (typeof abs !== "string" || abs.length === 0) return false
  const segs = segmentsOf(abs)
  const base = segs[segs.length - 1]
  if (base && SECRET_FILE_NAMES.has(base)) return true
  for (let i = 0; i < segs.length; i++) {
    if (SECRET_DIR_SEGMENTS.has(segs[i])) return true
    // Multi-segment dir markers ("config/gcloud").
    if (i + 1 < segs.length && SECRET_DIR_SEGMENTS.has(`${segs[i]}/${segs[i + 1]}`)) return true
    for (const [a, b] of SECRET_SEGMENT_PAIRS) {
      if (segs[i] === a && segs[i + 1] === b) return true
    }
  }
  return false
}

/** Resolve a possibly-relative tool path against the session cwd. */
function resolveAbs(cwd, target) {
  return path.isAbsolute(target)
    ? path.normalize(target)
    : path.resolve(cwd ?? process.cwd(), target)
}

/** True when the (symlink-resolved) target lives inside `root`. */
function isInsideRoot(target, root) {
  try {
    assertPathInside(root, target)
    return true
  } catch {
    return false
  }
}

/**
 * Classify one path for a given operation class.
 *
 * @param {string|undefined} cwd
 * @param {string[]} roots       Absolute workspace roots.
 * @param {string} target        Absolute or cwd-relative path.
 * @param {"read"|"write"} op
 * @returns {"allow"|"ask"|"deny"}
 */
export function classifyPathForConfinement(cwd, roots, target, op) {
  const abs = resolveAbs(cwd, target)
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
const WRITE_TOOLS = new Set([
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
const READ_TOOLS = new Set([
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
const BASH_TOOLS = new Set(["bash", "Bash"])

/**
 * Every input key that can carry a filesystem path across the built-in tools.
 * `collectPathTargets` gathers ALL present keys — a tool carrying both
 * `file_path` and `path`, or both `source` and `destination`, must have every
 * one of them judged, not just the first that matches.
 */
const PATH_KEYS = [
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
const PATH_ARRAY_KEYS = ["paths"]

/** Reduce a namespaced tool name (`mcp__server__name`) to its bare `name`. */
export function bareToolName(toolName) {
  const parts = String(toolName).split("__")
  return parts.length >= 3 && parts[0] === "mcp" && parts[1] === "cognia-tools"
    ? parts.slice(2).join("__")
    : String(toolName)
}

/** Pull the file/dir path targets from a tool-call input. */
function collectPathTargets(bare, obj) {
  if (BASH_TOOLS.has(bare)) {
    // Default workdir is the cwd (inside the root) — only an explicit,
    // out-of-tree workdir is a target worth checking. The command string is
    // deliberately NOT parsed; see the module header.
    const directory = obj.workdir ?? obj.cwd
    const wd = typeof directory === "string" && directory.trim() ? directory : null
    return wd ? [wd] : []
  }
  const out = []
  for (const key of PATH_KEYS) {
    const v = obj[key]
    if (typeof v === "string" && v.trim()) out.push(v)
  }
  for (const key of PATH_ARRAY_KEYS) {
    const arr = obj[key]
    if (!Array.isArray(arr)) continue
    for (const v of arr) if (typeof v === "string" && v.trim()) out.push(v)
  }
  for (const key of ["edits", "files", "operations"]) {
    if (Array.isArray(obj[key])) {
      for (const entry of obj[key]) {
        if (entry && typeof entry === "object") out.push(...collectPathTargets(bare, entry))
      }
    }
  }
  return out
}

/** Enforce the host-owned scope immediately before a native tool body runs. */
export function assertToolCallWithinRoots(policy, toolName, input, cwd) {
  if (!policy) return
  const sandboxAliases = {
    "mcp__cognia-plugin-tools__sandbox_write": "write",
    "mcp__cognia-plugin-tools__sandbox_edit": "edit",
    "mcp__cognia-plugin-tools__sandbox_text_editor": input?.command === "view" ? "read" : "edit",
    "mcp__cognia-plugin-tools__sandbox_bash": "bash",
  }
  const bare = sandboxAliases[toolName] ?? bareToolName(toolName)
  if (!WRITE_TOOLS.has(bare) && !READ_TOOLS.has(bare) && !BASH_TOOLS.has(bare)) return
  const write = WRITE_TOOLS.has(bare) || BASH_TOOLS.has(bare)
  for (const target of collectPathTargets(bare, input && typeof input === "object" ? input : {})) {
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

/** Verdict rank for composing confinement + ruleset decisions. */
const RANK = { allow: 0, ask: 1, deny: 2 }

/**
 * Compose two verdicts (either may be null) into the more-restrictive one.
 * deny > ask > allow. Returns null only when both are null.
 */
export function combineVerdict(a, b) {
  if (a == null) return b ?? null
  if (b == null) return a
  return RANK[b] > RANK[a] ? b : a
}

/**
 * Confinement verdict for a whole tool call, or `null` when confinement does
 * not apply (policy disabled/rootless, or the tool carries no path target).
 *
 * @param {{ enabled?: boolean, roots?: string[] } | null | undefined} policy
 * @param {string} toolName
 * @param {any} input
 * @param {string|undefined} cwd
 * @returns {"allow"|"ask"|"deny"|null}
 */
export function classifyToolCallConfinement(policy, toolName, input, cwd) {
  if (!policy || !policy.enabled) return null
  const roots = Array.isArray(policy.roots) ? policy.roots.filter(Boolean) : []
  if (roots.length === 0) return null
  const bare = bareToolName(toolName)
  const isWrite = WRITE_TOOLS.has(bare) || BASH_TOOLS.has(bare)
  const isRead = READ_TOOLS.has(bare)
  if (!isWrite && !isRead) return null
  const obj = input && typeof input === "object" ? input : {}
  const targets = collectPathTargets(bare, obj)
  if (targets.length === 0) return null
  const op = isWrite ? "write" : "read"
  // Confinement only ever ADDS restriction — it must never upgrade a no-rule
  // ("null") verdict into an auto-approval. So an in-root "allow" contributes
  // nothing (null); only "ask" / "deny" are surfaced to compose with the ruleset.
  let worst = null
  for (const t of targets) {
    const v = classifyPathForConfinement(cwd, roots, t, op)
    if (v === "deny") return "deny"
    if (v === "ask") worst = "ask"
  }
  return worst
}

/**
 * Tool-body defence-in-depth: throw if a write target resolves into a protected
 * credential path (directly or via a symlink escape). Called by the mutator
 * tools regardless of whether a confinement policy is configured, so a write
 * can never backdoor `~/.ssh`, `~/.aws`, `.git-credentials`, etc.
 *
 * @param {string|undefined} cwd
 * @param {string} target  Absolute or cwd-relative write path.
 */
export function assertNotSecretEscape(cwd, target) {
  const abs = resolveAbs(cwd, target)
  const real = canonicalisePartial(abs)
  if (isSecretPath(abs) || isSecretPath(real)) {
    throw new Error(`refusing to write into a protected credential path: ${real}`)
  }
}
