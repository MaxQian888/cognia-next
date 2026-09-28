"use client"

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

/** Confirm deleting a file uploaded straight into Files (bytes included). */
export function FilesDeleteDialog({
  entries,
  actions,
}: {
  entries: readonly FilesEntry[]
  actions: Pick<FilesActions, "deleteOwned">
}) {
  const t = useTranslations("files")
  const target = useFilesLibraryStore((s) => s.deleteTarget)
  const close = useFilesLibraryStore((s) => s.closeDelete)
  const entry = entries.find((candidate) => candidate.key === target)

  return (
    <AlertDialog open={target !== null} onOpenChange={(next) => (next ? undefined : close())}>
      <AlertDialogContent data-testid="files-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("deleteDialog.title", { title: entry ? displayTitle(entry, t) : "" })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("deleteDialog.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("deleteDialog.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!entry}
            onClick={() => {
              if (entry) void actions.deleteOwned(entry)
              close()
            }}
            data-testid="files-delete-confirm"
          >
            {t("deleteDialog.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
