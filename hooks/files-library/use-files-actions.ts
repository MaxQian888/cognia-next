"use client"

/**
 * Every action the Files page offers (ADR-0223), with the toast that reports
 * it. The writes themselves live in `lib/db/files-library-*` and
 * `lib/files-library/*`; this hook only sequences them and speaks to the user.
 *
 * Bulk actions take a list and write it in one transaction, so a selection
 * lands on every item or on none.
 */

import { useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { loggers } from "@cognia/logging"

import {
  LibraryItemError,
  restoreLibraryItems,
  setLibraryItemsFavorite,
  setLibraryItemsFolder,
  touchLibraryItemOpened,
  trashLibraryItems,
} from "@/lib/db/files-library-items"
import {
  LibraryFolderError,
  moveLibraryFolder,
  setLibraryFolderStyle,
} from "@/lib/db/files-library-folders"
import type {
  LibraryFolder,
  LibraryFolderColor,
  LibraryFolderIcon,
} from "@/lib/db/files-library-types"
import { SessionAssetError } from "@/lib/db/session-assets"
import { downloadBlob } from "@/lib/files/download"
import { downloadPayloadFor } from "@/lib/files-library/download"
import { duplicateFilesEntry, FilesDuplicateError } from "@/lib/files-library/duplicate"
import { buildFilesZip, FilesExportError } from "@/lib/files-library/export-zip"
import { goToSession, openFilesEntry } from "@/lib/files-library/open"
import { FilesRenameError, renameFilesEntry } from "@/lib/files-library/rename"
import { purgeTrashedItems } from "@/lib/files-library/trash"
import { entrySource, type FilesEntry } from "@/lib/files-library/types"
import { uploadFileToLibrary } from "@/lib/files-library/upload"
import {
  attachEntryToSession,
  FilesUseInChatError,
  mentionCandidateFor,
  resolveUseInChatTarget,
  stageEntryMention,
} from "@/lib/files-library/use-in-chat"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useFilesLibraryStore } from "@/stores/files-library"
import { useProjectStore } from "@/stores/project/project-store"
import { useUIStore } from "@/stores/ui"

const log = loggers.store

/** Error code → `files.errors.*` key; anything unknown reads as a generic failure. */
function errorKey(error: unknown): string {
  if (
    error instanceof LibraryItemError ||
    error instanceof LibraryFolderError ||
    error instanceof FilesUseInChatError ||
    error instanceof FilesRenameError ||
    error instanceof FilesDuplicateError ||
    error instanceof FilesExportError ||
    error instanceof SessionAssetError
  ) {
    return error.code
  }
  return "unknown"
}

export interface FilesActions {
  open: (entry: FilesEntry) => Promise<void>
  preview: (entry: FilesEntry) => void
  toggleFavorite: (entry: FilesEntry) => Promise<void>
  setFavorite: (entries: readonly FilesEntry[], favorite: boolean) => Promise<void>
  moveToFolder: (entries: readonly FilesEntry[], folderId: string | null) => Promise<void>
  /** Into the Trash, with an Undo on the toast. */
  trash: (entries: readonly FilesEntry[]) => Promise<void>
  restore: (entries: readonly FilesEntry[]) => Promise<void>
  /** End trashed items for good, by the rule in `lib/files-library/trash.ts`. */
  deleteForever: (entries: readonly FilesEntry[]) => Promise<void>
  rename: (entry: FilesEntry, name: string) => Promise<boolean>
  duplicate: (entry: FilesEntry) => Promise<void>
  download: (entry: FilesEntry) => Promise<void>
  exportZip: (entries: readonly FilesEntry[], folders: readonly LibraryFolder[]) => Promise<void>
  useInChat: (entry: FilesEntry) => Promise<void>
  goToConversation: (sessionId: string) => Promise<void>
  /** Into Files; into `folderId` when a folder is in view. */
  upload: (files: readonly File[], folderId?: string) => Promise<void>
  newCanvasDocument: () => void
  moveFolder: (folderId: string, parentId: string) => Promise<void>
  setFolderStyle: (
    folderId: string,
    style: { color?: LibraryFolderColor | null; icon?: LibraryFolderIcon | null }
  ) => Promise<void>
}

