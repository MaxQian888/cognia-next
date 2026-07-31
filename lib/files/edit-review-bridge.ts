// Bridge: route an agent Edit/Write target file into the project-file Context
// Workbench and reveal its git-review (disk-vs-HEAD) surface. An agent edit is
// already on disk, so the correct review surface is the working-tree diff — not
// a not-yet-applied proposal. Reuses the dock's workspace reveal + the
// project-file review-request signal; no new diff UI.

import { getSession } from "@/lib/db/sessions"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { resolveSessionProjectRoot } from "@/lib/workspace/roots"
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

const trimTrailing = (path: string) => path.replace(/[\\/]+$/, "")

/**
 * Reveal the given absolute file (an agent Edit/Write target) in the chat
 * workspace dock and activate its git-review panel. Returns false — without any
 * side effect — when there is no fs backend, no session, no project root, or the
 * path is outside the session's root.
 */
export async function openEditInWorkbenchReview({
  sessionId,
  absolutePath,
}: OpenEditReviewArgs): Promise<boolean> {
  if (!hasWorkspaceFsBackend()) return false
  const session = await getSession(sessionId)
  if (!session) return false
  const { root } = resolveSessionProjectRoot(session, useProjectStore.getState().projects)
  if (!root) return false

  const base = trimTrailing(root.path)
  if (absolutePath !== base && !absolutePath.startsWith(`${base}/`)) return false
  const relPath = absolutePath === base ? "" : absolutePath.slice(base.length + 1)
  if (!relPath) return false

  // Open the dock's existing source-control review surface and preselect the
  // touched working-tree file. This path does not depend on the project Context
  // Workbench being mounted inside the already-narrow chat dock.
  useArtifactDockLayoutStore.getState().revealWorkspaceReview({
    sessionId,
    rootPath: root.path,
    relPath,
  })
  return true
}
