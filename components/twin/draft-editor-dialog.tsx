"use client"

/**
 * Edit-before-accept dialog for distilled drafts (M4).
 *
 * The Drafts tab opens this dialog when the user clicks "Edit" on a row
 * still in `pending` or `needs-revision` status. The dialog reveals the
 * fields that map cleanly onto a Character / Skill row (name /
 * description / systemPrompt | content / voiceSummary) and lets the
 * reviewer rewrite any of them. On Save, the parent gets the updated
 * `TwinDraftPayload`; it's responsible for writing the row + flipping
 * status to "edited".
 *
 * Why a separate dialog (vs inline editing)? The Drafts list shows many
 * drafts at once; inline edit modes blow up the row height and lose the
 * "review queue" feel. Dialog editing keeps the list dense and clearly
 * separates the read flow from the edit flow.
 */

import { memo, useEffect, useMemo, useState } from "react"
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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { TwinDraft, TwinDraftPayload } from "@/types/twin"

export interface DraftEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: TwinDraft | null
  /**
   * Called when the user clicks Save. The parent writes the modified
   * payload and flips the draft to `status="edited"`. Returning a
   * rejected promise keeps the dialog open with the error visible.
   */
  onSave: (next: TwinDraftPayload) => Promise<void> | void
  busy?: boolean
}

interface EditableFields {
  name: string
  description: string
  body: string
  voiceSummary: string
}

function extractFields(draft: TwinDraft | null): EditableFields {
  if (!draft) return { name: "", description: "", body: "", voiceSummary: "" }
  const data = draft.payload.data as Record<string, unknown>
  return {
    name: typeof data.name === "string" ? data.name : "",
    description: typeof data.description === "string" ? data.description : "",
    body:
      typeof data.systemPrompt === "string"
        ? data.systemPrompt
        : typeof data.content === "string"
          ? data.content
          : "",
    voiceSummary: typeof data.voiceSummary === "string" ? data.voiceSummary : "",
  }
}

function buildPayload(draft: TwinDraft, fields: EditableFields): TwinDraftPayload {
  const data = { ...(draft.payload.data as Record<string, unknown>) }
  if (fields.name.trim()) data.name = fields.name.trim()
  else delete data.name
  if (fields.description.trim()) data.description = fields.description.trim()
  else delete data.description
  // Stamp the body onto the right key depending on draft kind.
  if (draft.payload.kind === "character") {
    data.systemPrompt = fields.body
    delete data.content
    if (fields.voiceSummary.trim()) data.voiceSummary = fields.voiceSummary.trim()
    else delete data.voiceSummary
  } else {
    data.content = fields.body
    delete data.systemPrompt
    delete data.voiceSummary
  }
  if (draft.payload.kind === "character") {
    return { kind: "character", data }
  }
  return {
    kind: "skill",
    data,
    sourcePlaybookId: draft.payload.sourcePlaybookId,
  }
}

export const DraftEditorDialog = memo(function DraftEditorDialog({
  open,
  onOpenChange,
  draft,
  onSave,
  busy = false,
}: DraftEditorDialogProps) {
  const t = useTranslations("twin.draftEditor")
  const initial = useMemo(() => extractFields(draft), [draft])
  const [fields, setFields] = useState<EditableFields>(initial)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setFields(initial)
      setError(null)
    }
  }, [open, initial])

  if (!draft) return null

  const isCharacter = draft.payload.kind === "character"
  const dirty =
    fields.name !== initial.name ||
    fields.description !== initial.description ||
    fields.body !== initial.body ||
    fields.voiceSummary !== initial.voiceSummary

  const handleSave = async () => {
    if (!fields.name.trim()) {
      setError(t("nameRequired"))
      return
    }
    if (!fields.body.trim()) {
      setError(t("bodyRequired"))
      return
    }
    setError(null)
    try {
      await onSave(buildPayload(draft, fields))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? null : onOpenChange(o))}>
      <DialogContent
        className="max-w-2xl max-h-[85vh] overflow-y-auto"
        data-testid="twin-draft-editor-dialog"
      >
        <DialogHeader>
          <DialogTitle>{isCharacter ? t("titleCharacter") : t("titleSkill")}</DialogTitle>
          <DialogDescription>
            {isCharacter ? t("descriptionCharacter") : t("descriptionSkill")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="twin-draft-editor-name">{t("nameLabel")}</Label>
            <Input
              id="twin-draft-editor-name"
              data-testid="twin-draft-editor-name"
              value={fields.name}
              onChange={(e) => setFields((p) => ({ ...p, name: e.target.value }))}
              disabled={busy}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="twin-draft-editor-description">{t("descriptionLabel")}</Label>
            <Input
              id="twin-draft-editor-description"
              data-testid="twin-draft-editor-description"
              value={fields.description}
              onChange={(e) => setFields((p) => ({ ...p, description: e.target.value }))}
              disabled={busy}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="twin-draft-editor-body">
              {isCharacter ? t("systemPromptLabel") : t("contentLabel")}
            </Label>
            <Textarea
              id="twin-draft-editor-body"
              data-testid="twin-draft-editor-body"
              value={fields.body}
              onChange={(e) => setFields((p) => ({ ...p, body: e.target.value }))}
              disabled={busy}
              className="min-h-48 font-mono text-xs"
            />
          </div>
          {isCharacter ? (
            <div className="grid gap-1">
              <Label htmlFor="twin-draft-editor-voice">{t("voiceSummaryLabel")}</Label>
              <Textarea
                id="twin-draft-editor-voice"
                data-testid="twin-draft-editor-voice"
                value={fields.voiceSummary}
                onChange={(e) => setFields((p) => ({ ...p, voiceSummary: e.target.value }))}
                disabled={busy}
                className="min-h-20 text-xs"
              />
            </div>
          ) : null}
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={busy || !dirty}
            data-testid="twin-draft-editor-save"
          >
            {busy ? t("busy") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})
