"use client"

import { useEffect, useId, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { gitBranches } from "@/lib/git/commands"
import type { ScmHost } from "@/lib/scm/host"
import type { IntegrationOutcome } from "@/lib/scm/integration/orchestrator"
import type {
  AgentChangeset,
  IntegrationAnalysis,
  IntegrationConflictPolicy,
  IntegrationStrategy,
} from "@/lib/scm/types"
import type { GitBranch } from "@/types/git"
import type { AgentChangesActions } from "@/hooks/scm/use-agent-changesets"
import { integrationReasonKey } from "./presentation"

interface Props {
  rootDir: string
  projectId: string | null
  changesets: AgentChangeset[]
  host: ScmHost
  actions: Pick<AgentChangesActions, "integrate" | "busy" | "error">
  onClose: () => void
}

/** Mounted only while open; a new selection starts a fresh preview. */
export function IntegrateDialog({ rootDir, projectId, changesets, host, actions, onClose }: Props) {
  const t = useTranslations("agentChanges")
  const id = useId()
  const [branches, setBranches] = useState<GitBranch[] | null>(null)
  const [branchError, setBranchError] = useState(false)
  const [chosenBranch, setChosenBranch] = useState<string | null>(null)
  const [strategy, setStrategy] = useState<IntegrationStrategy>("merge")
  const [onConflict, setOnConflict] = useState<IntegrationConflictPolicy>("skip")
  const [preview, setPreview] = useState<{
    key: string
    analysis: IntegrationAnalysis | null
  } | null>(null)
  const [retry, setRetry] = useState(0)
  const [outcome, setOutcome] = useState<IntegrationOutcome | null>(null)
  const branch = chosenBranch ?? branches?.find((item) => item.isCurrent)?.name ?? ""
  const ids = changesets.map((changeset) => changeset.changesetId)
  const idsKey = JSON.stringify(ids)
  const targetRef = `refs/heads/${branch}`
  const previewKey = JSON.stringify([idsKey, targetRef, retry])
  const currentPreview = preview?.key === previewKey ? preview : null

  useEffect(() => {
    let cancelled = false
    gitBranches(rootDir).then(
      (items) => {
        if (!cancelled) {
          setBranches(items.filter((item) => !item.isRemote))
          setBranchError(false)
        }
      },
      () => {
        if (!cancelled) setBranchError(true)
      }
    )
    return () => {
      cancelled = true
    }
  }, [rootDir, retry])

  useEffect(() => {
    if (!branch) return
    let cancelled = false
    host.analyzeIntegration(JSON.parse(idsKey) as string[], targetRef).then(
      (analysis) => {
        if (!cancelled) setPreview({ key: previewKey, analysis })
      },
      () => {
        if (!cancelled) setPreview({ key: previewKey, analysis: null })
      }
    )
    return () => {
      cancelled = true
    }
  }, [branch, host, idsKey, previewKey, targetRef])

  const analysis = currentPreview?.analysis
  const titleFor = (changesetId: string) =>
    changesetId === "target"
      ? t("integrate.targetTip")
      : (changesets.find((item) => item.changesetId === changesetId)?.title ?? changesetId)
  const submit = async () => {
    if (!analysis || analysis.cycles.length > 0 || !branch || ids.length === 0) return
    const result = await actions.integrate({
      changesetIds: ids,
      targetRef,
      strategy,
      onConflict,
      requiredChecks: [...new Set(changesets.flatMap((changeset) => changeset.requiredChecks))],
    })
    if (result) setOutcome(result)
  }
  const loadFailed = branchError || (currentPreview !== null && !analysis)

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !actions.busy) onClose()
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("integrate.title")}</DialogTitle>
          <DialogDescription>{t("integrate.description")}</DialogDescription>
        </DialogHeader>
        {!projectId && (
          <p role="note" className="text-sm text-muted-foreground">
            {t("noProject")}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor={`${id}-branch`}>{t("integrate.target")}</Label>
            <NativeSelect
              id={`${id}-branch`}
              data-testid="integration-target"
              value={branch}
              onChange={(event) => setChosenBranch(event.target.value)}
              disabled={actions.busy || !!outcome || !branches || branchError}
              wrapperClassName="w-full"
            >
              <NativeSelectOption value="" disabled>
                {t("integrate.chooseBranch")}
              </NativeSelectOption>
              {branches?.map((item) => (
                <NativeSelectOption key={item.name} value={item.name}>
                  {item.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-strategy`}>{t("integrate.strategy")}</Label>
            <NativeSelect
              id={`${id}-strategy`}
              data-testid="integration-strategy"
              value={strategy}
              onChange={(event) => setStrategy(event.target.value as IntegrationStrategy)}
              disabled={actions.busy || !!outcome}
              wrapperClassName="w-full"
            >
              <NativeSelectOption value="merge">{t("integrate.merge")}</NativeSelectOption>
              <NativeSelectOption value="rebase">{t("integrate.rebase")}</NativeSelectOption>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-conflict`}>{t("integrate.onConflict")}</Label>
            <NativeSelect
              id={`${id}-conflict`}
              data-testid="integration-conflict-policy"
              value={onConflict}
              onChange={(event) => setOnConflict(event.target.value as IntegrationConflictPolicy)}
              disabled={actions.busy || !!outcome}
              wrapperClassName="w-full"
            >
              <NativeSelectOption value="skip">{t("integrate.skip")}</NativeSelectOption>
              <NativeSelectOption value="stop">{t("integrate.stop")}</NativeSelectOption>
            </NativeSelect>
          </div>
        </div>
        {loadFailed ? (
          <div role="alert">
            <p>{t("errors.preview")}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={actions.busy}
              onClick={() => setRetry((value) => value + 1)}
            >
              {t("retry")}
            </Button>
          </div>
        ) : !branches || (branch && !currentPreview) ? (
          <p role="status">{t("loading")}</p>
        ) : branches.length === 0 ? (
          <p>{t("integrate.noBranches")}</p>
        ) : null}
        {analysis && (
          <div className="space-y-3 text-sm" data-testid="integration-analysis">
            <h3 className="font-medium">{t("integrate.order")}</h3>
            <ol className="list-inside list-decimal">
              {analysis.order.map((item) => (
                <li key={item}>{titleFor(item)}</li>
              ))}
            </ol>
            {analysis.prediction === "overlapOnly" && (
              <p role="note">{t("integrate.overlapOnly")}</p>
            )}
            {analysis.cycles.length > 0 && (
              <div role="alert">
                <p>{t("integrationReasons.cycles")}</p>
                {analysis.cycles.map((cycle, index) => (
                  <p key={index}>{cycle.map(titleFor).join(" → ")}</p>
                ))}
              </div>
            )}
            {(["predictedConflicts", "overlaps"] as const).map((kind) => (
              <div key={kind}>
                <h3 className="font-medium">{t(`integrate.${kind}`)}</h3>
                {analysis[kind].length === 0 && (
                  <p className="text-muted-foreground">{t("integrate.none")}</p>
                )}
                <ul>
                  {analysis[kind].map((overlap, index) => (
                    <li key={index} className="mt-1 rounded border p-2">
                      <p>
                        {t("integrate.between", { a: titleFor(overlap.a), b: titleFor(overlap.b) })}
                      </p>
                      <ul className="break-all font-mono text-xs">
                        {overlap.files.map((file) => (
                          <li key={file}>{file}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {actions.error && <p role="alert">{t("errors.action")}</p>}
        {outcome && (
          <section
            aria-live="polite"
            className="space-y-2 rounded border p-3 text-sm"
            data-testid="integration-outcome"
            data-outcome={outcome.kind}
          >
            <h3 className="font-medium">{t(`outcomes.${outcome.kind}`)}</h3>
            {outcome.reason && (
              <p>{t(integrationReasonKey(outcome.reason), { code: outcome.reason })}</p>
            )}
            {outcome.run?.resultSha && (
              <p>{t("runs.result", { sha: outcome.run.resultSha.slice(0, 8) })}</p>
            )}
            {outcome.dropped.length > 0 && (
              <div>
                <h4>{t("integrate.dropped")}</h4>
                <ul>
                  {outcome.dropped.map((item) => (
                    <li key={item}>{titleFor(item)}</li>
                  ))}
                </ul>
              </div>
            )}
            {outcome.run?.items
              .filter((item) => item.outcome === "conflicted")
              .map((item) => (
                <div key={item.changesetId}>
                  <h4>{t("integrate.conflictedItem", { title: titleFor(item.changesetId) })}</h4>
                  <ul className="break-all font-mono text-xs">
                    {item.conflictFiles.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                </div>
              ))}
          </section>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={actions.busy} onClick={onClose}>
            {t("close")}
          </Button>
          {!outcome && (
            <Button
              disabled={
                actions.busy ||
                loadFailed ||
                !analysis ||
                analysis.cycles.length > 0 ||
                !branch ||
                ids.length === 0
              }
              onClick={() => void submit()}
              data-testid="integration-submit"
            >
              {actions.busy ? t("integrate.running") : t("actions.integrate")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
