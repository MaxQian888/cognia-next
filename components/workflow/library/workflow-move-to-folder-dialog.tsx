"use client"

// Move-to-folder dialog (menu path, also the bulk-move path). Driven by the
// store's `moveDialogTarget`. Renders the full folder tree plus a root option;
// the chosen destination is applied to every targeted workflow in one batch.
// Moving workflows can't create a cycle, so all folders are valid targets.

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { FolderIcon, HomeIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { listFolders } from "@/lib/db/workflow-folders"
import { moveWorkflowsToFolder } from "@/lib/db/workflows"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"
import { useWorkflowLibraryStore } from "@/stores/workflow"

export interface FolderTreeNode {
  folder: WorkflowFolder
  depth: number
}

/** Depth-first flatten of the folder forest under root, sorted by name. */
export function flattenFolderTree(folders: WorkflowFolder[]): FolderTreeNode[] {
  const byParent = new Map<string, WorkflowFolder[]>()
  for (const f of folders) {
    const arr = byParent.get(f.parentFolderId) ?? []
    arr.push(f)
    byParent.set(f.parentFolderId, arr)
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.name.localeCompare(b.name))
  const out: FolderTreeNode[] = []
  const walk = (parentId: string, depth: number) => {
    for (const f of byParent.get(parentId) ?? []) {
      out.push({ folder: f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(ROOT_FOLDER_ID, 0)
  return out
}

export function WorkflowMoveToFolderDialog() {
  const target = useWorkflowLibraryStore((s) => s.moveDialogTarget)
  const closeMoveDialog = useWorkflowLibraryStore((s) => s.closeMoveDialog)
  const clearSelection = useWorkflowLibraryStore((s) => s.clearSelection)

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) closeMoveDialog()
      }}
    >
      <DialogContent className="sm:max-w-md">
        {target ? (
          <MoveDialogBody
            key={target.ids.join(",")}
            ids={target.ids}
            onDone={() => {
              closeMoveDialog()
              clearSelection()
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function MoveDialogBody({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const t = useTranslations("workflows.library.move")
  const folders = useLiveQuery(() => listFolders(), []) ?? []
  const [destination, setDestination] = useState<string>(ROOT_FOLDER_ID)
  const [busy, setBusy] = useState(false)
  const tree = flattenFolderTree(folders)

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      await moveWorkflowsToFolder(ids, destination)
      toast.success(t("moved", { count: ids.length }))
      onDone()
    } catch {
      toast.error(t("moveFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>
      <div className="max-h-72 overflow-y-auto rounded-md border p-1">
        <FolderOption
          label={t("root")}
          icon={<HomeIcon className="size-4" />}
          depth={0}
          selected={destination === ROOT_FOLDER_ID}
          onSelect={() => setDestination(ROOT_FOLDER_ID)}
          testid="workflow-move-target-root"
        />
        {tree.map(({ folder, depth }) => (
          <FolderOption
            key={folder.id}
            label={folder.name}
            icon={<FolderIcon className="size-4 text-amber-500" />}
            depth={depth + 1}
            selected={destination === folder.id}
            onSelect={() => setDestination(folder.id)}
            testid={`workflow-move-target-${folder.id}`}
          />
        ))}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={busy}>
          {t("cancel")}
        </Button>
        <Button onClick={submit} disabled={busy} data-testid="workflow-move-submit">
          {t("confirm")}
        </Button>
      </DialogFooter>
    </>
  )
}

function FolderOption({
  label,
  icon,
  depth,
  selected,
  onSelect,
  testid,
}: {
  label: string
  icon: React.ReactNode
  depth: number
  selected: boolean
  onSelect: () => void
  testid: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testid}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
        selected && "bg-accent font-medium"
      )}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}
