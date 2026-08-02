"use client"

/**
 * Hand-author a plan (`PlanSource: "manual"`) — the UI half of the manual plan
 * source that ADR-0045 specified but never shipped a producer for. (`/plan new
 * <title> | <step> | …` is the same producer from the composer.)
 *
 * Deliberately a plain title + one-step-per-line editor rather than a second
 * copy of the interactive HTML editor: a created plan lands `awaiting_approval`,
 * so the very next thing the user sees is {@link PlanApprovalCard} — which
 * already hosts the drag-reorder interactive editor. Authoring here and
 * refining there keeps one rich editor in the codebase, at the step where it
 * belongs.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
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
import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { loadPlanConfigDefaults } from "@/lib/agent/plan/plan-settings"
import type { CreatePlanStepInput } from "@/types/agent/plan"

/** Max characters kept from a title / step line (matches the other producers). */
const MAX_TITLE_LEN = 200
const MAX_PLAN_TITLE_LEN = 120

export interface PlanComposerDialogProps {
  sessionId: string
  characterId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired with the new plan id after a successful create (tests / callers). */
  onCreated?: (planId: string) => void
}

/** Split the textarea into ordered, non-empty step titles. */
export function parseStepLines(raw: string): string[] {
  return (
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      // Strip a leading list marker so pasted markdown works. `\s+|$` matters:
      // a bare "- " line trims to "-", which must drop out, not become a step.
      .map((line) => line.replace(/^(?:[-*]|\d+[.)])(?:\s+|$)/, "").trim())
      .filter(Boolean)
      .map((line) => line.slice(0, MAX_TITLE_LEN))
  )
}

export function PlanComposerDialog({
  sessionId,
  characterId,
  open,
  onOpenChange,
  onCreated,
}: PlanComposerDialogProps) {
  const t = useTranslations("plan.composer")
  const [title, setTitle] = useState("")
  const [stepsText, setStepsText] = useState("")
  const [busy, setBusy] = useState(false)

  const steps = parseStepLines(stepsText)
  const canSubmit = title.trim().length > 0 && steps.length > 0 && !busy

  const reset = () => {
    setTitle("")
    setStepsText("")
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const handleCreate = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      const stepInputs: CreatePlanStepInput[] = steps.map((stepTitle, i) => ({
        title: stepTitle,
        kind: "agent_turn",
        ...(i > 0 ? { dependsOn: [i - 1] } : {}),
      }))
      const defaults = await loadPlanConfigDefaults()
      const plan = await getPlanRuntime().createPlan({
        sessionId,
        ...(characterId ? { characterId } : {}),
        title: title.trim().slice(0, MAX_PLAN_TITLE_LEN),
        source: "manual",
        executionMode: "auto",
        steps: stepInputs,
        ...(defaults ? { config: defaults } : {}),
      })
      onCreated?.(plan.id)
      reset()
      onOpenChange(false)
    } catch {
      toast.error(t("createFailed"))
      setBusy(false)
      return
    }
    setBusy(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="plan-composer-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="plan-composer-title">{t("titleLabel")}</Label>
            <Input
              id="plan-composer-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
              maxLength={MAX_PLAN_TITLE_LEN}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plan-composer-steps">{t("stepsLabel")}</Label>
            <Textarea
              id="plan-composer-steps"
              value={stepsText}
              onChange={(e) => setStepsText(e.target.value)}
              placeholder={t("stepsPlaceholder")}
              rows={8}
              className="font-mono text-xs"
            />
            <p className="text-muted-foreground text-[11px]">
              {t("stepCount", { count: steps.length })}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={!canSubmit} data-testid="plan-composer-create">
            {t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
