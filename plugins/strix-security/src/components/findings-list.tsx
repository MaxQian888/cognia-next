"use client"

import { Download, ShieldCheck } from "lucide-react"
import { Button } from "@cognia/plugin-ui"
import type { FindingState, FindingStateRow, StrixFinding, SuppressionRule } from "../types"
import { findingStateOf, isSuppressed } from "../lib/triage"
import { usePluginT } from "../use-plugin-t"
import { FindingCard } from "./finding-card"

export interface FindingsListProps {
  findings: StrixFinding[]
  states?: readonly FindingStateRow[]
  rules?: readonly SuppressionRule[]
  onStateChange?: (finding: StrixFinding, state: FindingState) => void
  onSuppressRule?: (finding: StrixFinding) => void
  onUnsuppressRule?: (finding: StrixFinding) => void
  onExport?: () => void
}

export function FindingsList({
  findings,
  states = [],
  rules = [],
  onStateChange,
  onSuppressRule,
  onUnsuppressRule,
  onExport,
}: FindingsListProps) {
  const t = usePluginT()

  if (findings.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 py-8 text-center text-sm text-muted-foreground"
        data-testid="strix-findings-empty"
      >
        <ShieldCheck className="size-6 text-emerald-500" />
        <p>{t("findings.none")}</p>
      </div>
    )
  }

  const suppression = { states, rules }
  const mutedCount = findings.filter((finding) => isSuppressed(finding, suppression)).length

  return (
    <div className="flex flex-col gap-2" data-testid="strix-findings">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">
          {t("findings.count", { count: findings.length })}
        </h3>
        {mutedCount > 0 && (
          <span className="text-xs text-muted-foreground" data-testid="strix-findings-muted">
            {t("triage.mutedCount", { count: mutedCount })}
          </span>
        )}
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
      {findings.map((f) => (
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
  )
}
