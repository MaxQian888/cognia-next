import { gitDiscard, gitUnstage } from "./commands"
import { refreshGitStatus } from "./load"
import type { GitFileChange, GitStatus } from "@/types/git"

export interface WorkspaceChangedFile {
  path: string
  origPaths: string[]
  changes: GitFileChange[]
}

export function collectWorkspaceChanges(status: GitStatus): WorkspaceChangedFile[] {
  const byPath = new Map<string, WorkspaceChangedFile>()
  for (const change of [...status.merge, ...status.staged, ...status.changes]) {
    const current = byPath.get(change.path) ?? {
      path: change.path,
      origPaths: [],
      changes: [],
    }
    current.changes.push(change)
    if (change.origPath && !current.origPaths.includes(change.origPath)) {
      current.origPaths.push(change.origPath)
    }
    byPath.set(change.path, current)
  }
  return [...byPath.values()]
}

interface UndoWorkspaceChangesDeps {
  unstage: (repoPath: string, paths: string[]) => Promise<void>
  discard: (repoPath: string, paths: string[]) => Promise<void>
  refresh: (repoPath: string) => Promise<void>
}

const defaultUndoDeps: UndoWorkspaceChangesDeps = {
  unstage: (repoPath, paths) => gitUnstage(repoPath, paths),
  discard: (repoPath, paths) => gitDiscard(repoPath, paths),
  refresh: refreshGitStatus,
}

function appendUnique(target: string[], path: string | null): void {
  if (path && !target.includes(path)) target.push(path)
}

function collectDiscardTargets(files: WorkspaceChangedFile[]): {
  trackedPaths: string[]
  discardPaths: string[]
} {
  const trackedPaths: string[] = []
  const discardPaths: string[] = []
  for (const file of files) {
    for (const change of file.changes) {
      appendUnique(discardPaths, change.path)
      appendUnique(discardPaths, change.origPath)
      if (change.status !== "untracked") {
        appendUnique(trackedPaths, change.path)
        appendUnique(trackedPaths, change.origPath)
      }
    }
  }
  return { trackedPaths, discardPaths }
}

// Unstage then discard the collected paths. The refresh always runs, including
// when a destructive step fails, so every consumer sees the backend truth.
async function runDiscard(
  repoPath: string,
  trackedPaths: string[],
  discardPaths: string[],
  deps: UndoWorkspaceChangesDeps
): Promise<void> {
  let operationError: unknown
  try {
    if (trackedPaths.length > 0) await deps.unstage(repoPath, trackedPaths)
    if (discardPaths.length > 0) await deps.discard(repoPath, discardPaths)
  } catch (error) {
    operationError = error
  }

  try {
    await deps.refresh(repoPath)
  } catch (refreshError) {
    if (operationError === undefined) throw refreshError
  }

  if (operationError !== undefined) throw operationError
}

/**
 * Undo every staged, unstaged, conflicted, renamed, and untracked path in the
 * current repository snapshot.
 */
export async function undoWorkspaceChanges(
  repoPath: string,
  status: GitStatus,
  deps: UndoWorkspaceChangesDeps = defaultUndoDeps
): Promise<void> {
  const { trackedPaths, discardPaths } = collectDiscardTargets(collectWorkspaceChanges(status))
  await runDiscard(repoPath, trackedPaths, discardPaths, deps)
}

/**
 * Discard every staged/unstaged/untracked path of a SINGLE workspace file, so a
 * user can revert one agent edit without touching the rest of the working tree.
 */
export async function discardWorkspaceFile(
  repoPath: string,
  file: WorkspaceChangedFile,
  deps: UndoWorkspaceChangesDeps = defaultUndoDeps
): Promise<void> {
  const { trackedPaths, discardPaths } = collectDiscardTargets([file])
  await runDiscard(repoPath, trackedPaths, discardPaths, deps)
}
