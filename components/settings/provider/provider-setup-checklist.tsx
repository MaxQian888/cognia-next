"use client"

/**
 * ProviderSetupChecklist — the readiness checklist the core computes for
 * every provider (`ProviderSetupChecklist` from
 * `@cognia/provider-core/providers/completeness`), rendered as a compact
 * strip above the Config form while setup is incomplete.
 *
 * The readiness module has produced `setupChecklist` / `nextAction` for a
 * long time; until now only `eligibility.enable.allowed` was consumed, so the
 * enable switch went dead with no explanation. This surfaces the same data as
 * a step list with the next action called out, and disappears once every step
 * is done.
 */

import { Check, Circle, ArrowRight, PlugZap } from "lucide-react"
import { useTranslations } from "next-intl"
import type {
  ProviderNextAction,
  ProviderSetupChecklist as ProviderSetupChecklistModel,
} from "@cognia/provider-core/providers/readiness"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const STEP_LABEL_KEY = {
  credential: "setupStepCredential",
  base_url: "setupStepBaseUrl",
  default_model: "setupStepDefaultModel",
  verification: "setupStepVerification",
} as const

export interface ProviderSetupChecklistProps {
  checklist: ProviderSetupChecklistModel
  /** Local engines are keyless — the strip says so instead of asking for a key. */
  isLocalEngine?: boolean
  /**
   * When the next action is `verify_connection`, offer to run the test right
   * from the strip. Omit to render the hint only.
   */
  onVerify?: () => void
  isVerifying?: boolean
  className?: string
}

export function nextActionKey(action: ProviderNextAction): string {
  return `readiness.nextAction_${action}`
}

export function ProviderSetupChecklist({
  checklist,
  isLocalEngine = false,
  onVerify,
  isVerifying = false,
  className,
}: ProviderSetupChecklistProps) {
  const t = useTranslations("providers")
  if (checklist.isComplete) return null

  const nextAction = checklist.nextAction

  return (
    <div
      className={cn("rounded-lg border border-dashed bg-muted/30 px-3 py-2.5", className)}
      data-testid="provider-setup-checklist"
      role="group"
      aria-label={t("readiness.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-xs font-medium">{t("readiness.title")}</p>
        <p className="text-[11px] text-muted-foreground" data-testid="provider-setup-progress">
          {t("readiness.progress", { completed: checklist.completed, total: checklist.total })}
        </p>
      </div>

      <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {checklist.steps.map((step) => (
          <li
            key={step.id}
            className={cn(
              "flex items-center gap-1.5 text-xs",
              step.done ? "text-muted-foreground line-through" : "text-foreground"
            )}
            data-testid={`provider-setup-step-${step.id}`}
            data-done={String(step.done)}
          >
            {step.done ? (
              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : (
              <Circle className="h-3.5 w-3.5 text-muted-foreground/60" aria-hidden />
            )}
            {t(STEP_LABEL_KEY[step.id])}
          </li>
        ))}
      </ol>

      {isLocalEngine ? (
        <p className="mt-2 text-[11px] text-muted-foreground">{t("readiness.localReady")}</p>
      ) : null}

      {nextAction ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <ArrowRight className="h-3 w-3" aria-hidden />
            {t(nextActionKey(nextAction))}
          </span>
          {nextAction === "verify_connection" && onVerify ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={onVerify}
              disabled={isVerifying}
              data-testid="provider-setup-verify"
            >
              <PlugZap className="h-3 w-3" />
              {t("testConnection")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default ProviderSetupChecklist
