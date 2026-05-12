/**
 * Git workspace abstraction for AI-driven Issue → PR loops.
 *
 * The runIssueLoop workflow node clones the target repo into a sandboxed
 * directory, hands it to the AI driver (Claude Code), then commits and pushes
 * the result. There are two backends:
 *
 *   - `local`: classic git worktree under <app_data>/cognia/github-worktrees/
 *   - `e2b`:   delegate to the e2b-sandbox plugin for cloud execution
 *
 * This module owns the `local` backend and exposes a thin interface that the
 * `e2b` backend can implement against the same shape.
 */

import { join } from "node:path"
import { mkdir, rm, stat } from "node:fs/promises"

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

export interface CloneOptions {
  repoFullName: string
  /** Branch to check out. */
  branch: string
  /** Auth token used for `git clone` (PAT or installation token). */
  token: string
  /** Backend selector. */
  backend: WorkspaceBackend
  /** Override the base directory for local backend (test injection). */
  baseDir?: string
  /** Override the simple-git factory (test injection). */
  gitFactory?: GitFactory
}

/**
 * Minimal subset of simple-git we depend on. Lets tests inject a fake.
 */
export interface GitClient {
  clone(remote: string, target: string, opts?: string[]): Promise<unknown>
  cwd(opts: { path: string; root?: boolean }): Promise<unknown>
  add(files: string | string[]): Promise<unknown>
  commit(msg: string): Promise<unknown>
  push(remote: string, branch: string, opts?: string[]): Promise<unknown>
  status(): Promise<{ files: Array<{ path: string }> }>
  log(opts?: Record<string, unknown>): Promise<{ all: ReadonlyArray<{ message: string; hash: string }> }>
}

export type GitFactory = () => GitClient

const DEFAULT_BASE_DIR = "cognia-github-worktrees"

/** Exported for tests to verify the lazy require path works. */
export function _defaultGitFactory(): GitClient {
  // Lazy-require keeps test mocks lightweight and allows running in
  // environments where simple-git isn't installed (e.g. unit tests).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const simpleGit = require("simple-git").simpleGit as () => GitClient
  return simpleGit()
}

/**
 * Allocate a workspace and clone the repo into it.
 *
 * For `local` backend, returns a `WorkspaceHandle` whose path is a fresh
 * directory under `<baseDir>/<repo>/<timestamp>`. For `e2b`, this is currently
 * a stub that throws — the e2b implementation lands in M5.
 */
export async function cloneToWorkspace(opts: CloneOptions): Promise<WorkspaceHandle> {
  if (opts.backend === "e2b") {
    throw new Error("e2b workspace backend is not yet implemented (planned for M5)")
  }
  const baseDir = opts.baseDir ?? DEFAULT_BASE_DIR
  const sanitizedRepo = opts.repoFullName.replace(/[^a-zA-Z0-9._-]/g, "_")
  const stamp = Date.now().toString(36)
  const path = join(baseDir, sanitizedRepo, stamp)

  await mkdir(path, { recursive: true })
  const git = (opts.gitFactory ?? _defaultGitFactory)()
  // Clone with auth in the URL — we never echo it back; suitable for short-
  // lived installation tokens. PAT users should use a fine-scoped token.
  const remote = `https://x-access-token:${opts.token}@github.com/${opts.repoFullName}.git`
  await git.clone(remote, path, ["--branch", opts.branch, "--depth", "20"])

  return {
    backend: "local",
    path,
    repoFullName: opts.repoFullName,
    branch: opts.branch,
    createdAt: Date.now(),
  }
}

export interface CommitAndPushOptions {
  workspace: WorkspaceHandle
  message: string
  /** Branch to push to. Defaults to workspace.branch. */
  remoteBranch?: string
  gitFactory?: GitFactory
}

/**
 * Stage all changes, commit, and push to the workspace's branch (or override).
 * Returns the commit SHA.
 */
export async function commitAndPush(opts: CommitAndPushOptions): Promise<string> {
  if (opts.workspace.backend === "e2b") {
    throw new Error("e2b commitAndPush is not yet implemented")
  }
  const git = (opts.gitFactory ?? _defaultGitFactory)()
  await git.cwd({ path: opts.workspace.path, root: false })
  const status = await git.status()
  if (status.files.length === 0) {
    throw new Error("commitAndPush: no changes to commit")
  }
  await git.add(".")
  await git.commit(opts.message)
  const branch = opts.remoteBranch ?? opts.workspace.branch
  await git.push("origin", branch, ["--set-upstream"])
  const log = await git.log({ maxCount: 1 })
  return log.all[0]?.hash ?? ""
}

/**
 * Remove a local workspace directory. Used by the worktree GC task.
 *
 * Logs to console and returns false (never throws) so a single bad workspace
 * doesn't abort the GC pass.
 */
export async function removeWorkspace(handle: WorkspaceHandle): Promise<boolean> {
  if (handle.backend !== "local") return false
  try {
    await rm(handle.path, { recursive: true, force: true })
    return true
  } catch (err) {
    console.error(`removeWorkspace failed for ${handle.path}`, err)
    return false
  }
}

/**
 * Inspect a local workspace; returns null if the directory no longer exists.
 * Used by the audit UI to show worktree status.
 */
export async function statWorkspace(
  path: string
): Promise<{ exists: boolean; mtime?: number }> {
  try {
    const s = await stat(path)
    return { exists: true, mtime: s.mtimeMs }
  } catch {
    return { exists: false }
  }
}
