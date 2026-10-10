"use client"

/**
 * Rename a Files item (ADR-0223). What the new name changes depends on who
 * owns the item (`renameTargetFor`): a canvas document and a Files-owned upload
 * are renamed at the source; anything else keeps its source name and Files
 * shows the new one. The dialog says which, so nobody expects a conversation's
 * artifact to change under them.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { displayTitle, type FilesActions } from "@/hooks/files-library/use-files-actions"
import { renameTargetFor } from "@/lib/files-library/rename"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

export function FilesRenameDialog({
  entries,
  actions,
}: {
  entries: readonly FilesEntry[]
  actions: Pick<FilesActions, "rename">
}) {
  const t = useTranslations("files")
  const target = useFilesLibraryStore((s) => s.renameTarget)
  const close = useFilesLibraryStore((s) => s.closeRename)
  const entry = entries.find((candidate) => candidate.key === target)
  const [draft, setDraft] = useState<{ for: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const current = entry ? displayTitle(entry, t) : ""
  const name = draft && draft.for === target ? draft.name : current
  const where = entry ? renameTargetFor(entry) : "display-name"

  const submit = async () => {
    if (!entry || !name.trim()) return
    if (name.trim() === current) {
      close()
      return
    }
    setBusy(true)
    try {
      if (await actions.rename(entry, name)) {
        close()
        setDraft(null)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={target !== null && entry !== undefined}
      onOpenChange={(next) => {
        if (!next) {
          close()
          setDraft(null)
        }
      }}
    >
      <DialogContent data-testid="files-rename-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>{t("renameDialog.title")}</DialogTitle>
            <DialogDescription>
              {where === "display-name"
                ? t("renameDialog.displayNameHint")
                : t("renameDialog.sourceHint")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="files-rename-name">{t("renameDialog.nameLabel")}</Label>
            <Input
              id="files-rename-name"
              autoFocus
              value={name}
              onChange={(event) => setDraft({ for: target ?? "", name: event.target.value })}
              onFocus={(event) => {
                // Select the stem, not the extension, like a file manager.
                const value = event.currentTarget.value
                const dot = value.lastIndexOf(".")
                event.currentTarget.setSelectionRange(0, dot > 0 ? dot : value.length)
              }}
              maxLength={255}
              data-testid="files-rename-name"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("renameDialog.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !name.trim()} data-testid="files-rename-submit">
              {t("renameDialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
