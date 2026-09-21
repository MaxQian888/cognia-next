/**
 * The host's half of the `delegate-work-1` tool policy (ADR-0188 B4, WP-D3).
 *
 * The package decides what a worker may ASK for (`DELEGATE_WORK_TOOLS`,
 * `DelegateToolArgs`, `normalizeDelegatePath`). This module decides what this
 * device will DO, and it is deliberately stricter:
 *
 * 1. **The policy has no way to run anything.** It offers exactly three tools —
 *    read a file, list files, propose a whole-file patch. There is no shell, no
 *    network fetch, no package install and no external write, so "the generated
 *    code reached the network" (SAFE-02) cannot happen through a tool at all;
 *    it can only happen inside the acceptance sandbox, which
 *    `code-acceptance-host.ts` runs with no network and no socket mount.
 * 2. **Paths are refused before any I/O**, on top of the package's rules:
 *    credential-shaped names (`.env`, `*.pem`, `id_rsa`, …) through the same
 *    `isSensitiveResourcePath` the panel's `workspace_read` uses, host surfaces
 *    (`proc/`, `sys/`, `dev/`, `var/run/`, anything ending in `.sock` —
 *    the docker socket by any name), and the home dotfiles that carry tokens
 *    (`.netrc`, `.npmrc`, `.git-credentials`, …). `..`, absolute paths, drive
 *    letters, `~` and the `.git` / `.ssh` / `.aws` / `.gnupg` / `.kube` /
 *    `.docker` directories are already refused by `normalizeDelegatePath`.
 * 3. **A symlink is refused, not followed.** The host stats the path first and
 *    refuses a symlink outright (DEL-05); the Rust
 *    `fs_read_workspace_file` / `fs_write_workspace_file` commands canonicalize
 *    root and target independently and refuse an escape on disk, so an
 *    unrefused symlink still cannot leave the worktree.
 * 4. **A write is refused outside the subtask's allowed paths**, even when the
 *    workflow already checked: the scope in the tool context is the authority,
 *    and only a person's approval widens it (DEL-07).
 *
 * Everything here is pure; the I/O lives in `workspace-patch.ts` (the
 * WorkspacePort) and in `tool-runtime.ts` (the receipts). Keeping the rules in
 * one pure module is what lets the same decision be asserted by a test and
 * applied by three call sites.
 */

import {
  DELEGATE_PATCH_LIMITS,
  DELEGATE_TOOL_NAMES,
  DELEGATE_WORK_POLICY,
  DELEGATE_WORK_TOOLS,
  DelegateToolArgs,
  normalizeDelegatePath,
  pathInScope,
  type DelegatePathRefusal,
  type ToolClass,
  type ToolDescriptor,
} from "@cognia/router-fusion"

import { isSensitiveResourcePath } from "@/lib/task-workspace/run-changes"

export {
  DELEGATE_PATCH_LIMITS,
  DELEGATE_TOOL_NAMES,
  DELEGATE_WORK_POLICY,
  DELEGATE_WORK_TOOLS,
  DelegateToolArgs,
}

/** Bytes of one file a worker is shown; the whole file is the evidence artifact. */
export const DELEGATE_READ_MAX_BYTES = 64_000
/** Files one listing returns before it reports itself truncated. */
export const DELEGATE_LIST_LIMIT = 200

/**
 * Host surfaces a workspace-relative path must never name, even when a
 * directory of that name really exists in the repository. The cost of refusing
 * a repository that keeps sources under `proc/` is a refusal message; the cost
 * of allowing one is that `proc/self/environ` or `var/run/docker.sock` reads
 * as an ordinary workspace file the moment a symlink or a bind mount puts it
 * there.
 */
const HOST_SURFACE_PREFIXES: readonly string[] = ["proc", "sys", "dev", "var/run", "run/docker"]

/** Home dotfiles that carry tokens. The credential DIRECTORIES are the package's. */
const CREDENTIAL_FILES: ReadonlySet<string> = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".gitconfig",
  ".dockercfg",
  ".docker.json",
  ".bash_history",
  ".zsh_history",
])

