"use client"

/**
 * The single way to open the read-only file viewer on an absolute path.
 *
 * Every caller used to reach the old store's `openFile(absolutePath, …)`
 * directly, which read whatever it was handed with no root and no bound. This
 * resolves the path against the workspace roots first and refuses — visibly —
 * when it falls outside all of them.
 *
 * Deliberately does NOT consult `openInProjectEditor`. Two of the five callers
 * (terminal links and chat file links) prefer a live editor and try it first;
 * the other three (stack traces, log details) never did. Folding that
 * preference in here would silently change what those three do, which is a
 * separate decision from confining the read.
 */
import { allRootPaths } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"
import { useFileViewerStore } from "@/stores/file-viewer/file-viewer-store"
import { resolveViewerTarget } from "./resolve-root"

/**
 * Monotonic rather than time- or random-based, so a test can assert on it and
 * two opens in the same millisecond still get different ids.
 */
let sequence = 0

export interface OpenFileViewerOptions {
  line?: number | null
  column?: number | null
  /**
   * Roots to try before the rest, so a caller that knows which workspace it is
   * in wins a tie against an equally deep root from another project.
   */
  preferredRoots?: readonly string[]
}

/**
 * Every workspace root the app currently has open.
 *
 * The union across *all* projects rather than just the active one, deliberately:
 * this is the same set `lib/files/allowed-roots-sync.ts` pushes into the Rust
 * allowed-roots registry, so the renderer's boundary and the backend's agree,
 * and a stack frame pointing into a sibling checkout the user also has open
 * still resolves.
 */
function workspaceRoots(preferred: readonly string[] = []): string[] {
  const projects = useProjectStore.getState().projects
  return [...new Set([...preferred, ...projects.flatMap((project) => allRootPaths(project))])]
}

/**
 * The roots of one project, for a caller that knows which workspace it is in.
 *
 * Only ever a tie-breaker: it is passed as `preferredRoots`, so it reorders the
 * candidate list rather than restricting it. A stack frame pointing into
 * another open checkout still resolves.
 */
export function projectRootsOf(projectId: string | null): string[] {
  if (!projectId) return []
  const project = useProjectStore.getState().projects.find((entry) => entry.id === projectId)
  return project ? allRootPaths(project) : []
}

function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? path
  )
}

/**
 * Resolve `absolutePath` against the open workspaces and show it, or say why
 * not.
 *
 * Never a silent no-op: a click that does nothing is indistinguishable from a
 * broken link, which is how this path behaved for chat links whenever the
 * terminal panel was closed.
 */
export function openFileViewer(absolutePath: string, options: OpenFileViewerOptions = {}): void {
  const store = useFileViewerStore.getState()
  const roots = workspaceRoots(options.preferredRoots)
  const target = resolveViewerTarget(absolutePath, roots)

  if (!target) {
    // No roots at all is a different situation from a path outside the ones we
    // have, and the two want different words.
    store.openFailure(roots.length === 0 ? "no-root" : "outside-workspace", basename(absolutePath))
    return
  }

  sequence += 1
  store.openRequest({
    requestId: `file-viewer:${sequence}`,
    source: "terminal",
    root: target.root,
    relPath: target.relPath,
    displayName: target.relPath,
    line: options.line ?? null,
    column: options.column ?? null,
  })
}

/** Test-only: makes the generated request ids predictable across cases. */
export function __resetFileViewerSequenceForTesting(): void {
  sequence = 0
}
