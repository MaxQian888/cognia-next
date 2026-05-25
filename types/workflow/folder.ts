/**
 * Workflow library folders — the organizational layer over the flat
 * `workflows` table (ADR-0011 library upgrade). Folders are a pure frontend /
 * Dexie concern: the Rust cron daemon and run-mirror never read them.
 *
 * Root is a sentinel string, never `null`/`undefined`. IndexedDB key ranges
 * cannot match null keys, so a workflow at the library root carries
 * `folderId === ROOT_FOLDER_ID` and a top-level folder carries
 * `parentFolderId === ROOT_FOLDER_ID`. This keeps every read on an index —
 * root and nested lookups are the identical `where(...).equals(folderId)`.
 */

/** Sentinel id for the library root. Never used as a real folder row id. */
export const ROOT_FOLDER_ID = "root" as const

export interface WorkflowFolder {
  /** Stable surrogate id; "wff_" prefix to never collide with "wf_" workflows. */
  id: string
  name: string
  /** Parent folder; `ROOT_FOLDER_ID` for a top-level folder. */
  parentFolderId: string
  createdAt: number
  updatedAt: number
  /** Optional accent color token (UI-only, not indexed). */
  color?: string
  /** Optional emoji or lucide icon name (UI-only, not indexed). */
  icon?: string
}

/** Patch shape for `updateFolder` — id/createdAt are immutable. */
export type WorkflowFolderPatch = Partial<Omit<WorkflowFolder, "id" | "createdAt">>
