"use client"

/**
 * Save a document as a template, or edit a saved template's name and
 * description (ADR-0223). Used from the Files item menu, the Files template
 * strip and the canvas export menu, so all three save the same way.
 *
 * Saving copies the document's text as it is now; the template does not follow
 * later edits to the document.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { loggers } from "@cognia/logging"

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
import { Textarea } from "@/components/ui/textarea"
import { DocumentTemplateError } from "@/lib/db/document-templates"
import {
  editDocumentTemplateDetails,
  saveDocumentAsTemplate,
  type SaveDocumentTemplateInput,
} from "@/lib/document-templates/service"

export type SaveDocumentTemplateRequest =
  | { mode: "create"; draft: Omit<SaveDocumentTemplateInput, "name" | "description">; name: string }
  | { mode: "edit"; templateId: string; name: string; description?: string }

export interface SaveDocumentTemplateDialogProps {
  /** What to save or edit; null keeps the dialog closed. */
  request: SaveDocumentTemplateRequest | null
  onClose: () => void
  onSaved?: (templateId: string) => void
}

function requestKey(request: SaveDocumentTemplateRequest | null): string {
  if (!request) return ""
  return request.mode === "edit" ? `edit:${request.templateId}` : `create:${request.name}`
}

export function SaveDocumentTemplateDialog({
  request,
  onClose,
  onSaved,
}: SaveDocumentTemplateDialogProps) {
  const t = useTranslations("documentTemplates")
  const key = requestKey(request)
  const [draft, setDraft] = useState<{ for: string; name: string; description: string } | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const current =
    draft && draft.for === key
      ? draft
      : {
          for: key,
          name: request?.name ?? "",
          description: request?.mode === "edit" ? (request.description ?? "") : "",
        }

  const close = () => {
    setDraft(null)
    onClose()
  }

  const submit = async () => {
    if (!request || !current.name.trim()) return
    setBusy(true)
    try {
      const row =
        request.mode === "create"
          ? await saveDocumentAsTemplate({
              ...request.draft,
              name: current.name,
              description: current.description,
            })
          : await editDocumentTemplateDetails(request.templateId, {
              name: current.name,
              description: current.description,
            })
      toast.success(
        t(request.mode === "create" ? "toasts.saved" : "toasts.updated", { name: row.name })
      )
      onSaved?.(row.id)
      close()
    } catch (error) {
      loggers.store.warn("document template save failed", { error: String(error) })
      toast.error(t(`errors.${error instanceof DocumentTemplateError ? error.code : "unknown"}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={request !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent data-testid="save-document-template-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>{t("saveDialog.title")}</DialogTitle>
            <DialogDescription>{t("saveDialog.hint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="save-document-template-name">{t("saveDialog.nameLabel")}</Label>
            <Input
              id="save-document-template-name"
              autoFocus
              value={current.name}
              onChange={(event) => setDraft({ ...current, name: event.target.value })}
              maxLength={120}
              data-testid="save-document-template-name"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="save-document-template-description">
              {t("saveDialog.descriptionLabel")}
            </Label>
            <Textarea
              id="save-document-template-description"
              value={current.description}
              onChange={(event) => setDraft({ ...current, description: event.target.value })}
              placeholder={t("saveDialog.descriptionPlaceholder")}
              maxLength={300}
              rows={2}
              data-testid="save-document-template-description"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("saveDialog.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={busy || !current.name.trim()}
              data-testid="save-document-template-submit"
            >
              {t("saveDialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
