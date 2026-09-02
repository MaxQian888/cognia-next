"use client"

/**
 * Efficiency findings (ADR-0165 Phase 4).
 *
 * Renders what the local detectors think about the user's own spend. Three
 * things are deliberate in the presentation, because they are what separates
 * this from a dashboard that guesses:
 *
 *   * MEASURED and ESTIMATED are labelled differently. They are different
 *     kinds of number and showing them identically would be a lie.
 *   * Every finding carries the evidence it rests on. Four turns and four
 *     hundred turns must not look alike.
 *   * A `habit` or `info` finding shows no button, because there is nothing
 *     to click. Only a `fix` carries a reversible action, and no detector
 *     emits one yet (declared dormancy, pinned in `findings.test.ts`), so the
 *     button is absent rather than present and inert.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getDb } from "@/lib/db/schema"
import { localDayString } from "@/lib/db/provider-cost-daily"
import { useSubscriptionNow } from "@/lib/subscription/core/now-ticker"
import { parseLocalDay } from "@/lib/usage/session-analytics"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { runDetectors, type OptimizationFindingV1 } from "@/lib/usage/optimization/findings"
import { formatCompactUsd } from "@/lib/usage/status-snapshot"
import { periodStart, USAGE_GLANCE_PERIODS, type UsageGlancePeriod } from "@/lib/usage/usage-glance"
import { PERIOD_LABEL_KEYS } from "@/lib/usage/usage-glance-format"
import { cn } from "@/lib/utils"

const SEVERITY_CLASS: Record<OptimizationFindingV1["severity"], string> = {
  high: "border-rose-500/40 bg-rose-500/5",
  medium: "border-amber-500/40 bg-amber-500/5",
  low: "border-border",
}

/**
 * Midday offset applied to the day anchor before deriving the window start.
 * `parseLocalDay` returns local midnight, and a DST shift can land an anchor
 * exactly on it in the previous day. Noon is unambiguous in every zone.
 */
const HALF_DAY_MS = 43_200_000

/** Periods worth analyzing. A single day is too little to find a habit in. */
export const FINDING_PERIODS: readonly UsageGlancePeriod[] = USAGE_GLANCE_PERIODS.filter(
  (p) => p !== "today"
)

export function UsageFindingsCard() {
  const t = useTranslations("settings.usageOptimizer")
  const tFinding = useTranslations("usageOptimizer.findings")
  const [period, setPeriod] = useState<UsageGlancePeriod>("30d")
  // The shared ticker owns the clock, because reading it during render is an
  // impure render. Anchoring the window on the local day also keeps the
  // live-query key stable, so the detectors are not re-run on every tick.
  const ticked = useSubscriptionNow()
  const [mountedAt] = useState(() => Date.now())
  const now = ticked > 0 ? ticked : mountedAt
  const dayKey = localDayString(now)
  const fromMs = useMemo(
    () => periodStart(period, parseLocalDay(dayKey).getTime() + HALF_DAY_MS),
    [period, dayKey]
  )

  const rows = useLiveQuery<SessionUsageRow[] | undefined>(
    async () =>
      fromMs == null ? [] : getDb().sessionUsage.where("at").aboveOrEqual(fromMs).toArray(),
    [fromMs],
    undefined
  )

  const findings = useMemo(() => {
    if (!rows || fromMs == null || now == null) return null
    // Local spend only. Another agent's bill is not a habit this app can help
    // with, and folding it in would produce findings the user cannot act on.
    const local = rows.filter((r) => !r.sourceId && r.imported !== true)
    return runDetectors({ rows: local, fromMs, toMs: now })
  }, [rows, fromMs, now])

  return (
    <div className="space-y-4 rounded-md border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Select value={period} onValueChange={(v) => setPeriod(v as UsageGlancePeriod)}>
          <SelectTrigger className="w-36" aria-label={t("period")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FINDING_PERIODS.map((p) => (
              <SelectItem key={p} value={p}>
                {t(`periods.${PERIOD_LABEL_KEYS[p]}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {findings === null ? (
        <p className="text-sm text-muted-foreground" data-testid="findings-loading">
          {t("loading")}
        </p>
      ) : findings.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="findings-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="findings-list">
          {findings.map((finding) => (
            <li
              key={finding.id}
              data-testid={`finding-${finding.detector}`}
              className={cn("space-y-1 rounded-md border p-3", SEVERITY_CLASS[finding.severity])}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{tFinding(finding.titleKey)}</span>
                <Badge variant="outline" className="text-[10px]">
                  {t(`basis.${finding.basis}`)}
                </Badge>
                {finding.estimatedSavingUsd > 0 && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t("saving", { amount: formatCompactUsd(finding.estimatedSavingUsd) })}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {tFinding(finding.bodyKey, finding.params)}
              </p>
              {/*
                The evidence line is not decoration. A finding drawn from four
                turns and one drawn from four hundred deserve different amounts
                of the reader's trust, and only this line says which is which.
              */}
              <p className="text-[11px] text-muted-foreground" data-testid="finding-evidence">
                {t("evidence", {
                  turns: finding.evidence.turns,
                  units: finding.evidence.units,
                  days: finding.evidence.days,
                })}
                {finding.evidence.unpricedTurns > 0
                  ? ` · ${t("evidenceUnpriced", { count: finding.evidence.unpricedTurns })}`
                  : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default UsageFindingsCard
