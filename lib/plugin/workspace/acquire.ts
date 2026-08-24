/**
 * Turns a repository reference into a checkout a plugin can read.
 *
 * `ctx.workspace` was a registration-only API: a plugin could contribute a
 * backend and read back one it had registered itself, and there was no way for
 * anyone to *obtain* a checkout. The three mechanisms that could produce one —
 * `cloneToWorkspace` (github.com `owner/repo` only, host-internal), `git_clone`
 * (any URL, no guard rails, not on `ctx.git`) and the task-workspace worktree
 * manager (needs a local repo already) — returned three incompatible handles
 * and none was reachable from a plugin. This is the missing consumer side.
 *
 * Containment, deliberately narrower than "any path the process can read":
 *
 * - a **remote** is cloned into the plugin's own data directory, so it cannot
 *   collide with another plugin's checkout and uninstalling reclaims the disk;
 * - a **local path** must be inside a root the user has already opened. A
 *   plugin naming an arbitrary directory would be the filesystem escape that
 *   `ctx.fs` (jailed to the plugin's data dir) and `ctx.git` (locked to the
 *   Source Control root) both exist to prevent. To document another
 *   repository, the user opens it.
 */

import {
  readWorkspaceFile,
  walkWorkspace,
  type WorkspaceWalkOptions,
  type WorkspaceWalkResult,
} from "@/lib/files/workspace-fs"
import { gitCloneGuarded, gitDiffRefsFiles, gitReadBlobAtRef } from "@/lib/git/commands"
import { transport } from "@/lib/tauri"

import { parseRepoSpec, repoCacheSegments, type RepoSpec } from "./repo-spec"

/** How the caller named the repository. */
export type WorkspaceAcquireSpec =
  | { kind: "current-project" }
  | { kind: "local-path"; path: string }
  | { kind: "git-url"; url: string; ref?: string; allowedHosts?: string[] }
  /** Whatever the user typed — resolved by {@link parseRepoSpec}. */
  | { kind: "auto"; input: string; allowedHosts?: string[] }

export interface PluginWorkspaceHandle {
  /** Absolute filesystem root of the checkout. */
  root: string
  origin: "current-project" | "local-path" | "clone"
  /** Set when the checkout came from a remote. */
  remote?: { host: string; owner: string; repo: string; url: string; ref?: string }
  /** True when the checkout is ours to delete. */
  ephemeral: boolean
}

export class WorkspaceAcquireError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceAcquireError"
  }
}

export interface AcquireDeps {
  /**
   * Roots the user has opened; a local path must live inside one. May resolve
   * asynchronously so a caller can load the project store lazily.
   */
  openRoots: () => string[] | Promise<string[]>
  /** Absolute cache directory for one remote, under the plugin's data dir. */
  repoCacheDir: (segments: string[]) => Promise<string>
  /** Delete a cached checkout. Resolves `false` when it was already gone. */
  removeRepoCache: (segments: string[]) => Promise<boolean>
  clone: typeof gitCloneGuarded
}

function normalizeRootPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  return trimmed.length > 0 ? trimmed : path
}

/** Whether `candidate` is a root the user opened, or lives inside one. */
export function isInsideOpenRoot(candidate: string, roots: readonly string[]): boolean {
  const target = normalizeRootPath(candidate)
  return roots.some((raw) => {
    const root = normalizeRootPath(raw)
    if (!root) return false
    if (target === root) return true
    // Compare on a separator boundary so `/repo-two` is not inside `/repo`.
    return target.startsWith(`${root}/`) || target.startsWith(`${root}\\`)
  })
}

type ResolvedSpec =
  | { kind: "local"; path: string; origin: "current-project" | "local-path" }
  | { kind: "remote"; spec: Extract<RepoSpec, { kind: "remote" }>; allowedHosts?: string[] }

