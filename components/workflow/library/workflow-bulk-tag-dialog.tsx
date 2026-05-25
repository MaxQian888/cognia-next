"use client"

// Add-a-tag-to-selection dialog, driven by the store's `tagDialogTarget`.
// Appends one tag to every selected workflow (idempotent per row).

import { useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { addTagToWorkflows } from "@/lib/db/workflows"
import { useWorkflowLibraryStore } from "@/stores/workflow"

export function WorkflowBulkTagDialog() {
  const target = useWorkflowLibraryStore((s) => s.tagDialogTarget)
  const close = useWorkflowLibraryStore((s) => s.closeTagDialog)
  const clearSelection = useWorkflowLibraryStore((s) => s.clearSelection)

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent className="sm:max-w-md">
        {target ? (
          <TagBody
            key={target.ids.join(",")}
            ids={target.ids}
            onDone={() => {
              close()
              clearSelection()
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TagBody({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const t = useTranslations("workflows.library.tag")
  const [tag, setTag] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const trimmed = tag.trim()
    if (busy || !trimmed) return
    setBusy(true)
    try {
      await addTagToWorkflows(ids, trimmed)
      toast.success(t("added"))
      onDone()
    } catch {
      toast.error(t("addFailed"))
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
      <Input
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        placeholder={t("placeholder")}
        aria-label={t("title")}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit()
        }}
        data-testid="workflow-bulk-tag-input"
      />
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={busy}>
          {t("cancel")}
        </Button>
        <Button
          onClick={submit}
          disabled={busy || !tag.trim()}
          data-testid="workflow-bulk-tag-submit"
        >
          {t("add")}
        </Button>
      </DialogFooter>
    </>
  )
}
