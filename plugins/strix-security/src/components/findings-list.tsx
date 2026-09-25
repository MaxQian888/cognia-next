"use client"

import { useState } from "react"
import { Download, ShieldCheck } from "lucide-react"
import { Button } from "@cognia/plugin-ui"
import { cn } from "@cognia/plugin-ui"
import {
  SEVERITY_ORDER,
  type FindingState,
  type FindingStateRow,
  type Severity,
  type StrixFinding,
  type SuppressionRule,
} from "../types"
import { findingStateOf, isSuppressed } from "../lib/triage"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { PLUGIN_ID } from "../ids"
import { FindingCard } from "./finding-card"

const SEVERITY_CHIP: Record<Severity, string> = {
  critical: "text-destructive",
  high: "text-destructive/80",
  medium: "text-warning",
  low: "text-warning/80",
  info: "text-muted-foreground",
}

type Filter = "all" | "open" | "muted"

export interface FindingsListProps {
  findings: StrixFinding[]
  states?: readonly FindingStateRow[]
  rules?: readonly SuppressionRule[]
  /** Card columns — 1 for a narrow panel, 2 when docked wide. */
  columns?: 1 | 2
  onStateChange?: (finding: StrixFinding, state: FindingState) => void
  onSuppressRule?: (finding: StrixFinding) => void
  onUnsuppressRule?: (finding: StrixFinding) => void
  onExport?: () => void
}

export function FindingsList({
  findings,
  states = [],
  rules = [],
  columns = 1,
  onStateChange,
  onSuppressRule,
  onUnsuppressRule,
  onExport,
}: FindingsListProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const [filter, setFilter] = useState<Filter>("all")

  if (findings.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 py-8 text-center text-sm text-muted-foreground"
        data-testid="strix-findings-empty"
      >
        <ShieldCheck className="size-6 text-success" />
        <p>{t("findings.none")}</p>
      </div>
    )
  }

  const suppression = { states, rules }
  const suppressedOf = (finding: StrixFinding) => isSuppressed(finding, suppression)
  const mutedCount = findings.filter(suppressedOf).length
  const visible =
    filter === "all"
      ? findings
      : findings.filter((finding) => suppressedOf(finding) === (filter === "muted"))

  // Per-severity counts, most severe first — the shape of the report at a
  // glance, without reading a single card.
  const bySeverity = new Map<Severity, number>()
  for (const finding of findings) {
    bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1)
  }
  const severityChips = SEVERITY_ORDER.filter((s) => bySeverity.has(s))

  return (
    <div className="flex flex-col gap-2" data-testid="strix-findings">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">
          {t("findings.count", { count: findings.length })}
        </h3>
        <span className="flex items-center gap-1.5 text-xs" data-testid="strix-findings-severity">
          {severityChips.map((severity) => (
            <span key={severity} className={cn("font-medium", SEVERITY_CHIP[severity])}>
              {t(`severity.${severity}`, { count: bySeverity.get(severity) ?? 0 })}
            </span>
          ))}
        </span>
        {onExport && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 gap-1 text-xs"
            onClick={onExport}
            data-testid="strix-export-sarif"
          >
            <Download className="size-3" />
            {t("export.sarif")}
          </Button>
        )}
      </div>

      {mutedCount > 0 && (
        <div className="flex items-center gap-1" data-testid="strix-findings-filter">
          {(["all", "open", "muted"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "secondary" : "ghost"}
              className="h-6 px-2 text-xs"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              data-testid={`strix-filter-${value}`}
            >
              {value === "muted"
                ? t("triage.mutedCount", { count: mutedCount })
                : t(`findings.filter.${value}`, {
                    count: value === "all" ? findings.length : findings.length - mutedCount,
                  })}
            </Button>
          ))}
        </div>
      )}

      <div className={cn("grid gap-2", columns === 2 ? "grid-cols-2 items-start" : "grid-cols-1")}>
        {visible.map((f) => (
          <FindingCard
            key={`${f.runId}:${f.vulnId}:${f.id ?? ""}`}
            finding={f}
            state={findingStateOf(states, f.fingerprint)}
            suppressed={isSuppressed(f, suppression)}
            ruleMuted={Boolean(f.ruleId) && rules.some((rule) => rule.ruleId === f.ruleId)}
            {...(onStateChange
              ? { onStateChange: (state: FindingState) => onStateChange(f, state) }
              : {})}
            {...(onSuppressRule ? { onSuppressRule: () => onSuppressRule(f) } : {})}
            {...(onUnsuppressRule ? { onUnsuppressRule: () => onUnsuppressRule(f) } : {})}
          />
        ))}
      </div>
      {visible.length === 0 && (
        <p className="py-4 text-center text-xs text-muted-foreground">
          {t("findings.filterEmpty")}
        </p>
      )}
    </div>
  )
}
