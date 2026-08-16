"use client"

/**
 * The Creator workbench (ADR-0117, Phase 3).
 *
 * Composition, not orchestration: the grant lives in the store, progress lives
 * in the workflow run event log, and the gating rules live in
 * `lib/creator/steps.ts`. This component reads all three and renders them. It
 * deliberately holds no step state of its own — a second copy of "has the
 * permission gate passed?" living in React state is exactly how a UI ends up
 * enabling a write the durable log says was never approved.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { AuthoringRootCard } from "./authoring-root-card"
import { CreatorStepRail } from "./creator-step-rail"
import { PermissionDiffPanel } from "./permission-diff-panel"
import { ReviewPanel } from "./review-panel"
import { useCreatorStore } from "@/stores/creator/creator-store"
import { computePermissionDiff } from "@/lib/creator/permission-diff"
import { CREATOR_RUN_ID_PREFIX, readCreatorProgress } from "@/lib/creator/run-log"
import { canWrite } from "@/lib/creator/steps"
import { createCreatorHandlers, createStaticRequirementsHandler } from "@/lib/creator/handlers"
import { createAgentPorts } from "@/lib/creator/agent-ports"
import { CREATOR_AGENT_AUTHORITY, createCreatorTurnRunner } from "@/lib/creator/agent-turn-runner"
import { useCreatorRun } from "@/hooks/creator/use-creator-run"
import { CREATOR_ARTIFACT_KINDS } from "@/types/creator"
import type { CreatorArtifactKind, CreatorReviewVerdict, CreatorStepId } from "@/types/creator"

export interface CreatorWorkbenchProps {
  /** Capabilities the currently-installed artifact holds. */
  currentCapabilities?: readonly string[]
  /** Capabilities the proposal declares. Empty until step 3 has run. */
  proposedCapabilities?: readonly string[]
  verdict?: CreatorReviewVerdict | null
  activeStep?: CreatorStepId | null
}

export function CreatorWorkbench({
  currentCapabilities = [],
  proposedCapabilities = [],
  verdict = null,
  activeStep = null,
}: CreatorWorkbenchProps) {
  const t = useTranslations("creator")
  const root = useCreatorStore((state) => state.authoringRoot)
  const artifactKind = useCreatorStore((state) => state.artifactKind)
  const setArtifactKind = useCreatorStore((state) => state.setArtifactKind)
  const activeRunId = useCreatorStore((state) => state.activeRunId)
  const startRun = useCreatorStore((state) => state.startRun)
  const endRun = useCreatorStore((state) => state.endRun)
  const approvedAdditions = useCreatorStore((state) => state.approvedAdditions)
  const approveAdditions = useCreatorStore((state) => state.approveAdditions)
  const [runSeed, setRunSeed] = useState(0)

  const progress = useLiveQuery(
    () => (activeRunId ? readCreatorProgress(activeRunId) : Promise.resolve(null)),
    [activeRunId, runSeed],
    null
  )

  const advanceState = useMemo(
    () => ({
      completed: progress?.completed ?? [],
      approvals: progress?.approvals ?? [],
    }),
    [progress]
  )

  const diff = useMemo(
    () => computePermissionDiff({ current: currentCapabilities, proposed: proposedCapabilities }),
    [currentCapabilities, proposedCapabilities]
  )

  const [requirements, setRequirements] = useState("")
  // Ports this host can serve. `verify` and `deliver` still fail with a named
  // reason — they need a host shell and an installer — rather than pretending
  // to succeed.
  const runHandlers = useMemo(() => {
    const runTurn = createCreatorTurnRunner()
    return createCreatorHandlers({
      collectRequirements: createStaticRequirementsHandler(requirements),
      ...createAgentPorts({ runTurn, reviewerAuthority: CREATOR_AGENT_AUTHORITY }),
    })
  }, [requirements])
  const run = useCreatorRun({ handlers: runHandlers })

  const advance = useCallback(() => {
    if (!activeRunId || !root) return
    void run.advance(
      {
        runId: activeRunId,
        root,
        artifactKind,
        requirements,
        currentCapabilities,
        approvedAdditions,
      },
      advanceState
    )
    setRunSeed((seed) => seed + 1)
  }, [
    activeRunId,
    root,
    artifactKind,
    requirements,
    currentCapabilities,
    approvedAdditions,
    advanceState,
    run,
  ])

  const begin = useCallback(() => {
    // The run id is the join key between this surface and the workflow Runs
    // timeline, so it uses the shared prefix rather than an ad-hoc scheme.
    startRun(`${CREATOR_RUN_ID_PREFIX}${Date.now().toString(36)}`)
    setRunSeed((seed) => seed + 1)
  }, [startRun])

  const writesAllowed = canWrite(advanceState)

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>

      <AuthoringRootCard />

      <section className="space-y-2 rounded-lg border p-4">
        <label className="text-sm font-medium" htmlFor="creator-artifact-kind">
          {t("artifact.label")}
        </label>
        <Select
          value={artifactKind}
          onValueChange={(value) => setArtifactKind(value as CreatorArtifactKind)}
          disabled={Boolean(activeRunId)}
        >
          <SelectTrigger id="creator-artifact-kind" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CREATOR_ARTIFACT_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`artifact.kinds.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {activeRunId ? (
          <div className="flex items-center justify-between gap-2 pt-1">
            <p className="truncate text-xs text-muted-foreground">
              {t("run.active", { runId: activeRunId })}
            </p>
            <Button size="sm" variant="ghost" onClick={endRun}>
              {t("run.end")}
            </Button>
          </div>
        ) : (
          <div className="space-y-1 pt-1">
            <Button size="sm" onClick={begin} disabled={!root}>
              {t("run.start")}
            </Button>
            {!root ? <p className="text-xs text-muted-foreground">{t("run.needsRoot")}</p> : null}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-sm font-medium">{t("steps.title")}</h2>
        <CreatorStepRail
          state={advanceState}
          failed={progress?.failed}
          activeStep={run.activeStep ?? activeStep}
        />

        <div className="space-y-1.5 border-t pt-3">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor="creator-requirements"
          >
            {t("run.requirements")}
          </label>
          <Textarea
            id="creator-requirements"
            value={requirements}
            onChange={(event) => setRequirements(event.target.value)}
            placeholder={t("run.requirementsPlaceholder")}
            rows={2}
            disabled={run.busy}
          />
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={advance} disabled={!activeRunId || !root || run.busy}>
              {t("run.advance")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("run.advanceHint")}</p>
          </div>
          {/*
            The executor stops rather than prompts, so the reason it stopped is
            the only thing telling the user what to do next — a missing approval,
            a failing check, or a port this host cannot serve.
          */}
          {run.lastOutcome && run.lastOutcome.status !== "completed" ? (
            <p className="text-xs text-amber-600 dark:text-amber-500" role="status">
              {t("run.stopped", {
                step: run.lastOutcome.step ? t(`steps.${run.lastOutcome.step}`) : "—",
                detail: run.lastOutcome.detail ?? "",
              })}
            </p>
          ) : null}
        </div>
      </section>

      <PermissionDiffPanel
        diff={diff}
        approvedAdditions={approvedAdditions}
        onApprove={approveAdditions}
        disabled={!activeRunId}
      />

      <ReviewPanel verdict={verdict} />

      {/* Surfaced as plain text so the guarantee is legible without opening a step. */}
      {!writesAllowed ? (
        <p className="text-xs text-muted-foreground">{t("permissions.writesBlocked")}</p>
      ) : null}
    </div>
  )
}

export default CreatorWorkbench
