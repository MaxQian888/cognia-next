/**
 * `FilesOps` for a paired device (ADR-0223 §9): every change is a
 * `files_library_*` call to the host, and every read of content goes back to
 * the host for it. After a write the source re-reads the list (`onChanged`),
 * so the page shows what the host now holds rather than what it was asked.
 *
 * Held back here, by decision (ADR-0223 §9), and labelled in the page:
 *
 *  - **Creating documents** — a new canvas document, one from a template, Save
 *    as template, the template strip. The phone cannot edit the host's canvas,
 *    so a document made here could only be read.
 *  - **Share** — the share policy, the collaboration checks and the link
 *    records all live on the host, and uploading a large selection would
 *    outlast the 30-second host bridge.
 *
 * "Open" previews in place: an artifact's panel and the canvas are the host's
 * surfaces. Bytes move at most `FILES_REMOTE_MAX_BYTES` at a time.
 */

import type { ArtifactType } from "@/types/artifact/artifact"
import { entitySelectionFrom } from "@/lib/chat/mentions/entity-sources"
import { useChatStore } from "@/stores/chat"
import { documentFilenameFor, mediaFilenameFor } from "../download"
import type { FilesCapabilities, FilesOps } from "../ops"
import type { FilesEntry } from "../types"
import { FilesUseInChatError, mentionCandidateFor } from "../use-in-chat"
import type { FilesRemoteClient } from "./client"
import { FilesRemoteError } from "./client"
import { FILES_REMOTE_MAX_BYTES } from "./types"

/** Why a paired device does not create documents or share (CLAUDE.md rule 7). */
export const FILES_PAIRED_HELD_BACK = {
  createDocuments: { reason: "canvas-not-editable-here", remedy: "desktop" },
  share: { reason: "host-owns-share-records", remedy: "desktop" },
} as const

export const PAIRED_FILES_CAPABILITIES: FilesCapabilities = {
  createDocuments: FILES_PAIRED_HELD_BACK.createDocuments,
  share: FILES_PAIRED_HELD_BACK.share,
  open: "preview",
  maxTransferBytes: FILES_REMOTE_MAX_BYTES,
}

export interface RemoteFilesOpsDeps {
  client: FilesRemoteClient
  /** How many images the device has loaded, so the host resolves the same entries. */
  imageLimit: () => number
  /** Re-read the host's library after a change. */
  onChanged: () => void
}

function isGone(error: unknown): boolean {
  return (
    error instanceof FilesRemoteError &&
    (error.code === "files_source_missing" || error.code === "files_remote_not_found")
  )
}

export function createRemoteFilesOps({
  client,
  imageLimit,
  onChanged,
}: RemoteFilesOpsDeps): FilesOps {
  const keysOf = (entries: readonly FilesEntry[]) => entries.map((entry) => entry.key)
  const changed = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work
    } finally {
      onChanged()
    }
  }
  const documentText = async (entry: FilesEntry): Promise<string | null> => {
    const detail = await client.get(entry.key, imageLimit())
    return detail.text ?? null
  }

  return {
    mode: "remote",
    capabilities: PAIRED_FILES_CAPABILITIES,
    setFavorite: (entries, favorite) =>
      changed(client.favorite(keysOf(entries), favorite, imageLimit())),
    moveToFolder: (entries, folderId) =>
      changed(client.move(keysOf(entries), folderId, imageLimit())),
    trash: (entries) => changed(client.trash(keysOf(entries), imageLimit())),
    restore: (entries) => changed(client.restore(keysOf(entries), imageLimit())),
    purge: (entries) => changed(client.purge(keysOf(entries), imageLimit())),
    touch: (entry) => client.touch(entry.key, imageLimit()),
    rename: (entry, name) => changed(client.rename(entry.key, name, imageLimit())),
    duplicate: (entry, options) =>
      changed(
        client.duplicate(entry.key, {
          suffix: options.suffix,
          fallbackName: options.fallbackName,
          imageLimit: imageLimit(),
          ...(options.projectId ? { projectId: options.projectId } : {}),
        })
      ),
    upload: async (file, options) => {
      await changed(
        client.upload(file, {
          ...(options.folderId ? { folderId: options.folderId } : {}),
          ...(options.projectId ? { projectId: options.projectId } : {}),
        })
      )
    },
    payloadFor: async (entry) => {
      try {
        if (entry.kind === "artifact" || entry.kind === "canvas") {
          const text = await documentText(entry)
          if (text === null) return null
          return {
            blob: new Blob([text], { type: "text/plain;charset=utf-8" }),
            filename: documentFilenameFor(entry),
          }
        }
        const media = await client.readMedia(entry, "original")
        return {
          blob: new Blob([Uint8Array.from(media.bytes)], { type: media.mediaType }),
          filename: mediaFilenameFor(entry, media.mediaType),
        }
      } catch (error) {
        if (isGone(error)) return null
        throw error
      }
    },
    artifactFor: async (entry) => {
      if (entry.kind !== "artifact") return null
      const text = await documentText(entry)
      if (text === null) return null
      // A read-only stand-in with the host's text, for the artifact preview.
      return {
        id: entry.sourceId,
        sessionId: entry.originSessionId ?? "",
        messageId: "",
        type: (entry.subtype ?? "code") as ArtifactType,
        title: entry.sourceTitle,
        content: text,
        ...(entry.language ? { language: entry.language as never } : {}),
        version: 1,
        createdAt: new Date(entry.createdAt),
        updatedAt: new Date(entry.updatedAt),
      }
    },
    useInChat: async (entry, newTitle) => {
      // The device's own conversation; the host checks it still takes messages.
      const active = useChatStore.getState().activeSessionId ?? undefined
      const result = await changed(
        client.attach(entry.key, {
          title: newTitle,
          imageLimit: imageLimit(),
          ...(active ? { sessionId: active } : {}),
        })
      )
      if (result.how === "referenced") {
        const candidate = mentionCandidateFor(entry)
        if (!candidate) throw new FilesUseInChatError("files_not_attachable")
        const text = await documentText(entry)
        if (text === null) throw new FilesUseInChatError("files_source_missing")
        if (!text.trim()) throw new FilesUseInChatError("files_source_empty")
        // The same chip `@artifact:` / `@canvas:` stages, in this device's composer.
        useChatStore
          .getState()
          .addContextSelection(entitySelectionFrom(candidate, text), result.sessionId)
      }
      return { sessionId: result.sessionId, how: result.how }
    },
    createFolder: (name, parentId) =>
      changed(client.createFolder(name, parentId)).then(() => undefined),
    renameFolder: (folderId, name) => changed(client.renameFolder(folderId, name)),
    moveFolder: (folderId, parentId) => changed(client.moveFolder(folderId, parentId)),
    setFolderStyle: (folderId, style) => changed(client.setFolderStyle(folderId, style)),
    deleteFolder: (folderId, mode) => changed(client.deleteFolder(folderId, mode === "cascade")),
  }
}
