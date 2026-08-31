"use client"

/**
 * The diff `planUpdate` produces, and the confirmation `applyUpdate` demands.
 *
 * `applyUpdate` throws without `confirmed: true`, and the plan it takes carries
 * both the changes and the three-way conflicts between the instance's baseline,
 * the user's local edits and the incoming release. None of it had a UI, so the
 * whole update path was unreachable.
 */

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
import type { TemplateUpdatePlan } from "@/lib/templates/service"

export interface TemplateUpdateDialogProps {
  plan: TemplateUpdatePlan | undefined
  onOpenChange: (open: boolean) => void
  onConfirm: (plan: TemplateUpdatePlan) => void
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
            {plan.diff.conflicts.length > 0 ? (
              <Alert variant="destructive">
                <AlertTitle>{t("conflicts", { count: plan.diff.conflicts.length })}</AlertTitle>
                <AlertDescription>
                  {/* A conflict is a path the user edited locally AND the new
                      release changed. Naming them is the point: applying picks
                      the release, so the local edit is what gets lost. */}
                  <ul
                    className="list-disc space-y-1 pl-4 font-mono text-xs"
                    data-testid="template-update-conflicts"
                  >
                    {plan.diff.conflicts.map((conflict) => (
                      <li key={conflict.path}>{conflict.path}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
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
            onClick={() => plan && onConfirm(plan)}
            disabled={busy || !plan || blocked}
            data-testid="template-update-confirm"
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
