"use client"

/**
 * The Trash's two confirmations (ADR-0223): delete the chosen items forever,
 * and empty the whole Trash. Both say what "forever" means here — a file
 * uploaded into Files is deleted with its bytes; anything that lives in a
 * conversation or on the canvas leaves Files but stays where it lives.
 */

import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { displayTitle, type FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

export interface FilesTrashDialogsProps {
  entries: readonly FilesEntry[]
  actions: Pick<FilesActions, "deleteForever">
  /** Called after a confirmed delete, so the page can drop its selection. */
  onDeleted?: () => void
}

export function FilesTrashDialogs({ entries, actions, onDeleted }: FilesTrashDialogsProps) {
  const t = useTranslations("files")
  const target = useFilesLibraryStore((s) => s.deleteForeverTarget)
  const closeDelete = useFilesLibraryStore((s) => s.closeDeleteForever)
  const emptyOpen = useFilesLibraryStore((s) => s.emptyTrashOpen)
  const setEmptyOpen = useFilesLibraryStore((s) => s.setEmptyTrashOpen)

  const chosen = target
    ? entries.filter((entry) => target.includes(entry.key) && entry.trashedAt !== undefined)
    : []
  const trashed = entries.filter((entry) => entry.trashedAt !== undefined)

  return (
    <>
      <AlertDialog
        open={target !== null}
        onOpenChange={(next) => (next ? undefined : closeDelete())}
      >
        <AlertDialogContent
          className="max-h-[85vh] overflow-y-auto"
          data-testid="files-delete-forever-dialog"
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="[overflow-wrap:anywhere]">
              {chosen.length === 1
                ? t("trashDialog.deleteOneTitle", { title: displayTitle(chosen[0]!, t) })
                : t("trashDialog.deleteManyTitle", { count: chosen.length })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("trashDialog.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("trashDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={chosen.length === 0}
              onClick={() => {
                void actions.deleteForever(chosen)
                closeDelete()
                onDeleted?.()
              }}
              data-testid="files-delete-forever-confirm"
            >
              {t("trashDialog.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={emptyOpen} onOpenChange={setEmptyOpen}>
        <AlertDialogContent data-testid="files-empty-trash-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("trashDialog.emptyTitle", { count: trashed.length })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("trashDialog.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("trashDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={trashed.length === 0}
              onClick={() => {
                void actions.deleteForever(trashed)
                setEmptyOpen(false)
                onDeleted?.()
              }}
              data-testid="files-empty-trash-confirm"
            >
              {t("trashDialog.emptyConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
