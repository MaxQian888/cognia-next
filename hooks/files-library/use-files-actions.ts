"use client"

/**
 * Every action the Files page offers (ADR-0223), with the toast that reports
 * it. The writes themselves are the library's `FilesOps`
 * (`lib/files-library/ops.ts`): this device's database, or a paired host's
 * over `files_library_*`; this hook only sequences them and speaks to the user.
 *
 * Bulk actions take a list and write it in one transaction, so a selection
 * lands on every item or on none.
 */

import { useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { loggers } from "@cognia/logging"

import { LibraryItemError } from "@/lib/db/files-library-items"
import { LibraryFolderError } from "@/lib/db/files-library-folders"
import type {
  LibraryFolder,
  LibraryFolderColor,
  LibraryFolderIcon,
} from "@/lib/db/files-library-types"
import { deleteDocumentTemplate, DocumentTemplateError } from "@/lib/db/document-templates"
import { SessionAssetError } from "@/lib/db/session-assets"
import {
  createDocumentFromTemplate,
  saveDocumentAsTemplate,
  type DocumentTemplateOption,
} from "@/lib/document-templates/service"
import { downloadBlob } from "@/lib/files/download"
import { FilesDuplicateError } from "@/lib/files-library/duplicate"
import { buildFilesZip, FilesExportError } from "@/lib/files-library/export-zip"
import { goToSession, openFilesEntry } from "@/lib/files-library/open"
import { createLocalFilesOps, type FilesOps } from "@/lib/files-library/ops"
import { FilesRemoteError } from "@/lib/files-library/remote/client"
import { FilesRenameError } from "@/lib/files-library/rename"
import type { FilesEntry } from "@/lib/files-library/types"
import { FilesUseInChatError } from "@/lib/files-library/use-in-chat"
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
    error instanceof SessionAssetError ||
    error instanceof DocumentTemplateError ||
    error instanceof FilesRemoteError
  ) {
    return error.code
  }
  return "unknown"
}

const DEFAULT_OPS = createLocalFilesOps()

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
  /** A new canvas document from a template, opened on the canvas. */
  newFromTemplate: (template: DocumentTemplateOption) => void
  /** Delete a saved template, with an Undo on the toast. */
  deleteTemplate: (template: DocumentTemplateOption) => Promise<void>
  moveFolder: (folderId: string, parentId: string) => Promise<void>
  setFolderStyle: (
    folderId: string,
    style: { color?: LibraryFolderColor | null; icon?: LibraryFolderIcon | null }
  ) => Promise<void>
}

/**
 * The page's actions over a library's `FilesOps` — this device's own by
 * default, a paired host's when the page runs remote (ADR-0223 §9).
 */
