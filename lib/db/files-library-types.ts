/**
 * Row shapes for the cross-session Files page (Dexie v231, ADR-0200).
 *
 * Files is an aggregated view over content that already lives elsewhere —
 * artifacts, canvas documents, chat images, uploaded session assets. These two
 * tables hold only what the view adds on top: favorites, folder membership,
 * "last opened from Files", "removed from Files", and the ownership of files
 * uploaded straight into Files.
 *
 * Retention rides on the media reference ledger (`messageMediaRefs`): a kept
 * item whose bytes live in `messageMedia` holds one ref row under the reserved
 * `library:` owner with the sentinel session id `LIBRARY_REF_SESSION_ID`.
 * Session deletion and media GC only count ref rows, so that row keeps the
 * bytes alive after the source conversation is gone.
 */

/** Sentinel id for the root of the Folders tab. Never a real folder row id. */
export const ROOT_LIBRARY_FOLDER_ID = "root" as const

/**
 * - `artifact` / `canvas` — rows in `artifacts` / `canvasDocuments`.
 * - `image` — a canonical `messageMedia` image (one card per content hash).
 * - `session-upload` — a non-image original uploaded into one or more conversations.
 * - `upload` — a non-image original uploaded straight into Files (Files-owned).
 */
export type LibraryItemKind = "artifact" | "canvas" | "image" | "session-upload" | "upload"

export const LIBRARY_ITEM_KINDS: readonly LibraryItemKind[] = [
  "artifact",
  "canvas",
  "image",
  "session-upload",
  "upload",
]

/** Display metadata copied at keep/upload time so an item outlives its source row. */
export interface LibraryItemSnapshot {
  title: string
  mediaType?: string
  byteSize?: number
  /** sha-256 of the original bytes (uploads). */
  contentHash?: string
  /** Extracted text of an upload, so a kept file stays searchable by body. */
  extractedText?: string
}

export interface LibraryItemRow {
  /** `${kind}:${sourceId}` — see `libraryItemKey`. */
  key: string
  kind: LibraryItemKind
  /**
   * artifact id | canvas id | canonical image hash |
   * original content hash for a conversation upload (one card per file, however
   * many conversations it was attached to) | asset id for a Files upload.
   */
  sourceId: string
  /** Conversation the item came from; the session purge reads it to find kept items. */
  originSessionId?: string
  /** Workspace at keep/upload time; used for the project filter once the session is gone. */
  projectId?: string
  /** Favorite marker. A timestamp, not a boolean: IndexedDB cannot index booleans. */
  favoritedAt?: number
  /** `ROOT_LIBRARY_FOLDER_ID` or a folder id; absent = not in the Folders tab. */
  folderId?: string
  /** Uploaded straight into Files. Deleting it deletes the bytes. */
  ownedByFiles?: true
  /** `messageMedia` key the keep ref pins (canonical hash or `original:<sha>`). */
  mediaHash?: string
  snapshot?: LibraryItemSnapshot
  /** When the item last became kept. */
  keptAt?: number
  /** Opened / previewed / used from Files — drives the Recent tab for media. */
  lastOpenedAt?: number
  /** "Remove from Files"; the item reappears once its source changes after this. */
  hiddenAt?: number
  createdAt: number
  updatedAt: number
}

export interface LibraryFolder {
  /** "lbf_" prefix. */
  id: string
  name: string
  /** `ROOT_LIBRARY_FOLDER_ID` for a top-level folder. */
  parentFolderId: string
  createdAt: number
  updatedAt: number
  color?: string
  icon?: string
}

export type LibraryFolderPatch = Partial<Omit<LibraryFolder, "id" | "createdAt">>

export function libraryItemKey(kind: LibraryItemKind, sourceId: string): string {
  return `${kind}:${sourceId}`
}

/** A kept item survives deletion of its source conversation. */
export function isLibraryItemKept(
  row: Pick<LibraryItemRow, "favoritedAt" | "folderId" | "ownedByFiles">
): boolean {
  return row.favoritedAt !== undefined || row.folderId !== undefined || row.ownedByFiles === true
}
