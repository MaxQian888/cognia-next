"use client"

// Per-root git decorations for the project editor's file tree.
//
// Deliberately does NOT read `useGitStore`: that store is bound to a single
// `rootDir` owned by the global status-bar controller, and the project editor
// can be rooted at a different worktree at the same time. Instead this hook
// calls the `git_status` command for the editor's own root and refreshes off
// the backend's `git://status-changed` push (already debounced server-side)
// plus the tree's own refresh token, so saves/writes repaint badges promptly
// without a poller.
//
// `gitStatus` returns `EMPTY_STATUS` on an unpaired browser, so the whole
// feature degrades to "no badges" rather than erroring — a project that is
// not a repo is indistinguishable, which is the correct rendering anyway.

import { useCallback, useEffect, useMemo, useState } from "react"
import { gitRepoState, gitStatus } from "@/lib/git/commands"
import { subscribeGitStatusChanged } from "@/lib/git/events"
import { parseGitTarget } from "@/lib/git/target"
import { EMPTY_REPO_STATE, type GitFileStatus, type GitStatus } from "@/types/git"

export interface ProjectGitStatusDeps {
  gitStatus: typeof gitStatus
  gitRepoState: typeof gitRepoState
  subscribeGitStatusChanged: typeof subscribeGitStatusChanged
}

const defaultDeps: ProjectGitStatusDeps = {
  gitStatus,
  gitRepoState,
  subscribeGitStatusChanged,
}

/** What the tree needs: a status per editor-relative path, plus the branch. */
export interface ProjectGitDecorations {
  branch: string | null
  /** Map of editor-root-relative path → worst-case status for that file. */
  byPath: Map<string, GitFileStatus>
}

/**
 * Fold staged + unstaged + merge entries into one status per path. Merge
 * conflicts outrank everything; an unstaged edit outranks a staged one (the
 * file still has uncommitted work, which is what the badge is for).
 */
function flattenStatus(status: GitStatus | null): Map<string, GitFileStatus> {
  const byPath = new Map<string, GitFileStatus>()
  if (!status) return byPath
  for (const change of status.staged) {
    if (change.status !== "untracked") byPath.set(change.path, change.status)
  }
  for (const change of status.changes) {
    byPath.set(change.path, change.status)
  }
  for (const change of status.merge) {
    byPath.set(change.path, "conflicted")
  }
  return byPath
}

const normSlashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")

/**
 * Express the editor root against the repo root:
 * - `{ strip }` — the editor is nested inside the repo (`repo/packages/app`
 *   in `repo`): a git path `packages/app/x` maps to tree path `x`, and
 *   changes outside the nested root are dropped.
 * - `{ prepend }` — the repo is nested inside the editor: a git path `x`
 *   maps to tree path `sub/repo/x`.
 * - `{}` — the two roots coincide: paths pass through unchanged.
 * - `null` — unrelated roots (different drives or remote workspaces): drop
 *   every entry rather than badge paths that don't belong to this tree.
 */
function editorVsRepo(
  editorRoot: string,
  repoRoot: string
): { strip?: string; prepend?: string } | null {
  const editor = parseGitTarget(editorRoot)
  const repo = parseGitTarget(repoRoot)
  if (editor.kind === "local" && repo.kind === "local") {
    return pathRelation(normSlashes(repo.repoPath), normSlashes(editor.repoPath))
  }
  if (
    editor.kind === "remote" &&
    repo.kind === "remote" &&
    editor.workspaceId === repo.workspaceId
  ) {
    return pathRelation(normSlashes(repo.relativePath), normSlashes(editor.relativePath))
  }
  return null
}

function pathRelation(
  repoRoot: string,
  editorRoot: string
): { strip?: string; prepend?: string } | null {
  if (editorRoot === repoRoot) return {}
  // `""` is a valid endpoint (a remote target's workspace-relative path can
  // be empty): its child prefix is `""` itself, not `"/"`.
  const repo = repoRoot === "" ? "" : `${repoRoot}/`
  const editor = editorRoot === "" ? "" : `${editorRoot}/`
  if (editorRoot.startsWith(repo)) return { strip: editorRoot.slice(repo.length) }
  if (repoRoot.startsWith(editor)) return { prepend: repoRoot.slice(editor.length) }
  return null
}

