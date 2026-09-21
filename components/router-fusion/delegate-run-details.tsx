"use client"

/**
 * What a delegate run spent, beside the cascade and panel facts
 * `FusionRunDetails` already shows (ADR-0188 B4, D15).
 *
 * A separate component rather than a branch inside `fusion-run-details.tsx`:
 * that file is the cockpit's shared summary and is owned elsewhere, and the
 * delegate numbers are counted from the run's own journal (`phase.changed`
 * with `phase: "delegate"`), not from `RouterFusionRunSummary`, which only
 * describes a cascade or a panel.
 *
 * The sandbox row shows the tier the acceptance report ATTESTED. A run whose
 * report names none says so in amber: "no tier recorded" must not be allowed
 * to read as "it ran in a sandbox".
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

import { RunDetailRow } from "./fusion-run-details"
import type { DelegateProgressView } from "./delegate-review-model"

const warnText = "text-amber-600 dark:text-amber-400"

export interface DelegateRunDetailsProps {
  progress: DelegateProgressView
}

export function DelegateRunDetails({ progress }: DelegateRunDetailsProps) {
  const t = useTranslations("routerFusionDelegate.progress")
  const tChecks = useTranslations("routerFusionDelegate.checks")
  const tPatch = useTranslations("routerFusionDelegate.patch")

  if (progress.empty) {
    return (
      <div className="text-xs" data-testid="delegate-run-details">
        <p className="mb-1 text-muted-foreground">{t("title")}</p>
        <p className="text-[11px] text-muted-foreground">{t("none")}</p>
      </div>
    )
  }

  return (
    <div className="text-xs" data-testid="delegate-run-details">
      <p className="mb-1 text-muted-foreground">{t("title")}</p>
      <dl className="space-y-1.5">
        {progress.subtasks !== null ? (
          <RunDetailRow label={t("subtasks")}>
            <span className="tabular-nums">{progress.subtasks}</span>
          </RunDetailRow>
        ) : null}
        <RunDetailRow label={t("turns")}>
          <span className="tabular-nums">{progress.turns}</span>
        </RunDetailRow>
        <RunDetailRow label={t("attempts")}>
          <span className="tabular-nums">{progress.attempts}</span>
        </RunDetailRow>
        <RunDetailRow label={t("toolOperations")}>
          <span className="tabular-nums">{progress.toolOperations}</span>
        </RunDetailRow>
        <RunDetailRow label={t("repairs")}>
          <span className={cn("tabular-nums", progress.repairs > 0 && warnText)}>
            {progress.repairs}
          </span>
        </RunDetailRow>
        <RunDetailRow label={t("takeovers")}>
          <span className={cn("tabular-nums", progress.takeovers > 0 && warnText)}>
            {progress.takeovers}
          </span>
        </RunDetailRow>
        {progress.scopeExpansions > 0 ? (
          <RunDetailRow label={t("scopeExpansions")}>
            <span className={cn("tabular-nums", warnText)}>{progress.scopeExpansions}</span>
          </RunDetailRow>
        ) : null}
        <RunDetailRow label={t("sandbox")}>
          {progress.tier ? (
            tChecks(`tierValue.${progress.tier}`)
          ) : (
            <span className={warnText} data-testid="delegate-run-details-tier-unattested">
              {tChecks("tierUnattested")}
            </span>
          )}
        </RunDetailRow>
        {progress.delivery ? (
          <RunDetailRow label={t("delivery")}>
            {tPatch(`deliveryValue.${progress.delivery}`)}
          </RunDetailRow>
        ) : null}
        {progress.deliveredRevision ? (
          <RunDetailRow label={tPatch("result")}>
            <span className="font-mono text-[10px]">{progress.deliveredRevision}</span>
          </RunDetailRow>
        ) : null}
      </dl>
    </div>
  )
}
