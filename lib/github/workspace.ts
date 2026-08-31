/**
 * Git workspace abstraction for plugin-driven repository automation.
 *
 * A Marketplace plugin can clone a target repository into a sandboxed
 * directory, hand it to an AI driver, then commit and push the result.
 * There are two backends:
 *
 *   - `local`: Tauri Rust commands shell out to system `git` under the
 *     `<baseDir>/<repo>/<timestamp>` worktree, then `tokio::fs` cleans up.
 *   - `e2b`:   delegate to the e2b-sandbox plugin for cloud execution.
 *
 * Previously the `local` backend imported `simple-git` and `node:fs/promises`
 * directly, which dragged Node built-ins into the Next.js client bundle via
 * the plugin registry's static imports. The implementation now invokes Rust
 * commands (`github_workspace_*`), so the TS surface here is pure ESM — that
 * is what lets `next.config.ts` drop the `NODE_ONLY_MODULES` aliases.
 */

import { transport } from "@/lib/tauri"

export type WorkspaceBackend = "local" | "e2b"

export interface WorkspaceHandle {
  backend: WorkspaceBackend
  /** Filesystem path (local) or sandbox id (e2b). */
  path: string
  /** Repo this workspace was cloned from. */
  repoFullName: string
  /** Branch checked out. */
  branch: string
  /** Trusted source branch used to create the isolated target branch. */
  baseBranch?: string
  /** Wall clock ms when allocated. */
  createdAt: number
}

/**
 * Pluggable E2B backend. A repository Integration plugin may wire a real
 * implementation backed by the `e2b-sandbox` plugin when present.
 * Tests inject fakes.
 */
export interface E2BBackend {
  clone(opts: { repoFullName: string; branch: string; token: string }): Promise<WorkspaceHandle>
  commitAndPush(opts: {
    workspace: WorkspaceHandle
    message: string
    remoteBranch?: string
  }): Promise<string>
  remove(handle: WorkspaceHandle): Promise<boolean>
}

// The e2b backend is contributed by `plugins/e2b-sandbox` through
// `ctx.workspace.registerBackend({ id: "e2b" })` (ADR-0026 §2 §D), which
// namespaces it as `cognia-e2b-sandbox:e2b` in the shared registry. The host
// dispatches by kind, so it never needs the plugin id.
import { resolveWorkspaceBackendByKind } from "./workspace-backend-registry"

const E2B_BACKEND_KIND: WorkspaceBackend = "e2b"
// An issued workspace handle keeps its provider ownership even after the
// plugin unregisters to drain. New clones resolve only the accepting registry;
// commit/remove for existing handles use this cleanup-only ownership ledger.
const e2bBackendByWorkspacePath = new Map<string, E2BBackend>()

const E2B_NOT_REGISTERED_MESSAGE =
  "e2b workspace backend not registered. Install the e2b-sandbox plugin and enable it."

export interface CloneOptions {
  repoFullName: string
  /** Isolated target branch to check out. */
  branch: string
  /** Existing branch to clone before creating `branch`. Defaults to `branch`. */
  baseBranch?: string
  /** Auth token used for `git clone` (PAT or installation token). */
  token: string
  /** Backend selector. */
  backend: WorkspaceBackend
  /** Override the base directory for the local backend (test injection). */
  baseDir?: string
}

/**
 * Allocate a workspace and clone the repo into it.
 *
 * For `local` backend, returns a `WorkspaceHandle` whose path is a fresh
 * directory under `<baseDir>/<repo>/<timestamp>`. For `e2b`, delegates to
 * the registered backend or throws if none is wired up yet.
 */
