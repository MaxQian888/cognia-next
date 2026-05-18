/**
 * Git workspace abstraction for AI-driven Issue → PR loops.
 *
 * The runIssueLoop workflow node clones the target repo into a sandboxed
 * directory, hands it to the AI driver (Claude Code), then commits and pushes
 * the result. There are two backends:
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

import { invoke } from "@tauri-apps/api/core"

export type WorkspaceBackend = "local" | "e2b"

export interface WorkspaceHandle {
  backend: WorkspaceBackend
  /** Filesystem path (local) or sandbox id (e2b). */
  path: string
  /** Repo this workspace was cloned from. */
  repoFullName: string
  /** Branch checked out. */
  branch: string
  /** Wall clock ms when allocated. */
  createdAt: number
}

/**
 * Pluggable E2B backend. The github-delivery plugin's activate() may wire
 * a real implementation backed by the `e2b-sandbox` plugin when present.
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

let _e2bBackend: E2BBackend | null = null

export function setE2BBackend(b: E2BBackend | null): void {
  _e2bBackend = b
}

export function getE2BBackend(): E2BBackend | null {
  return _e2bBackend
}

export interface CloneOptions {
  repoFullName: string
  /** Branch to check out. */
  branch: string
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
  if (opts.backend === "e2b") {
    if (!_e2bBackend) {
      throw new Error(
        "e2b workspace backend not registered. Install the e2b-sandbox plugin and enable it."
      )
    }
    return _e2bBackend.clone({
      repoFullName: opts.repoFullName,
      branch: opts.branch,
      token: opts.token,
    })
  }

  const result = await invoke<{ path: string; createdAt: number }>("github_workspace_clone", {
    args: {
      repoFullName: opts.repoFullName,
      branch: opts.branch,
      token: opts.token,
      baseDir: opts.baseDir,
    },
  })

  return {
    backend: "local",
    path: result.path,
    repoFullName: opts.repoFullName,
    branch: opts.branch,
    createdAt: result.createdAt,
  }
}

export interface CommitAndPushOptions {
  workspace: WorkspaceHandle
  message: string
  /** Branch to push to. Defaults to workspace.branch. */
  remoteBranch?: string
}

/**
 * Stage all changes, commit, and push to the workspace's branch (or override).
 * Returns the commit SHA.
 */
export async function commitAndPush(opts: CommitAndPushOptions): Promise<string> {
  if (opts.workspace.backend === "e2b") {
    if (!_e2bBackend) {
      throw new Error(
        "e2b workspace backend not registered. Install the e2b-sandbox plugin and enable it."
      )
    }
    return _e2bBackend.commitAndPush({
      workspace: opts.workspace,
      message: opts.message,
      remoteBranch: opts.remoteBranch,
    })
  }

  return invoke<string>("github_workspace_commit_and_push", {
    args: {
      workspacePath: opts.workspace.path,
      branch: opts.workspace.branch,
      message: opts.message,
      remoteBranch: opts.remoteBranch,
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
  if (handle.backend === "e2b") {
    if (!_e2bBackend) return false
    try {
      return await _e2bBackend.remove(handle)
    } catch (err) {
      console.error(`e2b removeWorkspace failed for ${handle.path}`, err)
      return false
    }
  }
  try {
    return await invoke<boolean>("github_workspace_remove", { path: handle.path })
  } catch (err) {
    console.error(`removeWorkspace failed for ${handle.path}`, err)
    return false
  }
}

/**
 * Inspect a local workspace; returns `{ exists: false }` if the directory no
 * longer exists. Used by the audit UI to show worktree status.
 */
export async function statWorkspace(path: string): Promise<{ exists: boolean; mtime?: number }> {
  try {
    return await invoke<{ exists: boolean; mtime?: number }>("github_workspace_stat", { path })
  } catch {
    return { exists: false }
  }
}