function resolveSpec(spec: WorkspaceAcquireSpec, roots: readonly string[]): ResolvedSpec {
  switch (spec.kind) {
    case "current-project": {
      const first = roots[0]
      if (!first) throw new WorkspaceAcquireError("no workspace is open")
      return { kind: "local", path: first, origin: "current-project" }
    }
    case "local-path":
      return { kind: "local", path: spec.path, origin: "local-path" }
    case "git-url": {
      const parsed = parseRepoSpec(spec.url)
      if (parsed.kind !== "remote") {
        throw new WorkspaceAcquireError(`"${spec.url}" is a path, not a remote`)
      }
      return {
        kind: "remote",
        spec: spec.ref ? { ...parsed, ref: spec.ref } : parsed,
        allowedHosts: spec.allowedHosts,
      }
    }
    case "auto": {
      const parsed = parseRepoSpec(spec.input)
      return parsed.kind === "local"
        ? { kind: "local", path: parsed.path, origin: "local-path" }
        : { kind: "remote", spec: parsed, allowedHosts: spec.allowedHosts }
    }
  }
}

/** Resolve a spec into a checkout, cloning when the repository is remote. */
export async function acquireWorkspace(
  spec: WorkspaceAcquireSpec,
  deps: AcquireDeps
): Promise<PluginWorkspaceHandle> {
  const roots = await deps.openRoots()
  const resolved = resolveSpec(spec, roots)

  if (resolved.kind === "local") {
    if (!isInsideOpenRoot(resolved.path, roots)) {
      throw new WorkspaceAcquireError(
        `"${resolved.path}" is not inside a workspace the user has opened. ` +
          "Open the folder first, or pass a git URL to clone it."
      )
    }
    return { root: resolved.path, origin: resolved.origin, ephemeral: false }
  }

  const destination = await deps.repoCacheDir(repoCacheSegments(resolved.spec))
  const root = await deps.clone(resolved.spec.url, destination, {
    ...(resolved.allowedHosts?.length ? { allowedHosts: resolved.allowedHosts } : {}),
  })
  if (!root) {
    throw new WorkspaceAcquireError("cloning is unavailable in this runtime (no git bridge)")
  }
  return {
    root,
    origin: "clone",
    remote: {
      host: resolved.spec.host,
      owner: resolved.spec.owner,
      repo: resolved.spec.repo,
      url: resolved.spec.url,
      ...(resolved.spec.ref ? { ref: resolved.spec.ref } : {}),
    },
    ephemeral: true,
  }
}

/**
 * Discard a handle, deleting the checkout when it was ours to make.
 *
 * A handle onto the user's own project is never deleted — releasing it just
 * drops the reference. Only a clone this plugin created is removed, and only
 * from its own cache.
 */
export async function releaseWorkspace(
  handle: PluginWorkspaceHandle,
  deps: Pick<AcquireDeps, "removeRepoCache">
): Promise<boolean> {
  if (!handle.ephemeral || !handle.remote) return false
  return deps.removeRepoCache([handle.remote.host, handle.remote.owner, handle.remote.repo])
}

/** Enumerate a handle's files, honouring `.gitignore`. */
export function walkHandle(
  handle: PluginWorkspaceHandle,
  options?: WorkspaceWalkOptions
): Promise<WorkspaceWalkResult> {
  return walkWorkspace(handle.root, options)
}

/** Read one file from a handle, optionally at a revision. */
export async function readHandleFile(
  handle: PluginWorkspaceHandle,
  relPath: string,
  options?: { maxBytes?: number; ref?: string }
): Promise<string | null> {
  if (options?.ref) {
    return gitReadBlobAtRef(handle.root, options.ref, relPath)
  }
  return readWorkspaceFile(handle.root, relPath, options?.maxBytes)
}

/** Paths that differ between `ref` and the handle's current revision. */
export async function changedSince(handle: PluginWorkspaceHandle, ref: string): Promise<string[]> {
  const changes = await gitDiffRefsFiles(handle.root, ref, "HEAD")
  return changes.map((change) => change.path)
}

/** Production dependencies for one plugin. */
export function defaultAcquireDeps(
  pluginId: string,
  openRoots: () => string[] | Promise<string[]>
): AcquireDeps {
  return {
    openRoots,
    repoCacheDir: (segments) =>
      transport.call<string>("plugin_workspace_repo_dir", { pluginId, segments }),
    removeRepoCache: (segments) =>
      transport.call<boolean>("plugin_workspace_repo_remove", { pluginId, segments }),
    clone: gitCloneGuarded,
  }
}
