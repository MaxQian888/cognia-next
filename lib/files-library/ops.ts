/**
 * What the Files page does to a library, apart from how it says so
 * (ADR-0223). Two implementations, one interface:
 *
 *  - **local** — this device's own database: the writers in
 *    `lib/db/files-library-*` and `lib/files-library/*`, exactly what the page
 *    always ran.
 *  - **remote** (`remote/remote-ops.ts`) — a paired device managing the host's
 *    library over `files_library_*` (§9).
 *
 * The page's actions (`hooks/files-library/use-files-actions.ts`) sequence
 * these and speak to the user; neither of them knows which library it is.
 * `capabilities` says what the library can do here, so the page offers only
 * that, and labels what it holds back.
 */

import type {
  LibraryFolder,
  LibraryFolderColor,
  LibraryFolderIcon,
} from "@/lib/db/files-library-types"
import {
  restoreLibraryItems,
  setLibraryItemsFavorite,
  setLibraryItemsFolder,
  touchLibraryItemOpened,
  trashLibraryItems,
} from "@/lib/db/files-library-items"
import {
  createLibraryFolder,
  deleteLibraryFolder,
  moveLibraryFolder,
  renameLibraryFolder,
  setLibraryFolderStyle,
  type DeleteLibraryFolderMode,
} from "@/lib/db/files-library-folders"
import { libraryItemKey } from "@/lib/db/files-library-types"
import type { Artifact } from "@/types/artifact/artifact"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { downloadPayloadFor, type FilesDownloadPayload } from "./download"
import { duplicateFilesEntry, type FilesDuplicateOptions } from "./duplicate"
import { renameFilesEntry } from "./rename"
import { purgeTrashedItems } from "./trash"
import { entrySource, type FilesEntry } from "./types"
import { uploadFileToLibrary } from "./upload"
import { hasLocalWorkspaceFiles } from "./workspace-files-io"
import {
  attachEntryToSession,
  mentionCandidateFor,
  resolveUseInChatTarget,
  stageEntryMention,
} from "./use-in-chat"

/**
 * Something the library cannot do here, held back on purpose (CLAUDE.md
 * rule 7): the reason is the type, the UI labels the entry point with it, and
 * a test pins both. A paired device holds back what needs the desktop's
 * editors; a device with no workspace of its own holds back workspace files.
 */
export interface FilesHeldBack {
  reason: string
  /** Where the person can do it instead. */
  remedy: "desktop"
}

export interface FilesCapabilities {
  /**
   * New canvas documents, documents from a template, Save as template and
   * the template strip. Held back where canvas documents cannot be edited.
   */
  createDocuments: true | FilesHeldBack
  /** "Share…" as a file link. */
  share: true | FilesHeldBack
  /**
   * What "Open" does: leave Files for the item's own surface, or preview it
   * in place (read-only) because that surface is not on this device.
   */
  open: "navigate" | "preview"
  /** Largest file one upload, download, preview or zip item may move; none = no ceiling. */
  maxTransferBytes?: number
  /**
   * The Workspace files group (ADR-0223 §8). Held back where no task-workspace
   * ledger or disk is in reach: a browser or a phone using its own library.
   * A paired device lists the host's.
   */
  workspaceFiles: true | FilesHeldBack
}

/** Why this device lists no workspace files of its own. */
export const FILES_WORKSPACE_FILES_HELD_BACK: FilesHeldBack = {
  reason: "no-fs-backend",
  remedy: "desktop",
}

export const LOCAL_FILES_CAPABILITIES: FilesCapabilities = {
  createDocuments: true,
  share: true,
  open: "navigate",
  workspaceFiles: true,
}

/** What this device's own library can do: workspace files need the desktop app. */
export function localFilesCapabilities(): FilesCapabilities {
  return hasLocalWorkspaceFiles()
    ? LOCAL_FILES_CAPABILITIES
    : { ...LOCAL_FILES_CAPABILITIES, workspaceFiles: FILES_WORKSPACE_FILES_HELD_BACK }
}

/** Where "Use in chat" put the item. */
export interface FilesUseInChatOutcome {
  sessionId: string
  how: "referenced" | "attached" | "bound"
}

export interface FilesDuplicateOutcome {
  kind: "canvas" | "upload"
  /** The copy's item key. */
  key: string
}