/**
 * `git_status` reports paths relative to the *repository* root, but the tree
 * indexes rows by path relative to the *editor* root. Without the rebase a
 * nested project root misses badges on its own files and — worse — badges an
 * unrelated `src/a.ts` row when the repo's own `src/a.ts` changed.
 */
function rebaseToEditorRoot(
  byPath: Map<string, GitFileStatus>,
  editorRoot: string,
  repoRoot: string | null
): Map<string, GitFileStatus> {
  // No repo root discovered (non-repo, no bridge): keep the historical
  // pass-through — with no status there is nothing to misplace anyway.
  if (!repoRoot) return byPath
  const rel = editorVsRepo(editorRoot, repoRoot)
  if (rel === null) return new Map()
  if (!rel.strip && !rel.prepend) return byPath
  const next = new Map<string, GitFileStatus>()
  for (const [path, fileStatus] of byPath) {
    if (rel.strip) {
      if (!path.startsWith(`${rel.strip}/`)) continue
      next.set(path.slice(rel.strip.length + 1), fileStatus)
    } else if (rel.prepend) {
      next.set(`${rel.prepend}/${path}`, fileStatus)
    }
  }
  return next
}

export function useProjectGitStatus(
  rootPath: string,
  refreshToken: number | undefined,
  deps: Partial<ProjectGitStatusDeps> = {}
): ProjectGitDecorations {
  const d = { ...defaultDeps, ...deps }
  const [state, setState] = useState<{ status: GitStatus | null; repoRoot: string | null }>({
    status: null,
    repoRoot: null,
  })

  // `gitRepoState` rides along with every status fetch: its `rootDir` is the
  // *repository* root the status paths are relative to — the rebase in the
  // memo below needs it whenever the editor is rooted inside the repo.
  const load = useCallback(
    () =>
      Promise.all([
        d.gitStatus(rootPath),
        d.gitRepoState(rootPath).catch(() => EMPTY_REPO_STATE),
      ]).then(([status, repo]) => ({ status, repoRoot: repo.rootDir })),
    // `d.*` identity: callers pass stable dep objects; spreading a fresh
    // object each render is intentional so a custom dep still resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootPath, d.gitStatus, d.gitRepoState]
  )

  useEffect(() => {
    let cancelled = false
    load()
      .then((next) => {
        if (!cancelled) setState(next)
      })
      .catch(() => {
        // A non-repo root (or a host without git) is not an error state —
        // the tree simply renders undecorated.
        if (!cancelled) setState({ status: null, repoRoot: null })
      })
    return () => {
      cancelled = true
    }
  }, [rootPath, refreshToken, load])

  useEffect(() => {
    return d.subscribeGitStatusChanged((event) => {
      // The event's rootDir is the discovered repo root; a nested project
      // root still repaints because its decorations derive from the same
      // repo. Guard loosely: refresh when the event's root is the project
      // root, an ancestor of it, or the project root is an ancestor of the
      // event (worktree layouts nest both ways).
      const eventRoot = event.rootDir.replace(/\\/g, "/").replace(/\/+$/, "")
      const mine = rootPath.replace(/\\/g, "/").replace(/\/+$/, "")
      const related =
        eventRoot === mine || eventRoot.startsWith(`${mine}/`) || mine.startsWith(`${eventRoot}/`)
      if (!related) return
      load()
        .then(setState)
        .catch(() => setState({ status: null, repoRoot: null }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, load, d.subscribeGitStatusChanged])

  return useMemo(
    () => ({
      branch: state.status?.branch ?? null,
      byPath: rebaseToEditorRoot(flattenStatus(state.status), rootPath, state.repoRoot),
    }),
    [state, rootPath]
  )
}
