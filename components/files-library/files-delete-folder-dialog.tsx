"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

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
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { deleteLibraryFolder } from "@/lib/db/files-library-folders"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { useFilesLibraryStore } from "@/stores/files-library"

/**
 * Delete a folder. By default its contents move up a level; the checkbox also
 * removes its subfolders and takes their items out of Folders. Never deletes
 * an item.
 */
export function FilesDeleteFolderDialog({ folders }: { folders: readonly LibraryFolder[] }) {
  const t = useTranslations("files")
  const target = useFilesLibraryStore((s) => s.deleteFolderTarget)
  const close = useFilesLibraryStore((s) => s.closeDeleteFolder)
  const enterFolder = useFilesLibraryStore((s) => s.enterFolder)
  const folder = folders.find((candidate) => candidate.id === target)
  const [cascade, setCascade] = useState(false)

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) {
          close()
          setCascade(false)
        }
      }}
    >
      <AlertDialogContent data-testid="files-delete-folder-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("deleteFolderDialog.title", { name: folder?.name ?? "" })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("deleteFolderDialog.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-start gap-2">
          <Checkbox
            id="files-delete-folder-cascade"
            checked={cascade}
            onCheckedChange={(checked) => setCascade(checked === true)}
            data-testid="files-delete-folder-cascade"
          />
          <Label htmlFor="files-delete-folder-cascade" className="font-normal leading-snug">
            {t("deleteFolderDialog.cascade")}
          </Label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("deleteFolderDialog.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!folder}
            onClick={() => {
              if (!folder) return
              const parent = folder.parentFolderId
              void deleteLibraryFolder(folder.id, cascade ? "cascade" : "reparent")
                .then(() => enterFolder(parent))
                .catch(() => toast.error(t("errors.unknown")))
              close()
              setCascade(false)
            }}
            data-testid="files-delete-folder-confirm"
          >
            {t("deleteFolderDialog.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
