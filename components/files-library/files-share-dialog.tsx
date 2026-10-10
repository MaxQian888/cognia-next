"use client"

/**
 * "Share…" from Files (ADR-0223): the items the menu or the bulk bar picked,
 * published as one link through the share dialog (ADR-0222's file bundle).
 *
 * The items are read as files when the dialog opens — names and sizes, so
 * the dialog can check the server's limits and ask about anything that looks
 * like a credential before the person commits. Creating the link first asks
 * every collaboration conversation the items come from whether its files may
 * be published, then the dialog's own gate checks the file-sharing policy.
 * A created link is remembered on the items it carried, which marks them as
 * shared while the link lives.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { createLogger } from "@cognia/logging"

import { ShareLinkDialog, type ShareLinkPickedFiles } from "@/components/share/share-link-dialog"
import { displayTitle } from "@/hooks/files-library/use-files-actions"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import {
  authorizeFilesShare,
  filesSharePayload,
  recordFilesShare,
  resolveFilesShareSelection,
  type FilesShareSelection,
} from "@/lib/files-library/share"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

const log = createLogger("files-share")

export interface FilesShareDialogProps {
  entries: readonly FilesEntry[]
  folders: readonly LibraryFolder[]
  /** Test seam. */
  resolveSelection?: typeof resolveFilesShareSelection
}

interface Resolved {
  key: string
  selection: FilesShareSelection | null
}

export function FilesShareDialog({
  entries,
  folders,
  resolveSelection = resolveFilesShareSelection,
}: FilesShareDialogProps) {
  const t = useTranslations("files")
  const target = useFilesLibraryStore((s) => s.shareTarget)
  const close = useFilesLibraryStore((s) => s.closeShare)
  const [resolved, setResolved] = useState<Resolved | null>(null)

  // The picked entries as they were when the dialog opened; later live
  // refreshes of the list must not re-read the files under the person.
  const targetKey = target?.join("\n") ?? ""
  const [frozen, setFrozen] = useState<{ key: string; picked: FilesEntry[] }>({
    key: "",
    picked: [],
  })
  if (frozen.key !== targetKey) {
    setResolved(null)
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    setFrozen({
      key: targetKey,
      picked: (target ?? [])
        .map((key) => byKey.get(key))
        .filter(
          (entry): entry is FilesEntry => entry !== undefined && entry.trashedAt === undefined
        ),
    })
  }
  const picked = frozen.key === targetKey ? frozen.picked : []

  useEffect(() => {
    if (!frozen.key) return
    let current = true
    const key = frozen.key
    resolveSelection(frozen.picked, folders).then(
      (selection) => {
        if (current) setResolved({ key, selection })
      },
      (error: unknown) => {
        log.warn("files-share-read-failed", {
          error: error instanceof Error ? error.message : String(error),
        })
        if (current) setResolved({ key, selection: null })
      }
    )
    return () => {
      current = false
    }
  }, [frozen, folders, resolveSelection])

  if (!targetKey) return null
  const fresh = resolved?.key === targetKey ? resolved : null
  const selection = fresh?.selection
  const pickedFiles: ShareLinkPickedFiles = fresh
    ? selection
      ? {
          files: selection.files,
          ...(selection.missing.length > 0
            ? { unavailable: selection.missing.map((entry) => displayTitle(entry, t)) }
            : {}),
        }
      : { files: undefined, failed: true }
    : { files: undefined }
  const title =
    picked.length === 1
      ? displayTitle(picked[0]!, t)
      : t("share.bundleTitle", { count: picked.length })

  return (
    <ShareLinkDialog
      key={targetKey}
      open
      onOpenChange={(next) => {
        if (!next) close()
      }}
      picked={pickedFiles}
      buildPayload={async () => {
        await authorizeFilesShare(selection ?? { sessions: [], unverifiableSessionIds: [] })
        return { payload: filesSharePayload(title), attachments: [] }
      }}
      onCreated={(share, carried) => {
        if (!selection) return
        const keys = new Set(carried.map((file) => selection.keyByPath.get(file.path)))
        const shared = picked.filter((entry) => keys.has(entry.key))
        void recordFilesShare(shared, share.code).catch((error: unknown) => {
          // The link exists either way; only the "shared" marker is missing.
          log.warn("files-share-record-failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }}
    />
  )
}
