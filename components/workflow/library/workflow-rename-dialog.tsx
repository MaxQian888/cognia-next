"use client"

// Controlled rename dialog for a single workflow — opened from a card/row
// menu. The inner body is keyed by workflow id so it seeds local state from
// props on mount without an effect.

import { useState } from "react"
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
import { updateWorkflow } from "@/lib/db/workflows"
import type { WorkflowRow } from "@/types/workflow/visual"

export interface WorkflowRenameDialogProps {
  workflow: WorkflowRow
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WorkflowRenameDialog({ workflow, open, onOpenChange }: WorkflowRenameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <RenameBody key={workflow.id} workflow={workflow} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function RenameBody({ workflow, onClose }: { workflow: WorkflowRow; onClose: () => void }) {
  const t = useTranslations("workflows.card")
  const [name, setName] = useState(workflow.name)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const trimmed = name.trim()
    if (busy || !trimmed) return
    setBusy(true)
    try {
      await updateWorkflow(workflow.id, { name: trimmed })
      toast.success(t("renamed"))
      onClose()
    } catch {
      toast.error(t("renameFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("renameDialog.title")}</DialogTitle>
      </DialogHeader>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("renameDialog.namePlaceholder")}
        aria-label={t("renameDialog.namePlaceholder")}
        autoFocus
        maxLength={120}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit()
        }}
        data-testid="workflow-rename-input"
      />
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {t("renameDialog.cancel")}
        </Button>
        <Button
          onClick={submit}
          disabled={busy || !name.trim()}
          data-testid="workflow-rename-submit"
        >
          {t("renameDialog.save")}
        </Button>
      </DialogFooter>
    </>
  )
}