export function useFilesActions(): FilesActions {
  const t = useTranslations("files")
  const router = useRouter()
  const select = useFilesLibraryStore((s) => s.select)

  const fail = useCallback(
    (action: string, error: unknown) => {
      log.warn("files action failed", { action, error: String(error) })
      toast.error(t(`errors.${errorKey(error)}`))
    },
    [t]
  )

  const deselect = useCallback(
    (entries: readonly FilesEntry[]) => {
      const selected = useFilesLibraryStore.getState().selectedKey
      if (selected && entries.some((entry) => entry.key === selected)) select(null)
    },
    [select]
  )

  const touch = useCallback(async (entry: FilesEntry) => {
    try {
      await touchLibraryItemOpened(entrySource(entry))
    } catch (error) {
      // Recency is a convenience; a failed touch must not block the open.
      log.warn("files touch failed", { key: entry.key, error: String(error) })
    }
  }, [])

  const preview = useCallback(
    (entry: FilesEntry) => {
      select(entry.key)
      void touch(entry)
    },
    [select, touch]
  )

  const open = useCallback(
    async (entry: FilesEntry) => {
      try {
        await touch(entry)
        const target = await openFilesEntry(entry, router)
        if (target === "preview") select(entry.key)
      } catch (error) {
        fail("open", error)
      }
    },
    [router, select, touch, fail]
  )

  const setFavorite = useCallback(
    async (entries: readonly FilesEntry[], favorite: boolean) => {
      if (entries.length === 0) return
      try {
        await setLibraryItemsFavorite(entries.map(entrySource), favorite)
        toast.success(
          entries.length === 1
            ? t(favorite ? "toasts.favorited" : "toasts.unfavorited", {
                title: displayTitle(entries[0]!, t),
              })
            : t(favorite ? "toasts.favoritedMany" : "toasts.unfavoritedMany", {
                count: entries.length,
              })
        )
      } catch (error) {
        fail("favorite", error)
      }
    },
    [t, fail]
  )

  const toggleFavorite = useCallback(
    (entry: FilesEntry) => setFavorite([entry], entry.favoritedAt === undefined),
    [setFavorite]
  )

  const moveToFolder = useCallback(
    async (entries: readonly FilesEntry[], folderId: string | null) => {
      if (entries.length === 0) return
      try {
        await setLibraryItemsFolder(entries.map(entrySource), folderId)
        toast.success(
          t(folderId === null ? "toasts.unfiled" : "toasts.moved", { count: entries.length })
        )
      } catch (error) {
        fail("move", error)
      }
    },
    [t, fail]
  )

  const restore = useCallback(
    async (entries: readonly FilesEntry[]) => {
      if (entries.length === 0) return
      try {
        await restoreLibraryItems(
          entries.map((entry) => ({ ...entrySource(entry), originAlive: entry.originAlive }))
        )
        toast.success(t("toasts.restored", { count: entries.length }))
      } catch (error) {
        fail("restore", error)
      }
    },
    [t, fail]
  )

  const trash = useCallback(
    async (entries: readonly FilesEntry[]) => {
      if (entries.length === 0) return
      try {
        await trashLibraryItems(entries.map(entrySource))
        deselect(entries)
        toast.success(
          entries.length === 1
            ? t("toasts.trashed", { title: displayTitle(entries[0]!, t) })
            : t("toasts.trashedMany", { count: entries.length }),
          {
            description: t("toasts.trashedHint"),
            action: {
              label: t("toasts.undo"),
              onClick: () => {
                void restoreLibraryItems(
                  entries.map((entry) => ({
                    ...entrySource(entry),
                    originAlive: entry.originAlive,
                  }))
                ).catch((error: unknown) => fail("undo-trash", error))
              },
            },
          }
        )
      } catch (error) {
        fail("trash", error)
      }
    },
    [deselect, t, fail]
  )

  const deleteForever = useCallback(
    async (entries: readonly FilesEntry[]) => {
      if (entries.length === 0) return
      try {
        const outcome = await purgeTrashedItems(
          entries.map((entry) => ({
            key: entry.key,
            kind: entry.kind,
            sourceId: entry.sourceId,
            ownedByFiles: entry.ownedByFiles,
            originAlive: entry.originAlive,
          }))
        )
        deselect(entries)
        toast.success(
          t("toasts.deletedForever", { count: entries.length }),
          outcome.retired > 0
            ? { description: t("toasts.retiredHint", { count: outcome.retired }) }
            : undefined
        )
      } catch (error) {
        fail("delete-forever", error)
      }
    },
    [deselect, t, fail]
  )

  const rename = useCallback(
    async (entry: FilesEntry, name: string) => {
      try {
        await renameFilesEntry(entry, name)
        toast.success(t("toasts.renamed", { title: name.trim() }))
        return true
      } catch (error) {
        fail("rename", error)
        return false
      }
    },
    [t, fail]
  )

  const duplicate = useCallback(
    async (entry: FilesEntry) => {
      try {
        const projectId = useProjectStore.getState().activeProjectId ?? undefined
        const result = await duplicateFilesEntry(entry, {
          suffix: t("copySuffix"),
          fallbackName: displayTitle(entry, t),
          ...(projectId ? { projectId } : {}),
        })
        toast.success(t("toasts.duplicated", { title: displayTitle(entry, t) }))
        if (result.kind === "upload") select(result.key)
      } catch (error) {
        fail("duplicate", error)
      }
    },
    [select, t, fail]
  )

  const download = useCallback(
    async (entry: FilesEntry) => {
      try {
        const payload = await downloadPayloadFor(entry)
        if (!payload) {
          toast.error(t("errors.files_source_missing"))
          return
        }
        downloadBlob(payload.blob, payload.filename)
        void touch(entry)
      } catch (error) {
        fail("download", error)
      }
    },
    [t, touch, fail]
  )

  const exportZip = useCallback(
    async (entries: readonly FilesEntry[], folders: readonly LibraryFolder[]) => {
      if (entries.length === 0) return
      const toastId = toast.loading(t("toasts.exporting", { count: entries.length }))
      try {
        const result = await buildFilesZip(entries, folders)
        downloadBlob(result.blob, t("exportFilename"))
        toast.success(
          t("toasts.exported", { count: result.written }),
          result.missing.length > 0
            ? { description: t("toasts.exportMissing", { count: result.missing.length }) }
            : undefined
        )
      } catch (error) {
        fail("export", error)
      } finally {
        toast.dismiss(toastId)
      }
    },
    [t, fail]
  )

  const useInChat = useCallback(
    async (entry: FilesEntry) => {
      try {
        const title = displayTitle(entry, t)
        const { session } = await resolveUseInChatTarget(t("newChatTitle", { title }))
        if (mentionCandidateFor(entry)) {
          await stageEntryMention(entry, session.id)
          toast.success(t("toasts.referenced", { title }))
        } else {
          const how = await attachEntryToSession(entry, session.id)
          toast.success(t(how === "bound" ? "toasts.bound" : "toasts.attached", { title }))
        }
        void touch(entry)
        await goToSession(session.id, router)
      } catch (error) {
        fail("use-in-chat", error)
      }
    },
    [router, t, touch, fail]
  )

  const goToConversation = useCallback(
    async (sessionId: string) => {
      try {
        await goToSession(sessionId, router)
      } catch (error) {
        fail("open-conversation", error)
      }
    },
    [router, fail]
  )

  const upload = useCallback(
    async (files: readonly File[], folderId?: string) => {
      if (files.length === 0) return
      const projectId = useProjectStore.getState().activeProjectId ?? undefined
      const toastId = toast.loading(t("toasts.uploading", { count: files.length }))
      let stored = 0
      for (const file of files) {
        try {
          await uploadFileToLibrary(file, {
            ...(projectId ? { projectId } : {}),
            ...(folderId ? { folderId } : {}),
          })
          stored += 1
        } catch (error) {
          log.warn("files upload failed", { name: file.name, error: String(error) })
          toast.error(
            t("toasts.uploadFailed", { name: file.name, reason: t(`errors.${errorKey(error)}`) })
          )
        }
      }
      toast.dismiss(toastId)
      if (stored > 0) toast.success(t("toasts.uploaded", { count: stored }))
    },
    [t]
  )

  const newCanvasDocument = useCallback(() => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: t("untitledDocument"),
      content: "",
      language: "markdown",
      type: "text",
      createdBy: "user",
    })
    useArtifactStore.getState().setActiveCanvas(id)
    useUIStore.getState().setSelectedGuild({ kind: "canvas" })
    router.push("/")
  }, [router, t])

  const moveFolder = useCallback(
    async (folderId: string, parentId: string) => {
      try {
        await moveLibraryFolder(folderId, parentId)
        toast.success(t("toasts.folderMoved"))
      } catch (error) {
        fail("move-folder", error)
      }
    },
    [t, fail]
  )

  const setFolderStyle = useCallback(
    async (
      folderId: string,
      style: { color?: LibraryFolderColor | null; icon?: LibraryFolderIcon | null }
    ) => {
      try {
        await setLibraryFolderStyle(folderId, style)
      } catch (error) {
        fail("folder-style", error)
      }
    },
    [fail]
  )

  return {
    open,
    preview,
    toggleFavorite,
    setFavorite,
    moveToFolder,
    trash,
    restore,
    deleteForever,
    rename,
    duplicate,
    download,
    exportZip,
    useInChat,
    goToConversation,
    upload,
    newCanvasDocument,
    moveFolder,
    setFolderStyle,
  }
}

/** The card title, or the localized fallback for an image without a name. */
export function displayTitle(
  entry: Pick<FilesEntry, "title" | "kind">,
  t: (key: string) => string
): string {
  return entry.title || t(`untitled.${entry.kind}`)
}
