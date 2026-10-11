"use client"

/**
 * Usage module: today / 7 days / 30 days, a 7-day trend, the top model, and
 * the budget when money is shown (ADR-0225 §2, ADR-0165).
 *
 * Two ADR-0165 opt-ins are honoured here rather than bypassed:
 *
 * - Money is hidden until the user asks for it. Tokens are what every
 *   install can show honestly; a spend figure is a choice.
 * - "All tools" reads other agents' session files on this machine. Choosing
 *   it shows what that means first, and only confirming switches the scope.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ScanSearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { GlanceUsageTotals } from "@/lib/glance/snapshot"
import { formatCompactTokens, formatCompactUsd } from "@/lib/usage/status-snapshot"
import { cn } from "@/lib/utils"
import type { GlanceModuleSize, GlanceUsageScope } from "@/types/glance/layout"

import { useGlance } from "../glance-context"
import {
  GlanceCompactSection,
  GlanceLinkButton,
  GlanceMeter,
  GlanceRow,
  GlanceSection,
  GlanceSparkline,
  GlanceStats,
  GlanceTag,
} from "../glance-primitives"

function ScopeSwitch({
  scope,
  onPick,
  labels,
}: {
  scope: GlanceUsageScope
  onPick: (scope: GlanceUsageScope) => void
  labels: Record<GlanceUsageScope, string> & { group: string }
}) {
  return (
    <div
      role="radiogroup"
      aria-label={labels.group}
      className="inline-flex gap-0.5 rounded-md bg-muted p-0.5"
    >
      {(["cognia", "all-tools"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={scope === value}
          onClick={() => onPick(value)}
          className={cn(
            "rounded px-1.5 text-[11px] leading-5 transition-colors",
            scope === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {labels[value]}
        </button>
      ))}
    </div>
  )
}

export function GlanceUsageModule({ size }: { size: GlanceModuleSize }) {
  const t = useTranslations("glance.modules.usage")
  const { snapshot, send, route } = useGlance()
  const usage = snapshot.usage
  const [confirmingAllTools, setConfirmingAllTools] = useState(false)
  const title = t("label")

  if (!usage) {
    return (
      <GlanceCompactSection moduleId="usage" title={title}>
        <span className="text-muted-foreground">{t("loading")}</span>
      </GlanceCompactSection>
    )
  }

  const lowerBound = usage.unpricedTurns > 0
  const money = (totals: GlanceUsageTotals) => {
    if (totals.turns > 0 && totals.knownCostUsd === 0 && lowerBound) return "—"
    const text = formatCompactUsd(totals.knownCostUsd)
    return lowerBound ? `≥${text}` : text
  }
  const second = (totals: GlanceUsageTotals) =>
    usage.showSpend ? money(totals) : t("turns", { count: totals.turns })
  const openUsage = () => route({ kind: "open-owner", owner: "usage" })
  const sparkValues = usage.sparkline.map((d) => d.tokens)

  if (size === "compact") {
    return (
      <GlanceCompactSection
        moduleId="usage"
        title={title}
        label={t("open")}
        onClick={openUsage}
        trailing={
          <GlanceSparkline values={sparkValues} width={48} height={16} label={t("sparkline")} />
        }
      >
        <span className="text-muted-foreground">{t("today")}</span>
        <b className="font-semibold tabular-nums">{formatCompactTokens(usage.today.tokens)}</b>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-muted-foreground">{t("week")}</span>
        <b className="font-semibold tabular-nums">{formatCompactTokens(usage.week.tokens)}</b>
        {usage.showSpend ? (
          <>
            <span className="text-muted-foreground/60">·</span>
            <span className="tabular-nums">{money(usage.today)}</span>
          </>
        ) : null}
      </GlanceCompactSection>
    )
  }

  const pickScope = (scope: GlanceUsageScope) => {
    if (scope === usage.scope) {
      setConfirmingAllTools(false)
      return
    }
    if (scope === "all-tools") {
      setConfirmingAllTools(true)
      return
    }
    setConfirmingAllTools(false)
    void send({ kind: "set-usage-scope", scope })
  }

  const scopeSwitch = (
    <ScopeSwitch
      scope={confirmingAllTools ? "all-tools" : usage.scope}
      onPick={pickScope}
      labels={{
        cognia: t("scope.cognia"),
        "all-tools": t("scope.allTools"),
        group: t("scope.label"),
      }}
    />
  )

  if (confirmingAllTools) {
    return (
      <GlanceSection moduleId="usage" title={title} aside={scopeSwitch}>
        <div className="flex gap-2.5 rounded-lg bg-muted/60 p-2.5 text-[12px] text-muted-foreground">
          <ScanSearchIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p>{t("allToolsConsent")}</p>
            <div className="mt-2 flex gap-1.5">
              <Button
                size="sm"
                className="h-6 px-2 text-[11.5px]"
                onClick={() => {
                  setConfirmingAllTools(false)
                  void send({ kind: "set-usage-scope", scope: "all-tools" })
                }}
              >
                {t("allToolsConfirm")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11.5px]"
                onClick={() => setConfirmingAllTools(false)}
              >
                {t("allToolsCancel")}
              </Button>
            </div>
          </div>
        </div>
      </GlanceSection>
    )
  }

  const budget = usage.budget
  const budgetSeverity = !budget
    ? "ok"
    : budget.ratio >= 0.95
      ? "crit"
      : budget.ratio >= 0.8
        ? "warn"
        : "ok"

  return (
    <GlanceSection
      moduleId="usage"
      title={title}
      meta={
        <>
          {usage.workspaceFiltered ? <GlanceTag>{t("workspaceOnly")}</GlanceTag> : null}
          {usage.freshness !== "fresh" ? (
            <GlanceTag tone="warn" title={t(`freshnessHint.${usage.freshness}`)}>
              {t(`freshness.${usage.freshness}`)}
            </GlanceTag>
          ) : null}
        </>
      }
      aside={scopeSwitch}
    >
      <GlanceStats
        stats={[
          {
            key: "today",
            label: t("today"),
            value: formatCompactTokens(usage.today.tokens),
            sub: second(usage.today),
            onClick: openUsage,
            actionLabel: t("open"),
          },
          {
            key: "week",
            label: t("week"),
            value: formatCompactTokens(usage.week.tokens),
            sub: second(usage.week),
            onClick: openUsage,
            actionLabel: t("open"),
          },
          {
            key: "month",
            label: t("month"),
            value: formatCompactTokens(usage.month.tokens),
            sub: second(usage.month),
            onClick: openUsage,
            actionLabel: t("open"),
          },
        ]}
      />
      <GlanceRow
        leading={<GlanceSparkline values={sparkValues} label={t("sparkline")} />}
        sub={usage.topModel ? formatCompactTokens(usage.topModel.tokens) : undefined}
      >
        {usage.topModel ? (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-[11.5px] text-muted-foreground">{t("topModel")}</span>
            <span className="truncate">{usage.topModel.id}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{t("noUsage")}</span>
        )}
      </GlanceRow>
      {usage.showSpend ? (
        budget ? (
          <GlanceRow
            sub={`${Math.round(budget.ratio * 100)}%`}
            trailing={
              <GlanceLinkButton
                onClick={() => void send({ kind: "set-show-spend", showSpend: false })}
              >
                {t("hideSpend")}
              </GlanceLinkButton>
            }
          >
            <span className="flex items-center gap-2">
              <span className="shrink-0 text-[11.5px] text-muted-foreground">
                {t(budget.period === "day" ? "budgetDay" : "budgetMonth")}
              </span>
              <GlanceMeter
                pct={budget.ratio * 100}
                severity={budgetSeverity}
                label={t("budgetMeter")}
              />
            </span>
          </GlanceRow>
        ) : (
          <GlanceRow
            trailing={
              <GlanceLinkButton
                onClick={() => void send({ kind: "set-show-spend", showSpend: false })}
              >
                {t("hideSpend")}
              </GlanceLinkButton>
            }
          >
            <span className="text-[11.5px] text-muted-foreground">
              {lowerBound ? t("lowerBound", { count: usage.unpricedTurns }) : t("noBudget")}
            </span>
          </GlanceRow>
        )
      ) : (
        <GlanceRow
          trailing={
            <GlanceLinkButton
              onClick={() => void send({ kind: "set-show-spend", showSpend: true })}
            >
              {t("showSpend")}
            </GlanceLinkButton>
          }
        >
          <span className="text-[11.5px] text-muted-foreground">{t("spendHidden")}</span>
        </GlanceRow>
      )}
      {size === "expanded" && usage.providers.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          {usage.providers.map((provider) => (
            <div
              key={provider.id}
              className="grid grid-cols-[5.5rem_1fr_3rem] items-center gap-2 text-[11.5px] text-muted-foreground"
            >
              <span className="truncate">{provider.id}</span>
              <GlanceMeter
                pct={provider.share * 100}
                severity="ok"
                label={t("providerShare", { provider: provider.id })}
              />
              <span className="text-right tabular-nums text-foreground">
                {Math.round(provider.share * 100)}%
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </GlanceSection>
  )
}
