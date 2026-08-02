"use client"

import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { formatCostUsd } from "@/lib/provider-diagnostics/format"

export interface RunConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Total requests the run will issue, mode multiplier already applied. */
  requestCount: number
  estimatedCostUsd: number
  /** At least one target is billable with no published price. */
  unknownCost: boolean
  /** A probe is free; anything else spends the user's money. */
  free: boolean
  limits: { maxOutputTokens: number; maxRequestsPerJob: number; maxEstimatedCostUsd: number }
  onConfirm: () => void
}

/**
 * Spend gate in front of every diagnostic run.
 *
 * Shown even for a free probe: the point is that the user always sees the
 * request count and the ceiling before anything leaves the machine, so "free"
 * and "paid" differ in the numbers, not in whether a confirmation appears.
 */
export function RunConfirmDialog({
  open,
  onOpenChange,
  requestCount,
  estimatedCostUsd,
  unknownCost,
  free,
  limits,
  onConfirm,
}: RunConfirmDialogProps) {
  const t = useTranslations("providers.diagnostics")

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("confirm.description", {
              requests: requestCount,
              cost: unknownCost ? t("confirm.unknownCost") : formatCostUsd(estimatedCostUsd),
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="rounded-lg border p-3 text-sm">
          <p>
            {t("confirm.limits", {
              tokens: limits.maxOutputTokens,
              requests: limits.maxRequestsPerJob,
              budget: limits.maxEstimatedCostUsd,
            })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t("confirm.noFallback")}</p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {free ? t("confirm.runFree") : t("confirm.runPaid")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
