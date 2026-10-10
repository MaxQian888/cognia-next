"use client"

/**
 * The Files page's dialogs (ADR-0223), mounted once per page whichever layout
 * draws it. Each opens from a target in the Files store (move, rename, save as
 * template, share, delete forever / empty Trash, folder create / rename,
 * folder delete), so a menu item anywhere on the page only sets the target.
 */

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"

import { FilesDeleteFolderDialog } from "./files-delete-folder-dialog"
import { FilesFolderDialog } from "./files-folder-dialog"
import { FilesMoveDialog } from "./files-move-dialog"
import { FilesRenameDialog } from "./files-rename-dialog"
import { FilesSaveTemplateDialog } from "./files-save-template-dialog"
import { FilesShareDialog } from "./files-share-dialog"
import { FilesTrashDialogs } from "./files-trash-dialogs"

export interface FilesDialogsProps {
  entries: readonly FilesEntry[]
  folders: readonly LibraryFolder[]
  actions: FilesActions
  /** Items were deleted forever: the selection they were in is gone. */
  onDeleted: () => void
}

export function FilesDialogs({ entries, folders, actions, onDeleted }: FilesDialogsProps) {
  return (
    <>
      <FilesMoveDialog entries={entries} folders={folders} actions={actions} />
      <FilesRenameDialog entries={entries} actions={actions} />
      <FilesSaveTemplateDialog entries={entries} />
      <FilesShareDialog entries={entries} folders={folders} />
      <FilesTrashDialogs entries={entries} actions={actions} onDeleted={onDeleted} />
      <FilesFolderDialog />
      <FilesDeleteFolderDialog folders={folders} />
    </>
  )
}
