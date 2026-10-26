"use client"

/**
 * One Harness Evolution run, live: its state and the verbs it allows, the
 * budget as it is spent, the plan with every step's evidence, a comparison of
 * any two harnesses, the selection, and what the reflection learned.
 */

import { useMemo, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { BanIcon, PlayIcon, Undo2Icon } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import {
  useHarnessLiveLedger,
  useHarnessRun,
  useHarnessSnapshots,
  useHarnessSteps,
} from "@/hooks/harness/use-harness-data"
import { useHarnessRunActions } from "@/hooks/harness/use-harness-run-actions"
import { runActions } from "@/lib/harness/run-view"
import { isHarnessRunActiveHere } from "@/lib/harness/runtime/run-control"
import type { HarnessEvolutionRun, HarnessEvolutionStep } from "@/types/harness/evolution"
import { HarnessBudgetMeters } from "./harness-budget-meters"
import { HarnessCandidateCompare } from "./harness-candidate-compare"
import { HarnessDecisionPanel } from "./harness-decision-panel"
import { HarnessReflectionPanel } from "./harness-reflection-panel"
import { HarnessRunStatusBadge } from "./harness-run-status-badge"
import { HarnessRunTimeline } from "./harness-run-timeline"
import { HarnessStepDetail } from "./harness-step-detail"

export interface HarnessRunViewerProps {
  runId: string
  onOpenExperience?: (id: string) => void
}

export function HarnessRunViewer({ runId, onOpenExperience }: HarnessRunViewerProps) {
  const t = useTranslations("harnessEvolution.viewer")
  const run = useHarnessRun(runId)
  const steps = useHarnessSteps(runId)
  if (run === undefined) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }
  if (run === null) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="harness-run-missing">
        {t("missing")}
      </p>
    )
  }
  return <HarnessRunViewerBody run={run} steps={steps} onOpenExperience={onOpenExperience} />
}

