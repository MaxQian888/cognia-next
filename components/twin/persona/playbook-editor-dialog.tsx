"use client"

/**
 * Add / edit a single `Playbook`. PII-gated through `assertFieldsClean`,
 * shared with the entity / style-sample editors. Steps are surfaced as a
 * single textarea with one step per line — easier to author than a
 * dynamic row list, and parsed back into a `PlaybookStep[]` on save.
 *
 * Manual additions default to `pinned: true` so the next distill run
 * doesn't lose the user's input.
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
import type { Playbook, PlaybookStep } from "@/types/twin"

export interface PlaybookEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  playbook: Playbook | null
  onSave: (next: Playbook) => Promise<void> | void
  busy?: boolean
}

interface Form {
  title: string
  trigger: string
  stepsText: string
  confidence: string
}

function stepsToText(steps: PlaybookStep[]): string {
  return steps
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => (s.rationale ? `${s.action} — ${s.rationale}` : s.action))
    .join("\n")
}

function textToSteps(text: string): PlaybookStep[] {
  return text
    .split(/\r?\n/)
    .map((raw, _i) => raw.trim())
    .filter(Boolean)
    .map((raw, i) => {
      const splitIdx = raw.indexOf(" — ")
      const action = splitIdx >= 0 ? raw.slice(0, splitIdx).trim() : raw
      const rationale = splitIdx >= 0 ? raw.slice(splitIdx + 3).trim() : undefined
      return { order: i + 1, action, rationale }
    })
}

function toForm(playbook: Playbook | null): Form {
  if (!playbook) return { title: "", trigger: "", stepsText: "", confidence: "0.5" }
  return {
    title: playbook.title,
    trigger: playbook.trigger,
    stepsText: stepsToText(playbook.steps),
    confidence: String(playbook.confidence ?? 0.5),
  }
}

export const PlaybookEditorDialog = memo(function PlaybookEditorDialog({
  open,
  onOpenChange,
  playbook,
  onSave,
  busy = false,
}: PlaybookEditorDialogProps) {
  const t = useTranslations("twin.persona")
  const initial = useMemo(() => toForm(playbook), [playbook])
  const [form, setForm] = useState<Form>(initial)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setForm(initial)
      setError(null)
    }
  }, [open, initial])

  const isEdit = playbook !== null

  const handleSave = async () => {
    const title = form.title.trim()
    const trigger = form.trigger.trim()
    if (!title) {
      setError(t("playbook.titleRequired"))
      return
    }
    if (!trigger) {
      setError(t("playbook.triggerRequired"))
      return
    }
    const steps = textToSteps(form.stepsText)
    if (steps.length === 0) {
      setError(t("playbook.stepsRequired"))
      return
    }
    try {
      assertFieldsClean({
        title,
        trigger,
        steps: form.stepsText,
      })
    } catch (err) {
      if (err instanceof DraftPiiError) {
        setError(t("piiError", { fields: err.violations.map((v) => v.field).join(", ") }))
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    const confidence = Number.isFinite(Number(form.confidence))
      ? Math.max(0, Math.min(1, Number(form.confidence)))
      : 0.5
    const next: Playbook = {
      id: playbook?.id ?? nanoid(),
      title,
      trigger,
      steps,
      examples: playbook?.examples ?? [],
      confidence,
      promotedToSkillId: playbook?.promotedToSkillId,
      pinned: isEdit ? playbook.pinned : true,
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
        data-testid="playbook-editor-dialog"
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? t("playbook.titleEdit") : t("playbook.titleAdd")}</DialogTitle>
          <DialogDescription>{t("playbook.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="playbook-editor-title">{t("playbook.titleLabel")}</Label>
            <Input
              id="playbook-editor-title"
              data-testid="playbook-editor-title"
              value={form.title}
              onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
              disabled={busy}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="playbook-editor-trigger">{t("playbook.triggerLabel")}</Label>
            <Textarea
              id="playbook-editor-trigger"
              data-testid="playbook-editor-trigger"
              value={form.trigger}
              onChange={(e) => setForm((p) => ({ ...p, trigger: e.target.value }))}
              disabled={busy}
              className="min-h-16 text-sm"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="playbook-editor-steps">{t("playbook.stepsLabel")}</Label>
            <Textarea
              id="playbook-editor-steps"
              data-testid="playbook-editor-steps"
              placeholder={t("playbook.stepsPlaceholder")}
              value={form.stepsText}
              onChange={(e) => setForm((p) => ({ ...p, stepsText: e.target.value }))}
              disabled={busy}
              className="min-h-40 font-mono text-xs"
            />
            <p className="text-muted-foreground text-xs">{t("playbook.stepsHelp")}</p>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="playbook-editor-confidence">{t("playbook.confidenceLabel")}</Label>
            <Input
              id="playbook-editor-confidence"
              data-testid="playbook-editor-confidence"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={form.confidence}
              onChange={(e) => setForm((p) => ({ ...p, confidence: e.target.value }))}
              disabled={busy}
            />
          </div>
          {error ? (
            <p className="text-destructive text-sm" data-testid="playbook-editor-error">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("actions.cancel")}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={busy}
            data-testid="playbook-editor-save"
          >
            {busy ? t("actions.saving") : t("actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})
