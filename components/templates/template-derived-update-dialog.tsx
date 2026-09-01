"use client"

/**
 * Fold a newer upstream release into a fork.
 *
 * The sibling of `TemplateUpdateDialog`. That one reconciles a live INSTANCE
 * with a newer release. This one reconciles a forked DEFINITION with a newer
 * release of what it was forked from. Same three-way diff, same rule that no
 * conflict may be answered by omission, so the rows themselves are the shared
 * `TemplateConflictList` rather than a second copy of that control.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { TemplateConflictResolution, TemplateDerivedUpdatePlan } from "@/lib/templates/service"
import { TemplateConflictList, unresolvedPaths } from "./template-conflict-list"

export interface TemplateDerivedUpdateDialogProps {
  plan: TemplateDerivedUpdatePlan | undefined
  onOpenChange: (open: boolean) => void
  onConfirm: (
    plan: TemplateDerivedUpdatePlan,
    resolutions: Record<string, TemplateConflictResolution>
  ) => void
  busy?: boolean
}

export function TemplateDerivedUpdateDialog({
  plan,
  onOpenChange,
  onConfirm,
  busy = false,
}: TemplateDerivedUpdateDialogProps) {
  const t = useTranslations("templateStudio.origin")
  const [resolutions, setResolutions] = useState<Record<string, TemplateConflictResolution>>({})

  // A new plan is a new set of questions. Adjusted during render rather than in
  // an effect, so no paint shows the previous plan's answers.
  const planId = plan?.id
  const [answeredPlanId, setAnsweredPlanId] = useState(planId)
  if (planId !== answeredPlanId) {
    setAnsweredPlanId(planId)
    setResolutions({})
  }

  const unresolved = useMemo(
    () => unresolvedPaths(plan?.diff.conflicts ?? [], resolutions).length,
    [plan, resolutions]
  )

  return (
    <Dialog open={plan !== undefined} onOpenChange={onOpenChange}>
      <DialogContent data-testid="template-derived-update-dialog">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>
            {plan
              ? t("dialogDescription", {
                  from: plan.derivation.version ?? "",
                  to: plan.next.version ?? "",
                })
              : ""}
          </DialogDescription>
        </DialogHeader>
        {plan ? (
          <div className="space-y-3 text-sm">
            <TemplateConflictList
              conflicts={plan.diff.conflicts}
              resolutions={resolutions}
              onResolve={(path, choice) => setResolutions((prev) => ({ ...prev, [path]: choice }))}
              testId="template-derived-conflicts"
            />
            <p className="text-muted-foreground">
              {t("changes", { count: plan.diff.changes.length })}
            </p>
            <ul
              className="max-h-40 list-disc space-y-1 overflow-y-auto pl-4 font-mono text-xs"
              data-testid="template-derived-changes"
            >
              {plan.diff.changes.map((change) => (
                <li key={change.path}>{change.path}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => plan && onConfirm(plan, resolutions)}
            disabled={busy || !plan || unresolved > 0}
            data-testid="template-derived-confirm"
          >
            {t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
