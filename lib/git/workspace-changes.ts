/**
 * The working tree's changed files, one entry per final path: a file that is
 * staged and also changed again in the working tree is one file, not two.
 */

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
