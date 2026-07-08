// Cross-surface bridge so terminal path-links can open in the live project
// editor (editable + LSP) instead of the read-only file viewer. The Agent Team
// project editor registers an opener keyed by its root; the terminal asks this
// bridge to open a clicked absolute path and only falls back to the read-only
// `file-viewer-dialog` when no editor is rooted at that path.

export interface ProjectEditorOpener {
  /** Absolute root the editor is mounted at. */
  root: string
  /** Open a file (path relative to `root`), optionally revealing line/column. */
  open: (relPath: string, line?: number, column?: number) => void
}

const openers = new Set<ProjectEditorOpener>()

/** Register a live project-editor opener. Returns an unregister disposer. */
export function registerProjectEditorOpener(opener: ProjectEditorOpener): () => void {
  openers.add(opener)
  return () => {
    openers.delete(opener)
  }
}

const trimTrailing = (p: string) => p.replace(/[\\/]+$/, "")

/**
 * Route an absolute path to the project editor rooted at (or above) it. Returns
 * true when an editor handled it, false when the caller should fall back to the
 * read-only viewer. Picks the deepest matching root for nested worktrees.
 */
export function openInProjectEditor(absolutePath: string, line?: number, column?: number): boolean {
  let best: ProjectEditorOpener | null = null
  let bestBase = ""
  for (const o of openers) {
    const base = trimTrailing(o.root)
    if (absolutePath === base || absolutePath.startsWith(`${base}/`)) {
      if (!best || base.length > bestBase.length) {
        best = o
        bestBase = base
      }
    }
  }
  if (!best) return false
  const rel = absolutePath === bestBase ? "" : absolutePath.slice(bestBase.length + 1)
  if (!rel) return false
  best.open(rel, line, column)
  return true
}

/** Test-only: drop every registered opener. */
export function __resetProjectEditorBridgeForTesting(): void {
  openers.clear()
}
