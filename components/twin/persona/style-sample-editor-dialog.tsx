"use client"

/**
 * Add / edit a single `StyleSample`. PII-gated via `assertFieldsClean`.
 * Tone tags are surfaced as a comma-separated string and parsed back to
 * `string[]` on save. Manual additions default to `pinned: true`.
 */

import { memo, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { nanoid } from "nanoid"
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
import { assertFieldsClean, DraftPiiError } from "@/lib/twin/distill/draft-pii-guard"
import type { StyleSample } from "@/types/twin"

export interface StyleSampleEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sample: StyleSample | null
  onSave: (next: StyleSample) => Promise<void> | void
  busy?: boolean
}

interface Form {
  contextLabel: string
  original: string
  summary: string
  toneText: string
}

function toForm(sample: StyleSample | null): Form {
  if (!sample) return { contextLabel: "", original: "", summary: "", toneText: "" }
  return {
    contextLabel: sample.contextLabel,
    original: sample.original,
    summary: sample.summary,
    toneText: sample.tone.join(", "),
  }
}

function parseTone(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export const StyleSampleEditorDialog = memo(function StyleSampleEditorDialog({
  open,
  onOpenChange,
  sample,
  onSave,
  busy = false,
}: StyleSampleEditorDialogProps) {
  const t = useTranslations("twin.persona")
  const initial = useMemo(() => toForm(sample), [sample])
  const [form, setForm] = useState<Form>(initial)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setForm(initial)
      setError(null)
    }
  }, [open, initial])

  const isEdit = sample !== null

  const handleSave = async () => {
    const contextLabel = form.contextLabel.trim()
    const original = form.original.trim()
    const summary = form.summary.trim()
    if (!original) {
      setError(t("styleSample.originalRequired"))
      return
    }
    if (!summary) {
      setError(t("styleSample.summaryRequired"))
      return
    }
    try {
      assertFieldsClean({
        contextLabel,
        original,
        summary,
        tone: form.toneText,
      })
    } catch (err) {
      if (err instanceof DraftPiiError) {
        setError(t("piiError", { fields: err.violations.map((v) => v.field).join(", ") }))
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    const next: StyleSample = {
      id: sample?.id ?? nanoid(),
      contextLabel: contextLabel || t("styleSample.defaultLabel"),
      original,
      summary,
      sourceChunkId: sample?.sourceChunkId ?? "manual",
      tone: parseTone(form.toneText),
      addedAt: sample?.addedAt ?? Date.now(),
      addedBy: sample?.addedBy ?? "manual",
      embedding: sample?.embedding,
      pinned: isEdit ? sample.pinned : true,
    }
    setError(null)
    try {
      await onSave(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? null : onOpenChange(o))}>
      <DialogContent
        className="max-w-2xl max-h-[85vh] overflow-y-auto"
        data-testid="style-sample-editor-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("styleSample.titleEdit") : t("styleSample.titleAdd")}
          </DialogTitle>
          <DialogDescription>{t("styleSample.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="style-editor-context">{t("styleSample.contextLabel")}</Label>
            <Input
              id="style-editor-context"
              data-testid="style-editor-context"
              value={form.contextLabel}
              onChange={(e) => setForm((p) => ({ ...p, contextLabel: e.target.value }))}
              disabled={busy}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="style-editor-original">{t("styleSample.originalLabel")}</Label>
            <Textarea
              id="style-editor-original"
              data-testid="style-editor-original"
              value={form.original}
              onChange={(e) => setForm((p) => ({ ...p, original: e.target.value }))}
              disabled={busy}
              className="min-h-32 text-sm"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="style-editor-summary">{t("styleSample.summaryLabel")}</Label>
            <Textarea
              id="style-editor-summary"
              data-testid="style-editor-summary"
              value={form.summary}
              onChange={(e) => setForm((p) => ({ ...p, summary: e.target.value }))}
              disabled={busy}
              className="min-h-20 text-sm"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="style-editor-tone">{t("styleSample.toneLabel")}</Label>
            <Input
              id="style-editor-tone"
              data-testid="style-editor-tone"
              placeholder={t("styleSample.tonePlaceholder")}
              value={form.toneText}
              onChange={(e) => setForm((p) => ({ ...p, toneText: e.target.value }))}
              disabled={busy}
            />
          </div>
          {error ? (
            <p className="text-destructive text-sm" data-testid="style-editor-error">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("actions.cancel")}
          </Button>
          <Button onClick={() => void handleSave()} disabled={busy} data-testid="style-editor-save">
            {busy ? t("actions.saving") : t("actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})
