"use client"

/**
 * The confirmation `plan.requiresConfirmation` was already asking for.
 *
 * A preflight plan reports `needs-confirmation` whenever one of its bindings
 * resolves a secret reference or a twin slot, and the preflight alert already
 * says so. The instantiate button passed `confirmed: true` unconditionally, so
 * the one gate the plan asks for was answered by the caller on the user's
 * behalf and the sensitive bindings were never named.
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
import type { TemplatePreflightPlan } from "@/lib/templates/service"

export interface InstantiateConfirmDialogProps {
  plan: TemplatePreflightPlan | undefined
  onOpenChange: (open: boolean) => void
  onConfirm: (plan: TemplatePreflightPlan) => void
  busy?: boolean
}

export function InstantiateConfirmDialog({
  plan,
  onOpenChange,
  onConfirm,
  busy = false,
}: InstantiateConfirmDialogProps) {
  const t = useTranslations("templateStudio.instantiateDialog")
  const sensitive = plan?.bindings.filter((binding) => binding.sensitive) ?? []

  return (
    <Dialog open={plan !== undefined} onOpenChange={onOpenChange}>
      <DialogContent data-testid="template-instantiate-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <Alert>
          <AlertTitle>{t("sensitiveTitle", { count: sensitive.length })}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4" data-testid="template-instantiate-bindings">
              {sensitive.map((binding) => (
                <li key={binding.slotId}>
                  <span className="font-mono text-xs">{binding.slotId}</span>{" "}
                  {t(`kind.${binding.kind}`)}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => plan && onConfirm(plan)}
            disabled={busy || !plan}
            data-testid="template-instantiate-confirm"
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
