// Bridge: route an agent Edit/Write target file into the project-file Context
// Workbench and reveal its git-review (disk-vs-HEAD) surface. An agent edit is
// already on disk, so the correct review surface is the working-tree diff — not
// a not-yet-applied proposal. Reuses the dock's workspace reveal + the
// project-file review-request signal; no new diff UI.

import { getSession } from "@/lib/db/sessions"
import { isPathWithinRoot, normalizeFsPath } from "@/lib/files/permissions"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { resolveLinkPath } from "@/lib/terminal/terminal-links"
import { resolveSessionExecutionRoot } from "@/lib/workspace/session-root"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useProjectStore } from "@/stores/project/project-store"

/**
 * Whether the workbench review action can be offered at all. Gated on a
 * filesystem backend (Tauri or a paired companion) — in pure web mode there is
 * no working tree to diff against, so the action must not be shown.
 */
export function canOfferWorkbenchReview(): boolean {
  return hasWorkspaceFsBackend()
}

export interface OpenEditReviewArgs {
  sessionId: string
  absolutePath: string
}

/**
 * Locate `path` inside the conversation's own execution root.
 *
 * The execution root, not the workspace's primary root: the containment check
 * compares an agent's path against it, so resolving the source repository for a
 * worktree-bound conversation made every agent path fail it, and every caller
 * here fails silently, so the action simply did nothing.
 *
 * `path` may be relative. Built-in `Read` accepts a relative `file_path`, and
 * `Glob`/`Grep` report paths relative to the session's working directory, so
 * refusing a relative path left the majority of tool-card paths inert. The
 * execution root IS what those paths are relative to, and it is already
 * resolved here, so the join is the resolver's answer rather than a guess —
 * `resolveLinkPath` is the same one the terminal's path links use.
 *
 * Returns null whenever the file cannot be addressed inside this conversation:
 * no session on record, no root, or a path that lands outside it — including a
 * relative one that climbs out with `..`, which normalizes before the same
 * containment test. Refusing an outside path is the point rather than an edge
 * case, because the dock's workspace surface is rooted at the conversation and
 * would otherwise be asked to show a file it has no tree for.
 */
async function locateInSessionRoot(
  sessionId: string,
  path: string
): Promise<{ root: string; relPath: string } | null> {
  const session = await getSession(sessionId)
  if (!session) return null
  const { root } = resolveSessionExecutionRoot(session, useProjectStore.getState().projects)
  if (!root) return null

  const absolutePath = resolveLinkPath(root, path)
  if (!isPathWithinRoot(absolutePath, root)) return null
  // Slice the *normalized* pair, never the raw strings: an agent reports
  // `C:\repo\a.ts` while a root may be recorded as `C:/repo/`, and hand-rolled
  // separator matching here disagreed with the shared containment test in
  // exactly the way its own doc warns a third copy would.
  const base = normalizeFsPath(root)
  const target = normalizeFsPath(absolutePath)
  const relPath = target.slice(base.endsWith("/") ? base.length : base.length + 1)
  return relPath ? { root, relPath } : null
}

/**
 * Reveal the given absolute file (an agent Edit/Write target) in the chat
 * workspace dock and activate its git-review panel. Returns false, without any
 * side effect, when there is no fs backend, no session, no project root, or the
 * path is outside the session's root.
 */
export async function openEditInWorkbenchReview({
  sessionId,
  absolutePath,
}: OpenEditReviewArgs): Promise<boolean> {
  if (!hasWorkspaceFsBackend()) return false
  const located = await locateInSessionRoot(sessionId, absolutePath)
  if (!located) return false

  // Open the dock's existing source-control review surface and preselect the
  // touched working-tree file. This path does not depend on the project Context
  // Workbench being mounted inside the already-narrow chat dock.
  useArtifactDockLayoutStore.getState().revealWorkspaceReview({
    sessionId,
    rootPath: located.root,
    relPath: located.relPath,
  })
  return true
}

export interface OpenWorkbenchFileArgs {
  sessionId: string
  /**
   * The path as the tool reported it — absolute, or relative to the session's
   * working directory, which `Read`, `Glob` and `Grep` all routinely emit.
   */
  path: string
  /** 1-based caret to reveal, when the tool call named one. */
  line?: number
  column?: number
}

/**
 * The read-side twin of {@link openEditInWorkbenchReview}: show the file a tool
 * call named, in the dock's workspace editor, rather than a diff of it.
 *
 * Read, Grep, Glob and LS report paths — absolute or session-relative — that
 * the user then has to go find by hand,
 * even though the right rail is already rooted at the same tree and the reveal
 * channel this uses was built for the terminal's path links. A diff is the
 * wrong surface for them: nothing changed, so `revealWorkspaceReview` would
 * open an empty comparison.
 *
 * Returns false, with no side effect, under exactly the conditions the review
 * twin refuses under, so a caller can offer one control for both.
 */
export async function openFileInWorkbenchWorkspace({
  sessionId,
  path,
  line,
  column,
}: OpenWorkbenchFileArgs): Promise<boolean> {
  if (!hasWorkspaceFsBackend()) return false
  const located = await locateInSessionRoot(sessionId, path)
  if (!located) return false

  useArtifactDockLayoutStore.getState().revealWorkspaceFile({
    sessionId,
    rootPath: located.root,
    relPath: located.relPath,
    line,
    column,
  })
  return true
}
