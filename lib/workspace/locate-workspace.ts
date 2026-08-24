/**
 * Which workspace owns a directory.
 *
 * Several surfaces know a path and nothing else — a CLI invocation's `--cwd`, a
 * terminal tab, a worktree the registry already tracks, an editor's recent
 * folder. Without this they each guess "the active workspace", which is the
 * same class of mis-attribution as reading the UI pointer for a background
 * turn: correct exactly when the user has not moved.
 *
 * # Deepest root wins
 *
 * Nested checkouts are ordinary — a monorepo workspace on `~/src/app` and a
 * second workspace on `~/src/app/packages/sdk`. A path inside the inner one is
 * inside both, and the inner is the more specific answer, so matches are ranked
 * by root length rather than by list order. Ties (the same path mounted by two
 * workspaces) fall back to the caller's order, which is the store's order, so
 * the result is stable across calls rather than dependent on iteration luck.
 */

import { isDescendant, pathKey, stripTrailingSep } from "@/lib/claude/instructions/paths"
import type { Project, WorkspaceRoot } from "@/types"

export interface WorkspaceLocation<T> {
  project: T
  /** The specific mounted root the path was found under. */
  root: WorkspaceRoot
  /** True when the path IS the root rather than something inside it. */
  isRootItself: boolean
}

type Locatable = Pick<Project, "id" | "roots">

/**
 * The workspace whose mounted root contains `path`, or null.
 *
 * Returns the deepest match. A blank path matches nothing — "" would otherwise
 * read as a relative path and `isDescendant` would answer for the wrong reason.
 */
export function locateWorkspaceForPath<T extends Locatable>(
  path: string | null | undefined,
  projects: readonly T[]
): WorkspaceLocation<T> | null {
  const target = path?.trim()
  if (!target) return null

  let best: WorkspaceLocation<T> | null = null
  let bestDepth = -1
  for (const project of projects) {
    for (const root of project.roots ?? []) {
      const rootPath = root.path?.trim()
      if (!rootPath) continue
      if (!isDescendant(rootPath, target)) continue
      const depth = pathKey(rootPath).length
      // Strictly greater, so the first project to claim a given depth keeps it.
      if (depth > bestDepth) {
        bestDepth = depth
        best = {
          project,
          root,
          isRootItself: pathKey(rootPath) === pathKey(target),
        }
      }
    }
  }
  return best
}

/** Convenience for the common case: just the owning workspace's id. */
export function workspaceIdForPath<T extends Locatable>(
  path: string | null | undefined,
  projects: readonly T[]
): string | null {
  return locateWorkspaceForPath(path, projects)?.project.id ?? null
}

/**
 * Paths that no workspace claims — the candidates for adoption.
 *
 * De-duplicated on the same normalized key `locateWorkspaceForPath` compares
 * with, so `/repo` and `/repo/` are one candidate and not two, and the first
 * spelling the caller supplied is the one returned.
 */
export function unclaimedPaths<T extends Locatable>(
  paths: readonly (string | null | undefined)[],
  projects: readonly T[]
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of paths) {
    const path = raw?.trim()
    if (!path) continue
    const key = pathKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    if (locateWorkspaceForPath(path, projects)) continue
    out.push(stripTrailingSep(path))
  }
  return out
}
