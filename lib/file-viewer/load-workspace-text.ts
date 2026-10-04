/**
 * Read one workspace file as text for a read-only viewer, from whichever Host
 * backs this client.
 *
 * Both reads go through `lib/files/workspace-fs` — `fs_stat_workspace_file`
 * then `fs_read_workspace_file` over `transport.call` — so the same code serves
 * the desktop (Tauri invoke) and a paired phone or browser (the companion V2
 * gateway), which has no local filesystem for the workspace at all. The Host
 * confines `relPath` to `root` on its side; nothing here widens that.
 *
 * Extracted from `FilePreviewSurface` so the mobile workspace preview and the
 * read-only dialog classify every failure the same way and share one bound.
 */

import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { readWorkspaceFile, statWorkspaceFile } from "@/lib/files/workspace-fs"
import { MAX_VIEWER_BYTES, exceedsUtf8Limit } from "@/lib/file-viewer/probe"
import type { FileViewerErrorCode } from "@/lib/file-viewer/types"

export type WorkspaceTextLoad =
  { ok: true; text: string } | { ok: false; code: FileViewerErrorCode }

/** Maps a rejected transport call onto the taxonomy the viewers render. */
export function classifyWorkspaceReadError(error: unknown): FileViewerErrorCode {
  const message = error instanceof Error ? error.message : String(error)
  // The Rust side canonicalises both the root and the target and rejects an
  // escape with this phrase; anything else is an ordinary IO failure.
  return message.includes("escapes workspace") ? "outside-workspace" : "read-failed"
}

/**
 * Stat, bound and read `root`/`relPath`. Never throws: every failure comes back
 * as a {@link FileViewerErrorCode} so a caller renders it instead of going blank.
 */
export async function loadWorkspaceText(
  root: string | null | undefined,
  relPath: string
): Promise<WorkspaceTextLoad> {
  if (!root) return { ok: false, code: "no-root" }
  if (!hasWorkspaceFsBackend()) return { ok: false, code: "no-backend" }
  try {
    const stat = await statWorkspaceFile(root, relPath)
    if (!stat.exists) return { ok: false, code: "not-found" }
    if (stat.isDir) return { ok: false, code: "is-directory" }
    // Refuse before reading, so an oversized file costs one stat rather than a
    // multi-megabyte transfer over the companion link.
    if (stat.size > MAX_VIEWER_BYTES) return { ok: false, code: "too-large" }
    // `MAX + 1`: the Rust side truncates only above the limit it is given and
    // appends a marker when it does, so asking for one byte more turns a file
    // that grew between the stat and the read into a detectable overflow
    // instead of a silently shortened document.
    const text = await readWorkspaceFile(root, relPath, MAX_VIEWER_BYTES + 1)
    if (exceedsUtf8Limit(text)) return { ok: false, code: "too-large" }
    return { ok: true, text }
  } catch (error) {
    return { ok: false, code: classifyWorkspaceReadError(error) }
  }
}
