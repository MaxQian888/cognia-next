import type {
  LibraryFolder,
  LibraryFolderColor,
  LibraryFolderIcon,
  LibraryItemKind,
  LibraryItemRow,
} from "@cognia/plugin-contract/lib/db/files-library-types"
export type {
  LibraryFolder,
  LibraryFolderColor,
  LibraryFolderIcon,
  LibraryItemGeneratedVideo,
  LibraryItemKind,
  LibraryItemRow,
  LibraryItemSnapshot,
  LibraryItemWorkspaceLocation,
} from "@cognia/plugin-contract/lib/db/files-library-types"

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

export const LIBRARY_ITEM_KINDS: readonly LibraryItemKind[] = [
  "artifact",
  "canvas",
  "image",
  "session-upload",
  "upload",
  "workspace-file",
]

/**
 * Tints a folder can carry (ADR-0223). Names, not CSS: the sidebar maps each
 * to theme tokens, so a folder colored on one theme still reads on another.
 */
export const LIBRARY_FOLDER_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const
/** Glyphs a folder can carry instead of the plain folder icon. */
export const LIBRARY_FOLDER_ICONS = [
  "folder",
  "star",
  "briefcase",
  "book",
  "code",
  "image",
  "music",
  "archive",
  "heart",
  "flag",
] as const
export function isLibraryFolderColor(value: unknown): value is LibraryFolderColor {
  return typeof value === "string" && (LIBRARY_FOLDER_COLORS as readonly string[]).includes(value)
}

export function isLibraryFolderIcon(value: unknown): value is LibraryFolderIcon {
  return typeof value === "string" && (LIBRARY_FOLDER_ICONS as readonly string[]).includes(value)
}

export type LibraryFolderPatch = Partial<Omit<LibraryFolder, "id" | "createdAt">>

export function libraryItemKey(kind: LibraryItemKind, sourceId: string): string {
  return `${kind}:${sourceId}`
}

/** How long an item stays in the Files Trash before the purge takes it (ADR-0223). */
export const FILES_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A kept item survives deletion of its source conversation. A trashed item is
 * kept too: its bytes stay pinned until the purge, so a restore within the
 * retention window always finds them.
 */
export function isLibraryItemKept(
  row: Pick<LibraryItemRow, "favoritedAt" | "folderId" | "ownedByFiles" | "trashedAt">
): boolean {
  return (
    row.favoritedAt !== undefined ||
    row.folderId !== undefined ||
    row.ownedByFiles === true ||
    row.trashedAt !== undefined
  )
}