export async function cloneToWorkspace(opts: CloneOptions): Promise<WorkspaceHandle> {
  if (opts.backend === E2B_BACKEND_KIND) {
    const backend = resolveWorkspaceBackendByKind(E2B_BACKEND_KIND)
    if (!backend) throw new Error(E2B_NOT_REGISTERED_MESSAGE)
    const handle = await backend.clone({
      repoFullName: opts.repoFullName,
      branch: opts.branch,
      token: opts.token,
    })
    e2bBackendByWorkspacePath.set(handle.path, backend)
    return handle
  }

  const result = await transport.call<{ path: string; createdAt: number }>(
    "github_workspace_clone",
    {
      args: {
        repoFullName: opts.repoFullName,
        branch: opts.branch,
        ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
        token: opts.token,
        baseDir: opts.baseDir,
      },
    }
  )

  return {
    backend: "local",
    path: result.path,
    repoFullName: opts.repoFullName,
    branch: opts.branch,
    baseBranch: opts.baseBranch,
    createdAt: result.createdAt,
  }
}

export interface CommitAndPushOptions {
  workspace: WorkspaceHandle
  message: string
  /** Branch to push to. Defaults to workspace.branch. */
  remoteBranch?: string
  /**
   * PAT / installation token used for this push.
   *
   * Required for a workspace produced by `cloneToWorkspace`: the clone stores a
   * credential-FREE remote URL so a token can't be read out of
   * `<workspace>/.git/config` by whatever runs inside the clone. The credential
   * is supplied per-invocation instead.
   */
  token?: string
}

/**
 * Stage all changes, commit, and push to the workspace's branch (or override).
 * Returns the commit SHA.
 */
export async function commitAndPush(opts: CommitAndPushOptions): Promise<string> {
  if (opts.workspace.backend === E2B_BACKEND_KIND) {
    const backend =
      e2bBackendByWorkspacePath.get(opts.workspace.path) ??
      resolveWorkspaceBackendByKind(E2B_BACKEND_KIND)
    if (!backend) throw new Error(E2B_NOT_REGISTERED_MESSAGE)
    return backend.commitAndPush({
      workspace: opts.workspace,
      message: opts.message,
      remoteBranch: opts.remoteBranch,
    })
  }

  return transport.call<string>("github_workspace_commit_and_push", {
    args: {
      workspacePath: opts.workspace.path,
      repoFullName: opts.workspace.repoFullName,
      branch: opts.workspace.branch,
      baseBranch: opts.workspace.baseBranch,
      message: opts.message,
      remoteBranch: opts.remoteBranch,
      token: opts.token,
    },
  })
}

/**
 * Remove a local workspace directory. Used by the worktree GC task.
 *
 * Logs to console and returns false (never throws) so a single bad workspace
 * doesn't abort the GC pass.
 */
export async function removeWorkspace(handle: WorkspaceHandle): Promise<boolean> {
  if (handle.backend === E2B_BACKEND_KIND) {
    const backend =
      e2bBackendByWorkspacePath.get(handle.path) ?? resolveWorkspaceBackendByKind(E2B_BACKEND_KIND)
    if (!backend) return false
    try {
      const removed = await backend.remove(handle)
      if (removed) e2bBackendByWorkspacePath.delete(handle.path)
      return removed
    } catch (err) {
      console.error(`e2b removeWorkspace failed for ${handle.path}`, err)
      return false
    }
  }
  try {
    return await transport.call<boolean>("github_workspace_remove", { path: handle.path })
  } catch (err) {
    console.error(`removeWorkspace failed for ${handle.path}`, err)
    return false
  }
}

/** Test-only: clear handle-bound provider ownership between cases. */
export function __resetWorkspaceHandleBackendsForTesting(): void {
  e2bBackendByWorkspacePath.clear()
}

/**
 * Inspect a local workspace; returns `{ exists: false }` if the directory no
 * longer exists. Used by the audit UI to show worktree status.
 */
export async function statWorkspace(path: string): Promise<{ exists: boolean; mtime?: number }> {
  try {
    return await transport.call<{ exists: boolean; mtime?: number }>("github_workspace_stat", {
      path,
    })
  } catch {
    return { exists: false }
  }
}
