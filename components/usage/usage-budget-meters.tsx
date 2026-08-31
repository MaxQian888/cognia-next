"use client"

/**
 * The read-out half of the USD spending limits.
 *
 * The ceilings had an editor (Settings, Usage and cost) and an enforcer (the
 * send gate), but nothing in between: no surface ever told you what you had
 * actually spent against them. Setting "$20 a day" and then having no way to
 * see today's total is how a hard limit turns into a surprise block.
 *
 * One component, two mounts. It sits under the editor so a number typed into
 * the field is immediately measured against real spend, and inside the Usage
 * dashboard so the tab that explains where the money went also says how much
 * of the ceiling is left. Both read the same {@link useCostBudgetStatus}, so
 * the two views cannot drift.
 *
 * Bars reuse `QuotaBar`, the same primitive the plan-quota gauges use, mapped
 * from the budget's own four levels onto the meter's status vocabulary.
 */

import { useTranslations } from "next-intl"

import { QuotaBar } from "@/components/settings/subscription/quota-bar"
import { useCostBudgetStatus } from "@/hooks/usage/use-cost-budget-status"
import { formatBudgetRatio, GLOBAL_BUDGET_TARGET } from "@/lib/usage/cost-budget"
import type { CostBudgetLevel, CostBudgetVerdict } from "@/lib/usage/cost-budget"
import { formatCost } from "@/types/system/usage"
import { cn } from "@/lib/utils"
import type { LimitsMeterStatus } from "@/types/subscription"

/**
 * Budget levels onto meter statuses. `QuotaBar` already owns the colour for
 * each status, so a budget at 96% and a plan window at 96% look the same.
 */
const LEVEL_STATUS: Record<CostBudgetLevel, LimitsMeterStatus> = {
  ok: "ok",
  warning: "warn",
  critical: "crit",
  exceeded: "exceeded",
}

const LEVEL_TEXT: Record<CostBudgetLevel, string> = {
  ok: "text-muted-foreground",
  warning: "text-amber-500",
  critical: "text-destructive",
  exceeded: "text-destructive",
}

export interface UsageBudgetMetersProps {
  /**
   * Rendered when no ceiling is configured. The editor passes nothing (the
   * fields above it are already the explanation). The dashboard passes a hint,
   * because a card with no rows and no words reads as broken.
   */
  emptyHint?: string
  className?: string
}

export function UsageBudgetMeters({ emptyHint, className }: UsageBudgetMetersProps) {
  const t = useTranslations("usageBudget")
  const { verdicts, loading, configured } = useCostBudgetStatus()

  if (!configured) {
    return emptyHint ? (
      <p className="text-xs text-muted-foreground" data-testid="usage-budget-unconfigured">
        {emptyHint}
      </p>
    ) : null
  }

  if (loading) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="usage-budget-loading">
        {t("loading")}
      </p>
    )
  }

  return (
    <ul className={cn("space-y-2.5", className)} data-testid="usage-budget-meters">
      {verdicts.map((verdict) => (
        <BudgetMeterRow key={verdict.scopeKey} verdict={verdict} />
      ))}
    </ul>
  )
}

function BudgetMeterRow({ verdict }: { verdict: CostBudgetVerdict }) {
  const t = useTranslations("usageBudget")
  const global = verdict.target === GLOBAL_BUDGET_TARGET
  const label = global
    ? t(verdict.period === "day" ? "scope.dayGlobal" : "scope.monthGlobal")
    : t(verdict.period === "day" ? "scope.dayProvider" : "scope.monthProvider", {
        provider: verdict.target,
      })
  // Capped for the bar, uncapped in the text: a 130% overshoot must not draw a
  // bar wider than its track, but it must still say 130%.
  const barPct = Math.min(100, Math.round(verdict.ratio * 100))

  return (
    <li className="space-y-1" data-testid={`usage-budget-scope-${verdict.scopeKey}`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate">{label}</span>
        <span className={cn("shrink-0 font-mono tabular-nums", LEVEL_TEXT[verdict.level])}>
          {formatCost(verdict.usedUsd)} / {formatCost(verdict.limitUsd)}
          {" · "}
          {formatBudgetRatio(verdict.ratio)}
        </span>
      </div>
      <QuotaBar pct={barPct} status={LEVEL_STATUS[verdict.level]} label={label} className="h-1.5" />
    </li>
  )
}
