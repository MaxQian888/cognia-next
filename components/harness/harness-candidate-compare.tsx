"use client"

/**
 * Two harnesses of a run side by side: their rollouts' outcomes and the
 * file-level difference between them. Any pair can be compared, the base
 * included, so a person can check the selection rather than take it on trust.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { BASE } from "@/lib/harness/recursion"
import { comparableLabels, rolloutOf } from "@/lib/harness/run-view"
import { formatTokens, formatUsd } from "@/lib/observability/format-utils"
import type { HarnessEvolutionRun, HarnessEvolutionStep } from "@/types/harness/evolution"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { useStepLabel } from "./harness-run-timeline"
import { HarnessSnapshotDiff } from "./harness-snapshot-diff"

export interface HarnessCandidateCompareProps {
  run: Pick<HarnessEvolutionRun, "baseSnapshotId" | "decision">
  steps: readonly HarnessEvolutionStep[]
  snapshots: ReadonlyMap<string, HarnessSnapshotV1>
}

function snapshotIdOf(
  label: string,
  run: HarnessCandidateCompareProps["run"],
  steps: readonly HarnessEvolutionStep[]
): string | undefined {
  if (label === BASE) return run.baseSnapshotId
  return steps.find((s) => s.label === label)?.snapshotId
}

function RolloutSummary({
  label,
  steps,
}: {
  label: string
  steps: readonly HarnessEvolutionStep[]
}) {
  const t = useTranslations("harnessEvolution.compare")
  const rollout = rolloutOf(label, steps)
  const evidence = rollout?.evidence
  if (!evidence) {
    return <p className="text-xs text-muted-foreground">{t("notRolled")}</p>
  }
  const passed = evidence.validation.filter((v) => v.status === "passed").length
  return (
    <dl
      className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs"
      data-testid={`harness-compare-summary-${label}`}
    >
      <dt className="text-muted-foreground">{t("delivered")}</dt>
      <dd>{evidence.delivered ? t("yes") : t("no")}</dd>
      <dt className="text-muted-foreground">{t("checks")}</dt>
      <dd className="tabular-nums">
        {t("checksPassed", { passed, total: evidence.validation.length })}
      </dd>
      <dt className="text-muted-foreground">{t("toolFailures")}</dt>
      <dd className="tabular-nums">{evidence.metrics.toolFailures}</dd>
      <dt className="text-muted-foreground">{t("tokens")}</dt>
      <dd className="tabular-nums">
        {formatTokens(evidence.metrics.inputTokens + evidence.metrics.outputTokens)}
      </dd>
      <dt className="text-muted-foreground">{t("cost")}</dt>
      <dd className="tabular-nums">
        {evidence.metrics.costUsd === undefined ? "—" : formatUsd(evidence.metrics.costUsd)}
      </dd>
    </dl>
  )
}

export function HarnessCandidateCompare({ run, steps, snapshots }: HarnessCandidateCompareProps) {
  const t = useTranslations("harnessEvolution.compare")
  const labelOf = useStepLabel()
  const labels = comparableLabels(steps)
  const chosen = run.decision?.chosenLabel
  const [left, setLeft] = useState(BASE)
  const [right, setRight] = useState(
    chosen && labels.includes(chosen) ? chosen : (labels[labels.length - 1] ?? BASE)
  )
  if (labels.length < 2) {
    return <p className="text-sm text-muted-foreground">{t("nothingYet")}</p>
  }
  const leftSnap = snapshots.get(snapshotIdOf(left, run, steps) ?? "")
  const rightSnap = snapshots.get(snapshotIdOf(right, run, steps) ?? "")
  const picker = (value: string, onChange: (v: string) => void, aria: string) => (
    <NativeSelect
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={aria}
      size="sm"
    >
      {labels.map((label) => (
        <NativeSelectOption key={label} value={label}>
          {label === BASE ? t("base") : labelOf(label)}
          {label === chosen ? ` · ${t("chosen")}` : ""}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )
  return (
    <div className="flex flex-col gap-4" data-testid="harness-compare">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          {picker(left, setLeft, t("left"))}
          <RolloutSummary label={left} steps={steps} />
        </div>
        <div className="flex flex-col gap-2">
          {picker(right, setRight, t("right"))}
          <RolloutSummary label={right} steps={steps} />
        </div>
      </div>
      {leftSnap && rightSnap ? (
        <HarnessSnapshotDiff before={leftSnap.components} after={rightSnap.components} />
      ) : (
        <p className="text-xs text-muted-foreground">{t("loading")}</p>
      )}
    </div>
  )
}
