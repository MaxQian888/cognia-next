"use client"

/**
 * Move one or more entries into a folder, to the Folders root, or out of
 * Folders. Filing keeps an item past its conversation; taking it out drops
 * that unless it is also a favorite.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { FolderIcon, FolderMinusIcon, HomeIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import { ROOT_LIBRARY_FOLDER_ID, type LibraryFolder } from "@/lib/db/files-library-types"
import { flattenLibraryFolders } from "@/lib/files-library/folder-tree"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

const NONE = "__none__"

export interface FilesMoveDialogProps {
  entries: readonly FilesEntry[]
  folders: readonly LibraryFolder[]
  actions: Pick<FilesActions, "moveToFolder">
}

export function FilesMoveDialog({ entries, folders, actions }: FilesMoveDialogProps) {
  const t = useTranslations("files")
  const target = useFilesLibraryStore((s) => s.moveTarget)
  const close = useFilesLibraryStore((s) => s.closeMove)
  const open = target !== null
  const moving = entries.filter((entry) => target?.includes(entry.key))
  const initial =
    moving.length === 1 ? (moving[0]!.folderId ?? ROOT_LIBRARY_FOLDER_ID) : ROOT_LIBRARY_FOLDER_ID
  const [choice, setChoice] = useState<{ for: string; value: string } | null>(null)
  const key = target?.join("\n") ?? ""
  const value = choice?.for === key ? choice.value : initial
  const flat = flattenLibraryFolders(folders)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent data-testid="files-move-dialog">
        <DialogHeader>
          <DialogTitle>{t("moveDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("moveDialog.description", { count: moving.length })}
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={value}
          onValueChange={(next) => setChoice({ for: key, value: next })}
          className="max-h-72 gap-1 overflow-y-auto"
        >
          <FolderOption
            id={ROOT_LIBRARY_FOLDER_ID}
            label={t("moveDialog.root")}
            depth={0}
            icon="root"
          />
          {flat.map(({ folder, depth }) => (
            <FolderOption
              key={folder.id}
              id={folder.id}
              label={folder.name}
              depth={depth + 1}
              icon="folder"
            />
          ))}
          {flat.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">{t("moveDialog.empty")}</p>
          ) : null}
          <FolderOption id={NONE} label={t("moveDialog.none")} depth={0} icon="none" />
        </RadioGroup>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t("moveDialog.cancel")}
          </Button>
          <Button
            disabled={moving.length === 0}
            onClick={() => {
              close()
              void actions.moveToFolder(moving, value === NONE ? null : value)
            }}
            data-testid="files-move-confirm"
          >
            {t("moveDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FolderOption({
  id,
  label,
  depth,
  icon,
}: {
  id: string
  label: string
  depth: number
  icon: "root" | "folder" | "none"
}) {
  const Icon = icon === "root" ? HomeIcon : icon === "none" ? FolderMinusIcon : FolderIcon
  const inputId = `files-move-${id}`
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50"
      style={{ paddingLeft: `${0.5 + depth}rem` }}
    >
      <RadioGroupItem value={id} id={inputId} data-testid={`files-move-option-${id}`} />
      <Label
        htmlFor={inputId}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 font-normal"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{label}</span>
      </Label>
    </div>
  )
}
