/**
 * Open a FileSpace path in the UI (ADR-0222 §2) — the one seam links, the
 * Files panel and tool cards share.
 *
 * - A file inside a disk mount opens in the dock's workspace editor rooted at
 *   that mount's directory (`revealWorkspaceFile`). The existing editor seam,
 *   `openFileInWorkbenchWorkspace`, only knows the execution root; this one
 *   knows every mount, so `/roots/<id>/…` lands in its own root. A directory
 *   (or the mount itself) roots the editor at the mount
 *   (`revealWorkspaceRoot`), whose tree is where the directory is browsed.
 * - An artifact opens in the artifact surface (`revealArtifactInWorkspace`).
 * - An upload, a Dexie mount, or the bare Files view brings the Files panel
 *   forward with the row focused — there is no editor for those.
 *
 * The conversation must already be the active one: every caller either sits
 * inside it (panel, tool card) or focused it synchronously first (the link
 * dispatchers). The check is repeated after every `await`, so a user who
 * switched conversations while a lookup was in flight is not yanked back to a
 * file of the one they left.
 */

import { revealArtifactInWorkspace, revealSessionPanel } from "@/lib/artifacts/reveal"
import { statWorkspaceFile } from "@/lib/files/workspace-fs"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat"
import {
  CONVERSATION_FILES_PANEL_ID,
  useFileSpacePanelStore,
} from "@/stores/filespace/filespace-panel-store"
import type { FileSpacePath, OpenFileSpacePathResult } from "@/types/filespace"

import { loadConversationFileSpace, type LoadedConversationFileSpace } from "./load"
import { locateFileSpacePath } from "./paths"
import { findDexieEntry } from "./sources"

export interface OpenFileSpacePathArgs {
  sessionId: string
  /** Absent: bring the Files panel forward. */
  path?: FileSpacePath
  line?: number
  column?: number
}

export interface OpenFileSpaceDeps {
  load: (sessionId: string) => Promise<LoadedConversationFileSpace>
  stat: typeof statWorkspaceFile
  activeSessionId: () => string | null
  revealFilesPanel: (sessionId: string, path?: FileSpacePath) => void
  revealFile: (request: {
    sessionId: string
    rootPath: string
    relPath: string
    line?: number
    column?: number
  }) => void
  revealRoot: (request: { sessionId: string; rootPath: string }) => void
  revealArtifact: (artifactId: string) => boolean
}

export const defaultOpenFileSpaceDeps: OpenFileSpaceDeps = {
  load: (sessionId) => loadConversationFileSpace(sessionId),
  stat: statWorkspaceFile,
  activeSessionId: () => useChatStore.getState().activeSessionId,
  revealFilesPanel: (sessionId, path) => {
    if (path) useFileSpacePanelStore.getState().requestFocus(sessionId, path)
    revealSessionPanel(sessionId, CONVERSATION_FILES_PANEL_ID, "narrow")
  },
  revealFile: (request) => useArtifactDockLayoutStore.getState().revealWorkspaceFile(request),
  revealRoot: (request) => useArtifactDockLayoutStore.getState().revealWorkspaceRoot(request),
  revealArtifact: (artifactId) => revealArtifactInWorkspace(artifactId) !== null,
}

export async function openFileSpacePath(
  args: OpenFileSpacePathArgs,
  deps: OpenFileSpaceDeps = defaultOpenFileSpaceDeps
): Promise<OpenFileSpacePathResult> {
  const { sessionId, path } = args
  const stillActive = () => deps.activeSessionId() === sessionId
  if (!stillActive()) return "session-changed"

  if (!path || path === "/") {
    deps.revealFilesPanel(sessionId)
    return "opened"
  }

  const { space, dexie } = await deps.load(sessionId)
  if (!stillActive()) return "session-changed"
  if (space.status === "deleted") return "not-found"

  const located = locateFileSpacePath(space, path)
  if (!located) return "outside"
  const { mount, relPath } = located

  if (mount.backing === "dexie") {
    if (relPath === "") {
      deps.revealFilesPanel(sessionId, path)
      return "opened"
    }
    const entry = findDexieEntry(mount.id === "uploads" ? dexie.uploads : dexie.artifacts, path)
    if (!entry) return "not-found"
    if (entry.mountId === "artifacts" && deps.revealArtifact(entry.sourceId)) return "opened"
    deps.revealFilesPanel(sessionId, entry.path)
    return "opened"
  }

  if (mount.status !== "available" || !mount.hostPath) {
    return mount.statusReason === "no-fs-backend" ? "no-backend" : "offline"
  }
  if (relPath === "") {
    deps.revealRoot({ sessionId, rootPath: mount.hostPath })
    return "opened"
  }

  let stat
  try {
    stat = await deps.stat(mount.hostPath, relPath)
  } catch {
    // The host refused the path (outside its registered roots) or is gone;
    // either way there is nothing to show at this address.
    return "not-found"
  }
  if (!stillActive()) return "session-changed"
  if (!stat.exists) return "not-found"
  if (stat.isDir) {
    deps.revealRoot({ sessionId, rootPath: mount.hostPath })
    return "opened"
  }
  deps.revealFile({
    sessionId,
    rootPath: mount.hostPath,
    relPath,
    ...(args.line ? { line: args.line } : {}),
    ...(args.column ? { column: args.column } : {}),
  })
  return "opened"
}
