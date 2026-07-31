"use client"

/**
 * Session conversion fidelity report (ADR-0090 Phase 8).
 *
 * Renders a `SessionLossReport` honestly: the five-level fidelity badge with
 * its meaning, a provenance marker for rebuilt records, and every loss entry
 * by kind. An unsupported conversion is shown as unsupported — never dressed
 * up as success.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type { SessionLossReport } from "@cognia/agent-config-types/canonical-session"

export interface FidelityReportProps {
  loss: SessionLossReport
}

const BADGE_VARIANT: Record<
  SessionLossReport["fidelity"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  "native-exact": "default",
  structured: "secondary",
  contextual: "secondary",
  "summary-only": "outline",
  unsupported: "destructive",
}

export function FidelityReport({ loss }: FidelityReportProps) {
  const t = useTranslations("sessionImport.fidelityReport")

  return (
    <div className="space-y-2 text-xs" data-testid="fidelity-report">
      <div className="flex items-center gap-2">
        <span className="font-medium">{t("title")}</span>
        <Badge variant={BADGE_VARIANT[loss.fidelity]} data-testid="fidelity-badge">
          {t(`fidelity.${loss.fidelity}`)}
        </Badge>
        {loss.rebuilt && (
          <Badge variant="outline" data-testid="rebuilt-badge">
            {t("rebuilt")}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground">{t(`fidelityHint.${loss.fidelity}`)}</p>
      {loss.rebuilt && <p className="text-muted-foreground">{t("rebuiltHint")}</p>}
      {loss.losses.length === 0 ? (
        <p className="text-muted-foreground" data-testid="no-losses">
          {t("noLosses")}
        </p>
      ) : (
        <div className="space-y-1">
          <p className="text-muted-foreground" data-testid="loss-count">
            {t("lossCount", { count: loss.losses.length })}
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {loss.losses.map((entry, index) => (
              <li key={`${entry.path}-${index}`} className="text-muted-foreground">
                <span className="font-mono">{entry.path}</span> — {t(`lossKinds.${entry.kind}`)}
                {entry.detail ? `: ${entry.detail}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
