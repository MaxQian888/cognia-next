/**
 * Folder-as-reference helpers for the composer's folder picker.
 *
 * A folder is added to the chat-store's `referencedPaths` (the reference model),
 * NOT inlined: its absolute path flows into the agent's `additionalDirectories`
 * so files are read on demand (listing-first, the pattern Claude Code/Cursor
 * use). We reuse the existing gitignore-aware `searchWorkspace` walk to size the
 * folder and decide whether the user should confirm before adding a large tree.
 *
 * Desktop-only by nature: both `pickDirectory` and `searchWorkspace` require the
 * Tauri filesystem; on web/mobile there is no real path to reference.
 */

import { pickDirectory } from "@/lib/files/file-bridge"
import { searchWorkspace } from "@/lib/files/workspace-search"
import type { FileReference } from "@/stores/chat/chat-store"

/** Max entries we ask the workspace walk for (the Rust side caps lower still). */
export const FOLDER_LISTING_LIMIT = 200
/** At/above this file count we ask the user to confirm before adding. */
export const FOLDER_CONFIRM_FILE_THRESHOLD = 100

export interface FolderSummary {
  absolute: string
  relative: string
  /** Number of (non-directory) files seen in the gitignore-filtered walk. */
  fileCount: number
  /** True when the walk hit the listing cap — the folder is larger than shown. */
  truncated: boolean
  /** True when the folder is large enough to warrant a confirm dialog. */
  needsConfirm: boolean
}

/** Last path segment, tolerant of trailing slashes and either separator. */
export function folderBasename(path: string): string {
  const norm = path.replace(/[\\/]+$/, "")
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"))
  return idx >= 0 ? norm.slice(idx + 1) : norm
}

/** Open the native directory picker. Returns null on cancel / non-desktop. */
export async function pickFolder(): Promise<string | null> {
  return pickDirectory()
}

/** Walk `dir` (gitignore-aware) to count files and decide if a confirm is needed. */
export async function summarizeFolder(
  dir: string,
  limit = FOLDER_LISTING_LIMIT
): Promise<FolderSummary> {
  const entries = await searchWorkspace(dir, "", limit)
  const fileCount = entries.filter((e) => !e.isDir).length
  const truncated = entries.length >= limit
  return {
    absolute: dir,
    relative: folderBasename(dir),
    fileCount,
    truncated,
    needsConfirm: truncated || fileCount >= FOLDER_CONFIRM_FILE_THRESHOLD,
  }
}

/** Project a folder summary into a chat-store reference. */
export function folderReference(summary: FolderSummary): FileReference {
  return { absolute: summary.absolute, relative: summary.relative, isDir: true }
}
