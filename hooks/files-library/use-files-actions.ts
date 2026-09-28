"use client"

/**
 * Every action the Files page offers (ADR-0200), with the toast that reports
 * it. The writes themselves live in `lib/db/files-library-*` and
 * `lib/files-library/*`; this hook only sequences them and speaks to the user.
 */

import { useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { loggers } from "@cognia/logging"

import {
  deleteOwnedLibraryItem,
  hideLibraryItem,
  LibraryItemError,
  setLibraryItemFavorite,
  setLibraryItemFolder,
  touchLibraryItemOpened,
} from "@/lib/db/files-library-items"
import { SessionAssetError } from "@/lib/db/session-assets"
import { downloadBlob } from "@/lib/files/download"
import { downloadPayloadFor } from "@/lib/files-library/download"
import { goToSession, openFilesEntry } from "@/lib/files-library/open"
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
  if (error instanceof LibraryItemError || error instanceof FilesUseInChatError) return error.code
  if (error instanceof SessionAssetError) return error.code
  return "unknown"
}

export interface FilesActions {
  open: (entry: FilesEntry) => Promise<void>
  preview: (entry: FilesEntry) => void
  toggleFavorite: (entry: FilesEntry) => Promise<void>
  moveToFolder: (entries: readonly FilesEntry[], folderId: string | null) => Promise<void>
  remove: (entry: FilesEntry) => Promise<void>
  deleteOwned: (entry: FilesEntry) => Promise<void>
  download: (entry: FilesEntry) => Promise<void>
  useInChat: (entry: FilesEntry) => Promise<void>
  upload: (files: readonly File[]) => Promise<void>
  newCanvasDocument: () => void
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

  const toggleFavorite = useCallback(
    async (entry: FilesEntry) => {
      const favorite = entry.favoritedAt === undefined
      try {
        await setLibraryItemFavorite(entrySource(entry), favorite)
        toast.success(
          t(favorite ? "toasts.favorited" : "toasts.unfavorited", { title: displayTitle(entry, t) })
        )
      } catch (error) {
        fail("favorite", error)
      }
    },
    [t, fail]
  )

  const moveToFolder = useCallback(
    async (entries: readonly FilesEntry[], folderId: string | null) => {
      try {
        for (const entry of entries) await setLibraryItemFolder(entrySource(entry), folderId)
        toast.success(
          t(folderId === null ? "toasts.unfiled" : "toasts.moved", { count: entries.length })
        )
      } catch (error) {
        fail("move", error)
      }
    },
    [t, fail]
  )

  const remove = useCallback(
    async (entry: FilesEntry) => {
      try {
        await hideLibraryItem(entrySource(entry))
        if (useFilesLibraryStore.getState().selectedKey === entry.key) select(null)
        toast.success(t("toasts.removed", { title: displayTitle(entry, t) }), {
          description: t("toasts.removedHint"),
        })
      } catch (error) {
        fail("remove", error)
      }
    },
    [select, t, fail]
  )

  const deleteOwned = useCallback(
    async (entry: FilesEntry) => {
      try {
        await deleteOwnedLibraryItem(entry.key)
        if (useFilesLibraryStore.getState().selectedKey === entry.key) select(null)
        toast.success(t("toasts.deleted", { title: displayTitle(entry, t) }))
      } catch (error) {
        fail("delete", error)
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

  const upload = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return
      const projectId = useProjectStore.getState().activeProjectId ?? undefined
      const toastId = toast.loading(t("toasts.uploading", { count: files.length }))
      let stored = 0
      for (const file of files) {
        try {
          await uploadFileToLibrary(file, projectId ? { projectId } : {})
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
    })
    useArtifactStore.getState().setActiveCanvas(id)
    useUIStore.getState().setSelectedGuild({ kind: "canvas" })
    router.push("/")
  }, [router, t])

  return {
    open,
    preview,
    toggleFavorite,
    moveToFolder,
    remove,
    deleteOwned,
    download,
    useInChat,
    upload,
    newCanvasDocument,
  }
}

/** The card title, or the localized fallback for an image without a name. */
export function displayTitle(
  entry: Pick<FilesEntry, "title" | "kind">,
  t: (key: string) => string
): string {
  return entry.title || t(`untitled.${entry.kind}`)
}
