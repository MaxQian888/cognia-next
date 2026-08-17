"use client"

// What the installed Pi packages cost on every request, before any of them is
// used. Three dimensions, deliberately not collapsed into one number:
//
//   - always-on tokens and always-visible tool schemas (the bar chart),
//   - packages that can start extra *paid model contexts* — one subagent task
//     outweighs every schema in the catalog combined, so folding it into a
//     token total would understate it by orders of magnitude,
//   - packages Cognia has never reviewed, reported as unmeasured rather than
//     free. "We didn't measure it" and "it costs nothing" are different claims.
//
// The bar chart passes `initialDimension` — without it recharts mounts at
// {-1,-1}, logs a width/height warning and flashes empty for a frame on every
// section switch (see components/skills/skill-usage-trend.tsx).

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, GaugeIcon, HelpCircleIcon, SplitIcon } from "lucide-react"
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  PI_TOOL_BUDGET_ADVISORY,
  piBudgetLevel,
  type PiContextBudget,
} from "@/lib/pi-packages/budget"
import { cn } from "@/lib/utils"

/** Bars taller than this crowd the axis; the rest are in the row list anyway. */
const MAX_BARS = 8

interface Props {
  budget: PiContextBudget
}

export function PiContextBudget({ budget }: Props) {
  const t = useTranslations("plugins.agentPackages.budget")
  const level = piBudgetLevel(budget)

  // `budget.rows` is already sorted largest-first, so the truncation keeps the
  // bars that matter; the full set is listed in the installed table below.
  const bars = budget.rows
    .filter((row) => row.staticTokens > 0)
    .slice(0, MAX_BARS)
    .map((row) => ({
      id: row.id,
      label: piPackageShortName(row.spec),
      tokens: row.staticTokens,
      spawns: row.spawnsContexts,
    }))

  const empty = budget.rows.length === 0 && budget.unknownSpecs.length === 0

  return (
    <Card className="space-y-4 p-4" data-testid="pi-context-budget">
      <div className="flex items-start gap-2">
        <GaugeIcon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          <p className="text-muted-foreground text-xs">{t("description")}</p>
        </div>
      </div>

      {empty ? (
        <p className="text-muted-foreground text-xs">{t("empty")}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground text-xs">{t("toolCount")}</span>
                <span className="font-mono text-sm" data-testid="pi-budget-tools">
                  {budget.toolCount}
                </span>
              </div>
              <Progress
                value={Math.min(100, (budget.toolCount / PI_TOOL_BUDGET_ADVISORY) * 100)}
                className={cn(
                  "mt-1.5 h-1.5",
                  level === "over" && "[&>div]:bg-destructive",
                  level === "warn" && "[&>div]:bg-amber-500"
                )}
              />
              <p className="text-muted-foreground mt-1 text-[11px]">
                {t("advisory", { limit: PI_TOOL_BUDGET_ADVISORY })} · {t(`level.${level}`)}
              </p>
            </div>

            <div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground text-xs">{t("staticTokens")}</span>
                <span className="font-mono text-sm" data-testid="pi-budget-tokens">
                  {budget.staticTokens.toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          {bars.length > 0 && (
            <div className="h-40" aria-label={t("chartLabel")} data-testid="pi-budget-chart">
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={1}
                minHeight={1}
                initialDimension={{ width: 320, height: 160 }}
              >
                <BarChart data={bars} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                  <XAxis dataKey="label" tick={false} axisLine={false} height={4} />
                  <YAxis tick={{ fontSize: 10 }} width={40} allowDecimals={false} />
                  <Tooltip
                    formatter={(value) => [Number(value).toLocaleString(), t("staticTokens")]}
                  />
                  <Bar dataKey="tokens" radius={[2, 2, 0, 0]}>
                    {bars.map((bar) => (
                      // Context-spawning packages are the expensive ones even
                      // when their bar is short; colour carries that, since the
                      // bar height cannot.
                      <Cell
                        key={bar.id}
                        className={bar.spawns ? "fill-amber-500" : "fill-primary"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {budget.spawningPackages.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <SplitIcon className="size-3.5 text-amber-500" />
                <span className="text-xs font-medium">{t("spawning")}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {budget.spawningPackages.map((entry) => (
                  <Badge key={entry.id} variant="outline" className="font-mono text-[11px]">
                    {entry.spec.replace(/^npm:/, "")}
                  </Badge>
                ))}
              </div>
              <p className="text-muted-foreground text-[11px]">{t("spawningHint")}</p>
            </div>
          )}

          {budget.unknownSpecs.length > 0 && (
            <div className="space-y-1.5" data-testid="pi-budget-unknown">
              <div className="flex items-center gap-1.5">
                <HelpCircleIcon className="size-3.5" />
                <span className="text-xs font-medium">
                  {t("unknown", { count: budget.unknownSpecs.length })}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {budget.unknownSpecs.map((spec) => (
                  <Badge key={spec} variant="secondary" className="font-mono text-[11px]">
                    {spec.replace(/^npm:/, "")}
                  </Badge>
                ))}
              </div>
              <p className="text-muted-foreground text-[11px]">{t("unknownHint")}</p>
            </div>
          )}

          {level === "over" && (
            <p className="text-destructive flex items-center gap-1.5 text-xs">
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              {t("level.over")}
            </p>
          )}
        </>
      )}
    </Card>
  )
}

/**
 * Display name for a spec: drop the `npm:` prefix and the version pin, but keep
 * an `@scope/` prefix — stripping that would make `@narumitw/pi-subagents` and
 * `@gotgenes/pi-subagents` render identically, and those two are exactly the
 * pair the overlap view exists to distinguish.
 */
export function piPackageShortName(spec: string): string {
  const withoutPrefix = spec.replace(/^(npm|git|local):/, "")
  const at = withoutPrefix.lastIndexOf("@")
  return at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix
}