/**
 * Why the host refuses a path. The package's codes plus this device's own:
 * `PATH_HOST_SURFACE` for a host device or socket, `PATH_SYMLINK` for a link
 * the host will not follow.
 */
export type DelegateHostPathRefusal = DelegatePathRefusal | "PATH_HOST_SURFACE" | "PATH_SYMLINK"

export type DelegateHostPath =
  { ok: true; path: string } | { ok: false; code: DelegateHostPathRefusal }

/**
 * The one canonical spelling of a workspace-relative path the host will act
 * on, or the reason it will not. Stateless: a symlink is caught by
 * {@link delegateSymlinkRefusal} once the path has been stat'ed.
 */
export function normalizeDelegateHostPath(raw: string): DelegateHostPath {
  const normalized = normalizeDelegatePath(raw)
  if (!normalized.ok) return normalized
  const path = normalized.path
  const lower = path.toLowerCase()
  if (
    HOST_SURFACE_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`)) ||
    lower.split("/").some((segment) => segment.endsWith(".sock"))
  ) {
    return { ok: false, code: "PATH_HOST_SURFACE" }
  }
  if (path.split("/").some((segment) => CREDENTIAL_FILES.has(segment.toLowerCase()))) {
    return { ok: false, code: "PATH_SENSITIVE" }
  }
  if (isSensitiveResourcePath(path)) return { ok: false, code: "PATH_SENSITIVE" }
  return { ok: true, path }
}

/** A prefix a listing may start from: a normalized path, or "" for the root. */
export function normalizeDelegateListPrefix(raw: string): DelegateHostPath {
  return raw.trim().length === 0 ? { ok: true, path: "" } : normalizeDelegateHostPath(raw)
}

/**
 * `PATH_SYMLINK` when the host's stat says this path is a link. A link inside
 * the worktree is refused rather than followed: whether it points out of the
 * root is the filesystem's answer, not a name's, and a read that follows one
 * is exactly the DEL-05 escape.
 */
export function delegateSymlinkRefusal(stat: {
  exists: boolean
  isSymlink?: boolean
}): "PATH_SYMLINK" | null {
  return stat.exists && stat.isSymlink === true ? "PATH_SYMLINK" : null
}

/**
 * Whether a normalized path may be WRITTEN under this scope. The scope is the
 * subtask's `allowed_paths` plus the expansions a person approved; nothing
 * else widens it (DEL-07).
 */
export function delegateWriteAllowed(path: string, scope: readonly string[]): boolean {
  return pathInScope(path, scope)
}

/** The tool classes this policy will execute. Anything else is refused unrun. */
export const DELEGATE_ALLOWED_TOOL_CLASSES: ReadonlySet<ToolClass> = new Set<ToolClass>([
  "read_only",
  "sandbox_write",
])

/**
 * The descriptors the host offers for a policy id. `delegate-work-1` offers
 * the package's three tools and only when the host has a workspace to run them
 * against; every other policy offers nothing here (the panel policies stay in
 * `tool-runtime.ts`).
 */
export function delegateWorkTools(hasWorkspace: boolean): ToolDescriptor[] {
  return hasWorkspace ? [...DELEGATE_WORK_TOOLS] : []
}

/**
 * A patch proposal the host will not even record: too many files, one file too
 * large, or too many bytes in all. Checked against the projected patch, so the
 * limit is on the patch the worker is building, not on one call.
 */
export function delegatePatchLimitRefusal(projected: {
  files: number
  fileBytes: number
  totalBytes: number
}): "PATCH_TOO_LARGE" | null {
  return projected.files > DELEGATE_PATCH_LIMITS.maxFiles ||
    projected.fileBytes > DELEGATE_PATCH_LIMITS.maxFileBytes ||
    projected.totalBytes > DELEGATE_PATCH_LIMITS.maxTotalBytes
    ? "PATCH_TOO_LARGE"
    : null
}
