"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
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
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { createWorkflow } from "@/lib/db/workflows"

export interface WorkflowCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Folder the new workflow lands in. Defaults to the library root when unset. */
  parentFolderId?: string
}

export function WorkflowCreateDialog({
  open,
  onOpenChange,
  parentFolderId,
}: WorkflowCreateDialogProps) {
  const t = useTranslations("workflows.library.createDialog")
  const tToolbar = useTranslations("workflows.toolbar")
  const router = useRouter()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)

  const handleCreate = async () => {
    if (busy) return
    setBusy(true)
    try {
      const wf = await createWorkflow({
        name: name.trim() || t("namePlaceholder"),
        description: description.trim() || undefined,
        folderId: parentFolderId,
        nodes: [
          {
            id: "n_start",
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: 80, y: 120 },
            data: { label: tToolbar("run"), params: {} },
          },
        ],
        edges: [],
      })
      onOpenChange(false)
      setName("")
      setDescription("")
      router.push(`/workflows/editor?id=${encodeURIComponent(wf.id)}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("create"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="wf-name">{t("name")}</Label>
            <Input
              id="wf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              autoFocus
              maxLength={120}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-desc">{t("descriptionLabel")}</Label>
            <Textarea
              id="wf-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={busy}>
            {busy ? tToolbar("saving") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
