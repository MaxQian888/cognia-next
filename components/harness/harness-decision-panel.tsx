"use client"

/**
 * The final selection: what was chosen and why, how risky the change is, and
 * (while a run waits) the approve / keep-current choice. The base is always a
 * candidate, so "keep the current harness" is a normal outcome, not a failure.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import type { HarnessEvolutionRun, HarnessSelectionRecord } from "@/types/harness/evolution"
import { useStepLabel } from "./harness-run-timeline"

const RISK_VARIANT = { low: "success", medium: "warning", high: "destructive" } as const

export function HarnessSelectionView({ selection }: { selection: HarnessSelectionRecord }) {
  const t = useTranslations("harnessEvolution.selection")
  const labelOf = useStepLabel()
  const list = (labels: string[]) => labels.map(labelOf).join(", ")
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="harness-selection">
      <p>
        <span className="text-muted-foreground">{t("method")}: </span>
        {t(`methods.${selection.method}`)}
      </p>
      {selection.dominant.length ? (
        <p>{t("dominant", { list: list(selection.dominant) })}</p>
      ) : null}
      {selection.regressed.length ? (
        <p className="text-destructive">{t("regressed", { list: list(selection.regressed) })}</p>
      ) : null}
      {selection.unchanged.length ? (
        <p className="text-muted-foreground">
          {t("unchanged", { list: list(selection.unchanged) })}
        </p>
      ) : null}
      {selection.verdict ? (
        <div className="flex flex-col gap-1 rounded-md border p-2">
          <p>
            {t("judge", {
              best: labelOf(
                selection.anonymized?.[selection.verdict.best] ?? selection.verdict.best
              ),
              confidence: t(`confidence.${selection.verdict.confidence}`),
            })}
          </p>
          <ol className="list-decimal pl-5 text-xs">
            {selection.verdict.ranking.map((id) => {
              const label = selection.anonymized?.[id] ?? id
              return (
                <li key={id}>
                  <span className="font-medium">{labelOf(label)}</span>
                  {selection.verdict?.evidence[id] ? (
                    <span className="text-muted-foreground">
                      {" "}
                      — {selection.verdict.evidence[id]}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ol>
        </div>
      ) : null}
    </div>
  )
}

export interface HarnessDecisionPanelProps {
  run: Pick<HarnessEvolutionRun, "decision" | "status" | "config" | "adoption" | "projectId">
  selection?: HarnessSelectionRecord
  busy?: boolean
  onApprove?: (options: { setAsWorkspaceDefault: boolean }) => void
  onReject?: () => void
}

export function HarnessDecisionPanel({
  run,
  selection,
  busy,
  onApprove,
  onReject,
}: HarnessDecisionPanelProps) {
  const t = useTranslations("harnessEvolution.decision")
  const labelOf = useStepLabel()
  const [workspaceDefault, setWorkspaceDefault] = useState(false)
  const decision = run.decision
  if (!decision) {
    return <p className="text-sm text-muted-foreground">{t("pending")}</p>
  }
  const awaiting = run.status === "awaiting_approval"
  return (
    <div className="flex flex-col gap-3" data-testid="harness-decision">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={decision.outcome === "adopt" ? "default" : "outline"}>
          {decision.outcome === "adopt"
            ? t("adopt", { label: labelOf(decision.chosenLabel ?? "") })
            : t("keepBase")}
        </Badge>
        {decision.risk ? (
          <Badge variant={RISK_VARIANT[decision.risk]} data-testid="harness-decision-risk">
            {t(`risk.${decision.risk}`)}
          </Badge>
        ) : null}
        <Badge variant="outline">{t(`scope.${run.config.scope}`)}</Badge>
      </div>
      <p className="text-sm">{decision.reason}</p>
      {decision.riskReasons?.length ? (
        <ul
          className="list-disc pl-5 text-xs text-muted-foreground"
          data-testid="harness-risk-reasons"
        >
          {decision.riskReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      {selection ? <HarnessSelectionView selection={selection} /> : null}
      {run.adoption ? (
        <p className="text-xs text-muted-foreground" data-testid="harness-adoption">
          {run.adoption.rolledBackAt
            ? t("rolledBack")
            : t(run.adoption.approvedBy === "person" ? "adoptedByPerson" : "adoptedAutomatically", {
                scope: t(`scope.${run.adoption.scope}`),
              })}
          {run.adoption.variantCreated ? ` ${t("variantCreated")}` : ""}
        </p>
      ) : null}
      {awaiting && onApprove && onReject ? (
        <div className="flex flex-col gap-2 rounded-md border border-warning/50 bg-warning/5 p-3">
          <p className="text-sm font-medium">{t("approvalNeeded")}</p>
          {run.config.scope === "workspace" && run.projectId ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id="harness-workspace-default"
                checked={workspaceDefault}
                onCheckedChange={(v) => setWorkspaceDefault(v === true)}
              />
              <Label htmlFor="harness-workspace-default" className="text-sm font-normal">
                {t("setWorkspaceDefault")}
              </Label>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onApprove({ setAsWorkspaceDefault: workspaceDefault })}
              data-testid="harness-approve"
            >
              {t("approve")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onReject}
              data-testid="harness-reject"
            >
              {t("reject")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
