"use client"

// Create / rename folder dialog, driven by the library store. Open when
// `createFolderParentId` (create) or `renameFolderTarget` (rename) is set. The
// inner form is keyed by target so it remounts with fresh local state on each
// open — that avoids seeding state from props inside an effect.

import { useCallback, useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createFolder, renameFolder } from "@/lib/db/workflow-folders"
import { useWorkflowLibraryStore } from "@/stores/workflow"

export function WorkflowCreateFolderDialog() {
  const createParentId = useWorkflowLibraryStore((s) => s.createFolderParentId)
  const renameTarget = useWorkflowLibraryStore((s) => s.renameFolderTarget)
  const closeCreate = useWorkflowLibraryStore((s) => s.closeCreateFolder)
  const closeRename = useWorkflowLibraryStore((s) => s.closeRenameFolder)

  const isRename = renameTarget !== null
  const open = createParentId !== null || isRename

  const close = useCallback(() => {
    if (isRename) closeRename()
    else closeCreate()
  }, [isRename, closeCreate, closeRename])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent className="sm:max-w-md">
        {open ? (
          <FolderDialogBody
            key={isRename ? `rename:${renameTarget!.id}` : `create:${createParentId}`}
            isRename={isRename}
            initialName={renameTarget?.name ?? ""}
            renameId={renameTarget?.id ?? null}
            parentId={createParentId}
            onClose={close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

interface FolderDialogBodyProps {
  isRename: boolean
  initialName: string
  renameId: string | null
  parentId: string | null
  onClose: () => void
}

function FolderDialogBody({
  isRename,
  initialName,
  renameId,
  parentId,
  onClose,
}: FolderDialogBodyProps) {
  const t = useTranslations("workflows.library.folders")
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const trimmed = name.trim()
    if (busy || !trimmed) return
    setBusy(true)
    try {
      if (isRename && renameId) {
        await renameFolder(renameId, trimmed)
        toast.success(t("renamed"))
      } else if (parentId !== null) {
        await createFolder({ name: trimmed, parentFolderId: parentId })
        toast.success(t("created"))
      }
      onClose()
    } catch {
      toast.error(t("createFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isRename ? t("renameTitle") : t("createTitle")}</DialogTitle>
      </DialogHeader>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("namePlaceholder")}
        aria-label={t("namePlaceholder")}
        autoFocus
        maxLength={120}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit()
        }}
        data-testid="workflow-folder-name-input"
      />
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {t("cancel")}
        </Button>
        <Button
          onClick={submit}
          disabled={busy || !name.trim()}
          data-testid="workflow-folder-submit"
        >
          {isRename ? t("save") : t("createCta")}
        </Button>
      </DialogFooter>
    </>
  )
}
