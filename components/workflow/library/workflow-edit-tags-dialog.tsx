"use client"

// Controlled "edit tags" dialog for a single workflow. Tags are entered as a
// comma-separated list and written as a normalized string[] (trimmed, empty
// dropped, de-duplicated). Keyed inner body seeds state without an effect.

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
import { updateWorkflow } from "@/lib/db/workflows"
import type { WorkflowRow } from "@/types/workflow/visual"

export interface WorkflowEditTagsDialogProps {
  workflow: WorkflowRow
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Split a comma-separated string into trimmed, de-duplicated, non-empty tags. */
export function parseTags(input: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input.split(",")) {
    const tag = raw.trim()
    if (tag && !seen.has(tag)) {
      seen.add(tag)
      out.push(tag)
    }
  }
  return out
}

export function WorkflowEditTagsDialog({
  workflow,
  open,
  onOpenChange,
}: WorkflowEditTagsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <TagsBody key={workflow.id} workflow={workflow} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TagsBody({ workflow, onClose }: { workflow: WorkflowRow; onClose: () => void }) {
  const t = useTranslations("workflows.card")
  const [text, setText] = useState((workflow.tags ?? []).join(", "))
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      await updateWorkflow(workflow.id, { tags: parseTags(text) })
      toast.success(t("tagsSaved"))
      onClose()
    } catch {
      toast.error(t("tagsFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("tagsDialog.title")}</DialogTitle>
        <DialogDescription>{t("tagsDialog.description")}</DialogDescription>
      </DialogHeader>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("tagsDialog.placeholder")}
        aria-label={t("tagsDialog.title")}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit()
        }}
        data-testid="workflow-tags-input"
      />
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {t("tagsDialog.cancel")}
        </Button>
        <Button onClick={submit} disabled={busy} data-testid="workflow-tags-submit">
          {t("tagsDialog.save")}
        </Button>
      </DialogFooter>
    </>
  )
}