export function useFilesActions(ops: FilesOps = DEFAULT_OPS): FilesActions {
  const t = useTranslations("files")
  const router = useRouter()
  const select = useFilesLibraryStore((s) => s.select)
  const { capabilities } = ops
  const maxBytes = capabilities.maxTransferBytes

  // A code without its own message (an upload refusal, a transport failure)
  // reads as the generic one rather than as a raw key.
  const message = useCallback(
    (error: unknown) => {
      const key = `errors.${errorKey(error)}`
      return t.has(key) ? t(key) : t("errors.unknown")
    },
    [t]
  )

  const fail = useCallback(
    (action: string, error: unknown) => {
      log.warn("files action failed", { action, error: String(error) })
      toast.error(message(error))
    },
    [message]
  )

  const deselect = useCallback(
    (entries: readonly FilesEntry[]) => {
      const selected = useFilesLibraryStore.getState().selectedKey
      if (selected && entries.some((entry) => entry.key === selected)) select(null)
    },
    [select]
  )

  const touch = useCallback(
    async (entry: FilesEntry) => {
      try {
        await ops.touch(entry)
      } catch (error) {
        // Recency is a convenience; a failed touch must not block the open.
        log.warn("files touch failed", { key: entry.key, error: String(error) })
      }
    },
    [ops]
  )

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
        // Where the item's own surface is another device's, Open reads it here.
        if (capabilities.open === "preview") {
          select(entry.key)
          return
        }
        const target = await openFilesEntry(entry, router)
        if (target === "preview") select(entry.key)
      } catch (error) {
        fail("open", error)
      }
    },
    [router, select, touch, fail, capabilities.open]
  )

  const setFavorite = useCallback(
    async (entries: readonly FilesEntry[], favorite: boolean) => {
      if (entries.length === 0) return
      try {
        await ops.setFavorite(entries, favorite)
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
    [ops, t, fail]
  )

  const toggleFavorite = useCallback(
    (entry: FilesEntry) => setFavorite([entry], entry.favoritedAt === undefined),
    [setFavorite]
  )

  const moveToFolder = useCallback(
    async (entries: readonly FilesEntry[], folderId: string | null) => {
      if (entries.length === 0) return
      try {
        await ops.moveToFolder(entries, folderId)
        toast.success(
          t(folderId === null ? "toasts.unfiled" : "toasts.moved", { count: entries.length })
        )
      } catch (error) {
        fail("move", error)
      }
    },
    [ops, t, fail]
  )

  const restore = useCallback(
    async (entries: readonly FilesEntry[]) => {
      if (entries.length === 0) return
      try {
        await ops.restore(entries)
        toast.success(t("toasts.restored", { count: entries.length }))
      } catch (error) {
        fail("restore", error)
      }
    },
    [ops, t, fail]
  )

  const trash = useCallback(
    async (entries: readonly FilesEntry[]) => {
      if (entries.length === 0) return
      try {
        await ops.trash(entries)
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
                void ops.restore(entries).catch((error: unknown) => fail("undo-trash", error))
              },
            },
          }
        )
      } catch (error) {
        fail("trash", error)
      }
    },
    [ops, deselect, t, fail]
  )

  const deleteForever = useCallback(
    async (entries: readonly FilesEntry[]) => {
      if (entries.length === 0) return
      try {
        const outcome = await ops.purge(entries)
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
    [ops, deselect, t, fail]
  )

  const rename = useCallback(
    async (entry: FilesEntry, name: string) => {
      try {
        await ops.rename(entry, name)
        toast.success(t("toasts.renamed", { title: name.trim() }))
        return true
      } catch (error) {
        fail("rename", error)
        return false
      }
    },
    [ops, t, fail]
  )

  const duplicate = useCallback(
    async (entry: FilesEntry) => {
      try {
        const projectId = useProjectStore.getState().activeProjectId ?? undefined
        const result = await ops.duplicate(entry, {
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
    [ops, select, t, fail]
  )

  const download = useCallback(
    async (entry: FilesEntry) => {
      try {
        if (maxBytes !== undefined && (entry.byteSize ?? 0) > maxBytes) {
          toast.error(t("errors.files_remote_too_large"))
          return
        }
        const payload = await ops.payloadFor(entry)
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
    [ops, maxBytes, t, touch, fail]
  )

  const exportZip = useCallback(
    async (entries: readonly FilesEntry[], folders: readonly LibraryFolder[]) => {
      if (entries.length === 0) return
      // Refused by name where items move one piece at a time with a ceiling:
      // a zip that silently lacked them would read as complete.
      if (maxBytes !== undefined) {
        const oversized = entries.filter((entry) => (entry.byteSize ?? 0) > maxBytes)
        if (oversized.length > 0) {
          toast.error(
            t("errors.files_remote_zip_too_large", {
              name: displayTitle(oversized[0]!, t),
              more: oversized.length - 1,
            })
          )
          return
        }
      }
      const toastId = toast.loading(t("toasts.exporting", { count: entries.length }))
      try {
        const result = await buildFilesZip(entries, folders, { payloadFor: ops.payloadFor })
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
    [ops, maxBytes, t, fail]
  )

  const useInChat = useCallback(
    async (entry: FilesEntry) => {
      try {
        const title = displayTitle(entry, t)
        const outcome = await ops.useInChat(entry, t("newChatTitle", { title }))
        toast.success(
          t(
            outcome.how === "referenced"
              ? "toasts.referenced"
              : outcome.how === "bound"
                ? // On a paired device every file is bound on the host, whatever its size.
                  ops.mode === "remote"
                  ? "toasts.boundOnHost"
                  : "toasts.bound"
                : "toasts.attached",
            { title }
          )
        )
        void touch(entry)
        await goToSession(outcome.sessionId, router)
      } catch (error) {
        fail("use-in-chat", error)
      }
    },
    [ops, router, t, touch, fail]
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
        if (maxBytes !== undefined && file.size > maxBytes) {
          toast.error(
            t("toasts.uploadFailed", {
              name: file.name,
              reason: t("errors.files_remote_too_large"),
            })
          )
          continue
        }
        try {
          await ops.upload(file, {
            ...(projectId ? { projectId } : {}),
            ...(folderId ? { folderId } : {}),
          })
          stored += 1
        } catch (error) {
          log.warn("files upload failed", { name: file.name, error: String(error) })
          toast.error(t("toasts.uploadFailed", { name: file.name, reason: message(error) }))
        }
      }
      toast.dismiss(toastId)
      if (stored > 0) toast.success(t("toasts.uploaded", { count: stored }))
    },
    [ops, maxBytes, t, message]
  )

  const openOnCanvas = useCallback(
    (id: string) => {
      useArtifactStore.getState().setActiveCanvas(id)
      useUIStore.getState().setSelectedGuild({ kind: "canvas" })
      router.push("/")
    },
    [router]
  )

  // Held back where documents cannot be edited (ADR-0223 §9); the page
  // labels the entry points, and a stray call does nothing.
  const canCreate = capabilities.createDocuments === true

  const newCanvasDocument = useCallback(() => {
    if (!canCreate) return
    const id = useArtifactStore.getState().createCanvasDocument({
      title: t("untitledDocument"),
      content: "",
      language: "markdown",
      type: "text",
      createdBy: "user",
    })
    openOnCanvas(id)
  }, [canCreate, openOnCanvas, t])

  const newFromTemplate = useCallback(
    (template: DocumentTemplateOption) => {
      if (!canCreate) return
      const id = createDocumentFromTemplate(template, {
        createCanvasDocument: (params) => useArtifactStore.getState().createCanvasDocument(params),
      })
      openOnCanvas(id)
    },
    [canCreate, openOnCanvas]
  )

  const deleteTemplate = useCallback(
    async (template: DocumentTemplateOption) => {
      if (!canCreate || template.source !== "user") return
      try {
        await deleteDocumentTemplate(template.id)
        toast.success(t("toasts.templateDeleted", { name: template.name }), {
          action: {
            label: t("toasts.undo"),
            // The undo saves the same template again; it gets a new id, which
            // nothing outside the template list refers to.
            onClick: () =>
              void saveDocumentAsTemplate(template).catch((error: unknown) =>
                fail("restore-template", error)
              ),
          },
        })
      } catch (error) {
        fail("delete-template", error)
      }
    },
    [canCreate, t, fail]
  )

  const moveFolder = useCallback(
    async (folderId: string, parentId: string) => {
      try {
        await ops.moveFolder(folderId, parentId)
        toast.success(t("toasts.folderMoved"))
      } catch (error) {
        fail("move-folder", error)
      }
    },
    [ops, t, fail]
  )

  const setFolderStyle = useCallback(
    async (
      folderId: string,
      style: { color?: LibraryFolderColor | null; icon?: LibraryFolderIcon | null }
    ) => {
      try {
        await ops.setFolderStyle(folderId, style)
      } catch (error) {
        fail("folder-style", error)
      }
    },
    [ops, fail]
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
    newFromTemplate,
    deleteTemplate,
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
