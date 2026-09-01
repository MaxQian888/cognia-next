"use client"

/**
 * The diff `planUpdate` produces, and the resolution `applyUpdate` demands.
 *
 * A conflict is a path the instance's local edits AND the incoming release both
 * moved. It used to be reported as a wall: the plan came back `blocked` and the
 * update was simply refused, so a template you had customised could never take
 * an upstream release again. `lib/templates/payload-diff` now reports conflicts
 * per path, and `applyUpdate` refuses only when one is left unanswered, so this
 * dialog's job is to collect an answer for each rather than to explain a
 * dead end.
 *
 * Defaulting the toggles would defeat that. Each side of a conflict discards
 * someone's work, so every row starts unanswered and Confirm stays disabled
 * until none are left.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { TemplateConflictResolution, TemplateUpdatePlan } from "@/lib/templates/service"
import { TemplateConflictList, unresolvedPaths } from "./template-conflict-list"

export interface TemplateUpdateDialogProps {
  plan: TemplateUpdatePlan | undefined
  onOpenChange: (open: boolean) => void
  onConfirm: (
    plan: TemplateUpdatePlan,
    resolutions: Record<string, TemplateConflictResolution>
  ) => void
  busy?: boolean
}

export function TemplateUpdateDialog({
  plan,
  onOpenChange,
  onConfirm,
  busy = false,
}: TemplateUpdateDialogProps) {
  const t = useTranslations("templateStudio.updateDialog")
  const blocked = plan?.status === "blocked"
  const [resolutions, setResolutions] = useState<Record<string, TemplateConflictResolution>>({})

  // A new plan is a new set of questions. Carrying answers across would apply a
  // decision made about one release to a different one. Adjusted during render
  // rather than in an effect: an effect would let one paint show the previous
  // plan's answers against the new plan's conflicts.
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
      <DialogContent data-testid="template-update-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {plan
              ? t("description", {
                  from: plan.source.version ?? "",
                  to: plan.next.version ?? "",
                })
              : ""}
          </DialogDescription>
        </DialogHeader>
        {plan ? (
          <div className="space-y-3 text-sm">
            {plan.issues.length > 0 ? (
              <Alert variant={blocked ? "destructive" : "default"}>
                <AlertTitle>{t(`status.${plan.status}`)}</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {plan.issues.map((issue) => (
                      <li key={`${issue.code}:${issue.path ?? ""}`}>{issue.code}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            <TemplateConflictList
              conflicts={plan.diff.conflicts}
              resolutions={resolutions}
              onResolve={(path, choice) => setResolutions((prev) => ({ ...prev, [path]: choice }))}
            />
            <p className="text-muted-foreground">
              {t("changes", { count: plan.diff.changes.length })}
            </p>
            <ul
              className="max-h-40 list-disc space-y-1 overflow-y-auto pl-4 font-mono text-xs"
              data-testid="template-update-changes"
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
            disabled={busy || !plan || blocked || unresolved > 0}
            data-testid="template-update-confirm"
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