export interface FilesOps {
  mode: "local" | "remote"
  capabilities: FilesCapabilities
  setFavorite(entries: readonly FilesEntry[], favorite: boolean): Promise<void>
  moveToFolder(entries: readonly FilesEntry[], folderId: string | null): Promise<void>
  trash(entries: readonly FilesEntry[]): Promise<void>
  restore(entries: readonly FilesEntry[]): Promise<void>
  /** End trashed items for good (`lib/files-library/trash.ts`); `retired` stayed at their source. */
  purge(entries: readonly FilesEntry[]): Promise<{ retired: number }>
  /** Record that the item was opened (it then counts as recent). */
  touch(entry: FilesEntry): Promise<void>
  rename(entry: FilesEntry, name: string): Promise<void>
  duplicate(entry: FilesEntry, options: FilesDuplicateOptions): Promise<FilesDuplicateOutcome>
  upload(file: File, options: { projectId?: string; folderId?: string }): Promise<void>
  /** The bytes "Download", the zip and the preview hand over; null when the source is gone. */
  payloadFor(entry: FilesEntry): Promise<FilesDownloadPayload | null>
  /** An artifact to preview, or null when it is gone. */
  artifactFor(entry: FilesEntry): Promise<Artifact | null>
  /** Put the item into a conversation's next message (or bind it to the conversation). */
  useInChat(entry: FilesEntry, newTitle: string): Promise<FilesUseInChatOutcome>
  createFolder(name: string, parentId: string): Promise<void>
  renameFolder(folderId: string, name: string): Promise<void>
  moveFolder(folderId: string, parentId: string): Promise<void>
  setFolderStyle(
    folderId: string,
    style: { color?: LibraryFolderColor | null; icon?: LibraryFolderIcon | null }
  ): Promise<void>
  deleteFolder(folderId: string, mode: DeleteLibraryFolderMode): Promise<void>
}

/** This device's own library. */
export function createLocalFilesOps(): FilesOps {
  return {
    mode: "local",
    capabilities: localFilesCapabilities(),
    setFavorite: (entries, favorite) =>
      setLibraryItemsFavorite(entries.map(entrySource), favorite).then(() => undefined),
    moveToFolder: (entries, folderId) =>
      setLibraryItemsFolder(entries.map(entrySource), folderId).then(() => undefined),
    trash: (entries) => trashLibraryItems(entries.map(entrySource)).then(() => undefined),
    restore: (entries) =>
      restoreLibraryItems(
        entries.map((entry) => ({ ...entrySource(entry), originAlive: entry.originAlive }))
      ).then(() => undefined),
    purge: async (entries) => {
      const outcome = await purgeTrashedItems(
        entries.map((entry) => ({
          key: entry.key,
          kind: entry.kind,
          sourceId: entry.sourceId,
          ownedByFiles: entry.ownedByFiles,
          originAlive: entry.originAlive,
        }))
      )
      return { retired: outcome.retired }
    },
    touch: (entry) => touchLibraryItemOpened(entrySource(entry)).then(() => undefined),
    rename: (entry, name) => renameFilesEntry(entry, name).then(() => undefined),
    duplicate: async (entry, options) => {
      const result = await duplicateFilesEntry(entry, options)
      return result.kind === "canvas"
        ? { kind: "canvas", key: libraryItemKey("canvas", result.id) }
        : { kind: "upload", key: result.key }
    },
    upload: (file, options) => uploadFileToLibrary(file, options).then(() => undefined),
    payloadFor: downloadPayloadFor,
    artifactFor: async (entry) =>
      entry.kind === "artifact"
        ? (useArtifactStore.getState().artifacts[entry.sourceId] ?? null)
        : null,
    useInChat: async (entry, newTitle) => {
      const { session } = await resolveUseInChatTarget(newTitle)
      if (mentionCandidateFor(entry)) {
        await stageEntryMention(entry, session.id)
        return { sessionId: session.id, how: "referenced" }
      }
      const how = await attachEntryToSession(entry, session.id)
      return { sessionId: session.id, how: how === "bound" ? "bound" : "attached" }
    },
    createFolder: (name, parentId) =>
      createLibraryFolder({ name, parentFolderId: parentId }).then(() => undefined),
    renameFolder: renameLibraryFolder,
    moveFolder: moveLibraryFolder,
    setFolderStyle: (folderId, style) => setLibraryFolderStyle(folderId, style),
    deleteFolder: (folderId, mode) => deleteLibraryFolder(folderId, mode),
  }
}

export type { FilesDownloadPayload, LibraryFolder }
