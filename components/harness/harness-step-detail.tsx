"use client"

/**
 * One step of a run: its evidence (rollouts), the harness it produced and
 * the editor's notes (proposals and compositions), or the selection and
 * reflection records.
 */

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { formatMs, formatTokens, formatUsd } from "@/lib/observability/format-utils"
import type { HarnessEvolutionRun, HarnessEvolutionStep } from "@/types/harness/evolution"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { HarnessDecisionPanel } from "./harness-decision-panel"
import { HarnessEvidenceView } from "./harness-evidence-view"
import { HarnessReflectionPanel } from "./harness-reflection-panel"
import { useStepLabel } from "./harness-run-timeline"
import { HarnessSnapshotDiff } from "./harness-snapshot-diff"

export interface HarnessStepDetailProps {
  run: HarnessEvolutionRun
  step: HarnessEvolutionStep
  snapshots: ReadonlyMap<string, HarnessSnapshotV1>
  onOpenExperience?: (id: string) => void
}

export function HarnessStepDetail({
  run,
  step,
  snapshots,
  onOpenExperience,
}: HarnessStepDetailProps) {
  const t = useTranslations("harnessEvolution")
  const labelOf = useStepLabel()
  const base = run.baseSnapshotId ? snapshots.get(run.baseSnapshotId) : undefined
  const produced = step.snapshotId ? snapshots.get(step.snapshotId) : undefined
  const isStage = step.kind === "propose" || step.kind === "compose"
  const duration =
    step.startedAt !== undefined && step.endedAt !== undefined
      ? step.endedAt - step.startedAt
      : undefined
  return (
    <div className="flex flex-col gap-4" data-testid="harness-step-detail">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{labelOf(step.label)}</h3>
          <Badge variant={step.status === "failed" ? "destructive" : "outline"}>
            {t(`stepStatus.${step.status}`)}
          </Badge>
          {step.dim ? <Badge variant="secondary">{step.dim}</Badge> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("stepDetail.meta", {
            attempts: step.attempts,
            tokens: formatTokens(step.inputTokens + step.outputTokens),
            cost: step.costUsd === undefined ? "—" : formatUsd(step.costUsd),
            duration: duration === undefined ? "—" : formatMs(duration),
          })}
        </p>
        {step.cacheHitOf ? (
          <p className="text-xs text-muted-foreground">
            {t("stepDetail.reused", { from: step.cacheHitOf.split(":").slice(1).join(":") })}
          </p>
        ) : null}
        {step.error ? <p className="text-sm text-destructive">{step.error}</p> : null}
      </header>

      {step.evidence ? <HarnessEvidenceView evidence={step.evidence} /> : null}

      {isStage ? (
        <div className="flex flex-col gap-3">
          {step.fellBack ? (
            <p className="text-sm text-muted-foreground">{t("stepDetail.fellBack")}</p>
          ) : step.keptBase ? (
            <p className="text-sm text-muted-foreground">{t("stepDetail.keptBase")}</p>
          ) : null}
          {step.notes ? (
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-medium">{t("stepDetail.notes")}</h4>
              <p className="whitespace-pre-wrap text-sm">{step.notes}</p>
            </div>
          ) : null}
          {base && produced ? (
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-medium">{t("stepDetail.changesFromBase")}</h4>
              <HarnessSnapshotDiff before={base.components} after={produced.components} />
            </div>
          ) : step.snapshotId ? (
            <p className="text-xs text-muted-foreground">{t("stepDetail.snapshotMissing")}</p>
          ) : null}
        </div>
      ) : null}

      {step.kind === "select" ? (
        <HarnessDecisionPanel
          run={run}
          {...(step.selection ? { selection: step.selection } : {})}
        />
      ) : null}
      {step.kind === "reflect" && step.reflection ? (
        <HarnessReflectionPanel
          reflection={step.reflection}
          {...(onOpenExperience ? { onOpenExperience } : {})}
        />
      ) : null}
    </div>
  )
}
