"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  createLibraryFolder,
  LibraryFolderError,
  renameLibraryFolder,
} from "@/lib/db/files-library-folders"
import { ROOT_LIBRARY_FOLDER_ID } from "@/lib/db/files-library-types"
import { useFilesLibraryStore } from "@/stores/files-library"

/** Create a folder (at the top level or inside another), or rename one. */
export function FilesFolderDialog() {
  const t = useTranslations("files")
  const dialog = useFilesLibraryStore((s) => s.folderDialog)
  const close = useFilesLibraryStore((s) => s.closeFolderDialog)
  const setFolderExpanded = useFilesLibraryStore((s) => s.setFolderExpanded)
  const dialogKey = dialog
    ? dialog.mode === "create"
      ? `c:${dialog.parentId}`
      : `r:${dialog.folderId}`
    : ""
  const [draft, setDraft] = useState<{ for: string; name: string } | null>(null)
  const name = draft?.for === dialogKey ? draft.name : dialog?.mode === "rename" ? dialog.name : ""
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!dialog || !name.trim()) return
    setBusy(true)
    try {
      if (dialog.mode === "create") {
        await createLibraryFolder({ name, parentFolderId: dialog.parentId })
        // The new folder shows under its parent in the sidebar tree.
        if (dialog.parentId !== ROOT_LIBRARY_FOLDER_ID) setFolderExpanded(dialog.parentId, true)
      } else {
        await renameLibraryFolder(dialog.folderId, name)
      }
      close()
      setDraft(null)
    } catch (error) {
      toast.error(t(`errors.${error instanceof LibraryFolderError ? error.code : "unknown"}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={dialog !== null} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent data-testid="files-folder-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === "rename"
                ? t("folderDialog.renameTitle")
                : t("folderDialog.createTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="files-folder-name">{t("folderDialog.nameLabel")}</Label>
            <Input
              id="files-folder-name"
              autoFocus
              value={name}
              onChange={(event) => setDraft({ for: dialogKey, name: event.target.value })}
              placeholder={t("folderDialog.placeholder")}
              maxLength={120}
              data-testid="files-folder-name"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("folderDialog.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !name.trim()} data-testid="files-folder-submit">
              {dialog?.mode === "rename" ? t("folderDialog.save") : t("folderDialog.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