function HarnessRunViewerBody({
  run,
  steps,
  onOpenExperience,
}: {
  run: HarnessEvolutionRun
  steps: HarnessEvolutionStep[]
  onOpenExperience?: (id: string) => void
}) {
  const t = useTranslations("harnessEvolution")
  const format = useFormatter()
  const now = useNowTicker()
  const ledger = useHarnessLiveLedger(run, steps) ?? run.ledger
  const snapshotIds = useMemo(
    () => [
      ...(run.baseSnapshotId ? [run.baseSnapshotId] : []),
      ...steps.flatMap((s) => (s.snapshotId ? [s.snapshotId] : [])),
    ],
    [run.baseSnapshotId, steps]
  )
  const snapshots = useHarnessSnapshots(snapshotIds)
  const actions = useHarnessRunActions(run.id)
  const allowed = runActions(run, now, isHarnessRunActiveHere(run.id))
  const [selected, setSelected] = useState<string | undefined>()
  const [confirm, setConfirm] = useState<"cancel" | "rollback" | null>(null)
  const selectedStep = steps.find((s) => s.label === selected)
  const selectStep = steps.find((s) => s.kind === "select")
  const reflectStep = steps.find((s) => s.kind === "reflect")

  return (
    <div className="flex flex-col gap-5" data-testid="harness-run-viewer" data-status={run.status}>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{run.task.title}</h2>
            <p className="text-xs text-muted-foreground">
              {t("viewer.subtitle", {
                agent: run.characterName,
                trigger: t(`trigger.${run.trigger}`),
                mode: t(`mode.${run.config.mode}`),
                k: run.config.k,
                created: format.dateTime(run.createdAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <HarnessRunStatusBadge status={run.status} />
            {allowed.resume ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actions.busy !== null}
                onClick={() => void actions.resume()}
                data-testid="harness-resume"
              >
                <PlayIcon className="size-3.5" aria-hidden />
                {t("viewer.resume")}
              </Button>
            ) : null}
            {allowed.rollback ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actions.busy !== null}
                onClick={() => setConfirm("rollback")}
                data-testid="harness-rollback"
              >
                <Undo2Icon className="size-3.5" aria-hidden />
                {t("viewer.rollback")}
              </Button>
            ) : null}
            {allowed.cancel ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={actions.busy !== null}
                onClick={() => setConfirm("cancel")}
                data-testid="harness-cancel"
              >
                <BanIcon className="size-3.5" aria-hidden />
                {t("viewer.cancel")}
              </Button>
            ) : null}
          </div>
        </div>
        {run.error ? (
          <p className="text-sm text-destructive" data-testid="harness-run-error">
            {run.error}
          </p>
        ) : null}
        {run.stopReason ? (
          <p className="text-sm text-muted-foreground">
            {t("viewer.stopped", { reason: run.stopReason })}
          </p>
        ) : null}
        {run.status === "interrupted" ? (
          <p className="text-sm text-muted-foreground">{t("viewer.interruptedHint")}</p>
        ) : null}
      </header>

      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer font-medium">{t("viewer.task")}</summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="whitespace-pre-wrap">{run.task.prompt}</p>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">{t(`isolation.${run.task.isolation}`)}</Badge>
            <Badge variant="outline">{run.task.domain}</Badge>
            {run.task.checks.map((c, i) => (
              <Badge key={`${c.kind}-${i}`} variant="secondary">
                {t(`checkKind.${c.kind}`)}
              </Badge>
            ))}
          </div>
          {run.retrievedExperienceIds?.length ? (
            <p className="text-xs text-muted-foreground">
              {t("viewer.retrieved", { count: run.retrievedExperienceIds.length })}
            </p>
          ) : null}
        </div>
      </details>

      <HarnessBudgetMeters
        ledger={ledger}
        budget={run.config.budget}
        {...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {})}
        {...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {})}
        now={now}
      />

      <Tabs defaultValue={run.status === "awaiting_approval" ? "decision" : "timeline"}>
        <TabsList>
          <TabsTrigger value="timeline">{t("viewer.tabs.timeline")}</TabsTrigger>
          <TabsTrigger value="compare">{t("viewer.tabs.compare")}</TabsTrigger>
          <TabsTrigger value="decision">{t("viewer.tabs.decision")}</TabsTrigger>
          <TabsTrigger value="reflection">{t("viewer.tabs.reflection")}</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="mt-3">
          <div className="grid gap-4 lg:grid-cols-[minmax(14rem,18rem)_1fr]">
            <HarnessRunTimeline
              run={run}
              steps={steps}
              selectedLabel={selected}
              onSelect={setSelected}
            />
            <div className="min-w-0">
              {selectedStep ? (
                <HarnessStepDetail
                  run={run}
                  step={selectedStep}
                  snapshots={snapshots}
                  {...(onOpenExperience ? { onOpenExperience } : {})}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t("viewer.pickStep")}</p>
              )}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="compare" className="mt-3">
          <HarnessCandidateCompare run={run} steps={steps} snapshots={snapshots} />
        </TabsContent>
        <TabsContent value="decision" className="mt-3">
          <HarnessDecisionPanel
            run={run}
            {...(selectStep?.selection ? { selection: selectStep.selection } : {})}
            busy={actions.busy !== null}
            onApprove={(options) => void actions.approve(options)}
            onReject={() => void actions.reject()}
          />
        </TabsContent>
        <TabsContent value="reflection" className="mt-3">
          {reflectStep?.reflection ? (
            <HarnessReflectionPanel
              reflection={reflectStep.reflection}
              {...(onOpenExperience ? { onOpenExperience } : {})}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("viewer.noReflection")}</p>
          )}
        </TabsContent>
      </Tabs>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent data-testid="harness-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "rollback"
                ? t("viewer.confirmRollbackTitle")
                : t("viewer.confirmCancelTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "rollback"
                ? t("viewer.confirmRollbackBody")
                : t("viewer.confirmCancelBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("viewer.keep")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="harness-confirm-action"
              onClick={() => {
                const which = confirm
                setConfirm(null)
                if (which === "rollback") void actions.rollback()
                else if (which === "cancel") void actions.cancel()
              }}
            >
              {confirm === "rollback" ? t("viewer.rollback") : t("viewer.cancel")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
