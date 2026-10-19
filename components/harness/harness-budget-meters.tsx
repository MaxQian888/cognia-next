"use client"

/**
 * How much of each ceiling a run has spent, live. The ledger comes from the
 * run's usage rows (`useHarnessLiveLedger`), so it moves while steps run.
 */

import { useTranslations } from "next-intl"
import { Progress } from "@/components/ui/progress"
import { budgetMeters, type BudgetMeter } from "@/lib/harness/run-view"
import { formatMs, formatTokens, formatUsd } from "@/lib/observability/format-utils"
import { cn } from "@/lib/utils"
import type { HarnessBudgetLedger, HarnessEvolutionBudget } from "@/types/harness/evolution"

export interface HarnessBudgetMetersProps {
  ledger: HarnessBudgetLedger
  budget: HarnessEvolutionBudget
  startedAt?: number
  endedAt?: number
  now: number
}

function amount(meter: BudgetMeter, value: number): string {
  switch (meter.dimension) {
    case "cost":
      return formatUsd(value)
    case "tokens":
      return formatTokens(value)
    case "wallTime":
      return formatMs(value)
    default:
      return String(value)
  }
}

export function HarnessBudgetMeters({
  ledger,
  budget,
  startedAt,
  endedAt,
  now,
}: HarnessBudgetMetersProps) {
  const t = useTranslations("harnessEvolution.budget")
  const meters = budgetMeters(ledger, budget, {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    now,
  })
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="harness-budget-meters">
      {meters.map((meter) => (
        <div key={meter.dimension} className="flex flex-col gap-1" data-dimension={meter.dimension}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-medium">{t(`dimension.${meter.dimension}`)}</span>
            <span className="tabular-nums text-muted-foreground">
              {t("usedOf", {
                used: `${amount(meter, meter.used)}${meter.lowerBound ? "+" : ""}`,
                limit: amount(meter, meter.limit),
              })}
            </span>
          </div>
          <Progress
            value={Math.round(meter.fraction * 100)}
            aria-label={t(`dimension.${meter.dimension}`)}
            className={cn(meter.fraction >= 0.9 && "bg-destructive/20")}
          />
          {meter.lowerBound ? (
            <p className="text-xs text-muted-foreground">{t("lowerBound")}</p>
          ) : null}
        </div>
      ))}
      <p className="text-xs text-muted-foreground sm:col-span-2">
        {t("work", { rollouts: ledger.rollouts, sessions: ledger.sessions })}
      </p>
    </div>
  )
}
