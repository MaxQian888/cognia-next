"use client"

/**
 * WorkflowRunDialog — start a fresh run of a saved workflow straight from the
 * library, optionally with a JSON trigger payload. Reuses the orchestrator's
 * the published placement bridge when a deployment exists, or the draft
 * orchestrator otherwise (a `trigger.manual` event from the desktop).
 * Live progress is surfaced globally by `WorkflowRunToaster`, so this dialog
 * only confirms the run started.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PlayIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import { dispatchTrigger } from "@/lib/workflow/runtime/trigger-bridge"
import type { TriggerEvent, WorkflowRow } from "@/types/workflow/visual"

export interface WorkflowRunDialogProps {
  workflow: WorkflowRow
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Parse the payload textarea: empty → `{}`, else strict JSON object. */
export function parseRunPayload(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch {
    return { ok: false }
  }
}

export function WorkflowRunDialog({ workflow, open, onOpenChange }: WorkflowRunDialogProps) {
  const t = useTranslations("workflows.card")
  const [payloadText, setPayloadText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleRun = async () => {
    const parsed = parseRunPayload(payloadText)
    if (!parsed.ok) {
      setError(t("runDialog.invalidJson"))
      return
    }
    setError(null)
    setBusy(true)
    try {
      const trigger: TriggerEvent = {
        workflowId: workflow.id,
        kind: "trigger.manual",
        payload: parsed.value,
        originAt: Date.now(),
      }
      if (workflow.published?.deploymentId) {
        await dispatchTrigger(trigger, { triggeredBy: { source: "desktop" } })
      } else {
        // Draft previews stay local; only immutable published artifacts are placeable.
        void runWorkflow({ workflow, trigger, triggeredBy: { source: "desktop" } })
      }
      toast.success(t("runStarted"))
      onOpenChange(false)
      setPayloadText("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("runDialog.invalidJson"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="workflow-run-dialog">
        <DialogHeader>
          <DialogTitle>{t("runDialog.title", { name: workflow.name })}</DialogTitle>
          <DialogDescription>{t("runDialog.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="workflow-run-payload">{t("runDialog.payloadLabel")}</Label>
          <Textarea
            id="workflow-run-payload"
            data-testid="workflow-run-payload"
            value={payloadText}
            onChange={(e) => {
              setPayloadText(e.target.value)
              if (error) setError(null)
            }}
            placeholder={t("runDialog.payloadPlaceholder")}
            rows={5}
            className="font-mono text-xs"
          />
          {error ? (
            <p className="text-xs text-destructive" data-testid="workflow-run-error">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("runDialog.cancel")}
          </Button>
          <Button onClick={handleRun} disabled={busy} data-testid="workflow-run-submit">
            <PlayIcon className="mr-1 size-4" />
            {t("runDialog.runButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default WorkflowRunDialog
