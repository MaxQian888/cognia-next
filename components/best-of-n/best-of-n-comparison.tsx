"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { DiffViewer } from "@/components/source-control/diff-viewer"
import { ChangesetDetail } from "@/components/source-control/agent-changes/changeset-detail"
import { useBestOfNRun } from "@/hooks/best-of-n/use-best-of-n-run"
import { listBestOfNRuns } from "@/lib/best-of-n/projection"
import {
  pickBestOfNCandidate,
  runChecksBestOfNCandidate,
  publishBestOfNCandidate,
  archiveBestOfN,
} from "@/lib/best-of-n/publication"
import { cancelBestOfN } from "@/lib/best-of-n/service"
import { createScmHost } from "@/lib/scm/host"
import { getSourceControlService } from "@/lib/scm/service"
import { useDockTabsStore } from "@/stores/artifact/dock-tabs-store"
import type { GitDiff } from "@/types/git"

export function BestOfNComparisonPanel({ sessionId }: { sessionId: string | null }) {
  const t = useTranslations("best-of-n-ui")
  const selected = useDockTabsStore((state) =>
    sessionId ? state.bySession[sessionId]?.bestOfNGroupId : null
  )
  const runs = useLiveQuery(() => (sessionId ? listBestOfNRuns(sessionId) : []), [sessionId])
  const groupId = selected ?? runs?.[0]?.id ?? null
  return (
    <div className="h-full overflow-auto p-3">
      <h2 className="mb-3 font-medium">{t("title")}</h2>
      {runs && runs.length > 1 && (
        <NativeSelect
          aria-label={t("run")}
          value={groupId ?? ""}
          onChange={(event) =>
            sessionId && useDockTabsStore.getState().setBestOfNGroup(sessionId, event.target.value)
          }
        >
          {runs.map((run) => (
            <NativeSelectOption key={run.id} value={run.id}>
              {run.group.targetRef}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
      {groupId ? <BestOfNComparison key={groupId} groupId={groupId} /> : <p>{t("empty")}</p>}
    </div>
  )
}

export function BestOfNComparison({ groupId }: { groupId: string }) {
  const t = useTranslations("best-of-n-ui")
  const { summary, refresh, canManage, failed } = useBestOfNRun(groupId)
  const host = useMemo(() => createScmHost(), [])
  const [busy, setBusy] = useState(false)
  const operation = useRef(false)
  const [error, setError] = useState(false)
  const [diagnostic, setDiagnostic] = useState<string | null>(null)
  const [archiveFailure, setArchiveFailure] = useState<string | null>(null)
  const [confirmPublish, setConfirmPublish] = useState<string | null>(null)
  const [file, setFile] = useState<{ candidateId: string; path: string; head: string } | null>(null)
  const [diff, setDiff] = useState<{ key: string; value: GitDiff } | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffRetry, setDiffRetry] = useState(0)
  const group = summary?.group
  const diffKey = file ? `${file.candidateId}:${file.head}:${file.path}` : null
  const sourceRoot = group?.sourceRoot
  const baseSha = group?.baseSha
  useEffect(() => {
    if (!file || !sourceRoot || !baseSha || !diffKey) return
    let active = true
    getSourceControlService()
      .diffRevisionFile(sourceRoot, baseSha, file.head, file.path)
      .then(
        (value) => {
          if (active) {
            setDiff({ key: diffKey, value })
            setDiffError(null)
          }
        },
        () => {
          if (active) setDiffError(diffKey)
        }
      )
    return () => {
      active = false
    }
  }, [file, sourceRoot, baseSha, diffKey, diffRetry])

  const mutate = async (action: () => Promise<unknown>) => {
    if (operation.current || !canManage) return
    operation.current = true
    setBusy(true)
    setError(false)
    setDiagnostic(null)
    setArchiveFailure(null)
    setConfirmPublish(null)
    try {
      const result = await action()
      if (result && typeof result === "object") {
        if ("archiveError" in result && typeof result.archiveError === "string")
          setArchiveFailure(result.archiveError)
        if (
          "outcome" in result &&
          result.outcome &&
          typeof result.outcome === "object" &&
          "kind" in result.outcome &&
          result.outcome.kind !== "published"
        ) {
          setError(true)
          setDiagnostic(JSON.stringify(result.outcome))
        }
      }
    } catch (cause) {
      setError(true)
      setDiagnostic(cause instanceof Error ? cause.message : String(cause))
    } finally {
      await refresh()
      operation.current = false
      setBusy(false)
    }
  }
  if (!group) return <p role="status">{failed ? t("refreshFailed") : t("loading")}</p>
  const selected = group.candidates.find(
    (candidate) => candidate.candidateId === group.selectedCandidateId
  )
  const selectedChangeset = selected
    ? summary?.candidateChangesets?.[selected.candidateId]
    : undefined
  const required = summary?.requiredChecks ?? selectedChangeset?.requiredChecks ?? []
  const checksPassed = Boolean(
    selectedChangeset &&
    selectedChangeset.headSha === group.selectedHeadSha &&
    required.every((profile) =>
      selectedChangeset.checks.some(
        (check) =>
          check.profileId === profile &&
          check.headSha === group.selectedHeadSha &&
          check.outcome === "passed"
      )
    )
  )
  const publishable =
    canManage &&
    !busy &&
    selected?.hasChanges &&
    selected.headSha === group.selectedHeadSha &&
    checksPassed &&
    group.phase === "publishing"
  const publishKey = `${group.selectedCandidateId}:${group.selectedHeadSha}:${group.targetRef}`
  const terminal = ["published", "cancelled", "recoveryRequired"].includes(group.phase)
  return (
    <section className="space-y-4" aria-label={t("compare")}>
      <div className="space-y-1 text-sm">
        <Badge>{t(`phase.${group.phase}`)}</Badge>
        <p>{t(group.targetIsNew ? "newTarget" : "existingTarget", { branch: group.targetRef })}</p>
        <p className="break-all font-mono">
          {t("base")}: {group.baseSha}
        </p>
        {group.checkoutHadUncommittedChanges && <p role="note">{t("dirtyExcluded")}</p>}
        {!canManage && <p role="note">{t("pairedReadOnly")}</p>}
        {(error || failed) && <p role="alert">{t(error ? "actionFailed" : "refreshFailed")}</p>}
        {diagnostic && (
          <details>
            <summary>{t("errorDetails")}</summary>
            <pre className="whitespace-pre-wrap break-all text-xs">{diagnostic}</pre>
          </details>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
          {t("refresh")}
        </Button>
      </div>
      <div
        className="grid gap-3 overflow-x-auto"
        style={{ gridTemplateColumns: `repeat(${group.n}, minmax(240px, 1fr))` }}
      >
        {group.candidates.map((candidate) => {
          const evidence = summary?.candidateChangesets?.[candidate.candidateId]
          const changeset = evidence?.headSha === candidate.headSha ? evidence : undefined
          const isSelected = group.selectedCandidateId === candidate.candidateId
          const duration =
            candidate.startedAt == null
              ? null
              : Math.max(0, (candidate.finishedAt ?? group.updatedAt) - candidate.startedAt)
          return (
            <article
              key={candidate.candidateId}
              className="min-w-0 space-y-3 rounded border p-3"
              aria-label={t("candidate", { number: candidate.index + 1 })}
            >
              <h3 className="font-medium">{t("candidate", { number: candidate.index + 1 })}</h3>
              <Badge variant={isSelected ? "default" : "outline"}>
                {isSelected ? t("selected") : t(`status.${candidate.status}`)}
              </Badge>
              <dl className="space-y-2 text-xs">
                <dt>{t("agent")}</dt>
                <dd className="break-all">{candidate.agent.agentId}</dd>
                <dt>{t("model")}</dt>
                <dd>{candidate.agent.model ?? t("unknown")}</dd>
                <dt>{t("base")}</dt>
                <dd className="break-all font-mono">{group.baseSha}</dd>
                <dt>{t("head")}</dt>
                <dd className="break-all font-mono">{candidate.headSha ?? t("unknown")}</dd>
                <dt>{t("cost")}</dt>
                <dd>
                  {candidate.costUsd == null ? t("unknown") : t("usd", { cost: candidate.costUsd })}
                </dd>
                <dt>{t("duration")}</dt>
                <dd>
                  {duration == null
                    ? t("unknown")
                    : t("seconds", { seconds: Math.round(duration / 1000) })}
                </dd>
                <dt>{t("summary")}</dt>
                <dd className="max-h-40 overflow-auto whitespace-pre-wrap">
                  {summary?.summaries?.[candidate.candidateId] ??
                    (candidate.error ? t("candidateFailed") : t("noSummary"))}
                </dd>
                <dt>{t("files")}</dt>
                <dd>
                  {changeset
                    ? changeset.files.filter((entry) => !entry.excluded).length
                    : candidate.hasChanges
                      ? t("unknown")
                      : 0}
                </dd>
                <dt>{t("checks")}</dt>
                <dd>
                  {changeset?.checks.length ? (
                    <ul>
                      {changeset.checks.map((check, index) => (
                        <li key={`${check.profileId}:${index}`}>
                          {check.profileId}: {t(`check.${check.outcome}`)}{" "}
                          <code>{check.headSha.slice(0, 8)}</code>
                          {check.headSha !== candidate.headSha && <span>{t("staleCheck")}</span>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    t("noChecks")
                  )}
                </dd>
              </dl>
              {!candidate.hasChanges && candidate.status === "succeeded" && (
                <p className="text-xs">{t("noChanges")}</p>
              )}
              <Button
                size="sm"
                disabled={
                  !canManage ||
                  busy ||
                  !candidate.hasChanges ||
                  candidate.status !== "succeeded" ||
                  Boolean(group.selectedCandidateId) ||
                  !["running", "awaitingSelection"].includes(group.phase)
                }
                onClick={() =>
                  void mutate(() => pickBestOfNCandidate(groupId, candidate.candidateId))
                }
              >
                {t("pick")}
              </Button>
              {changeset && (
                <details>
                  <summary className="cursor-pointer text-sm">{t("details")}</summary>
                  <ChangesetDetail
                    changeset={changeset}
                    host={host}
                    projectId={summary?.projectId ?? null}
                    readOnly
                  />
                </details>
              )}
              {changeset && (
                <ul className="space-y-1">
                  {changeset.files
                    .filter((entry) => !entry.excluded)
                    .map((entry) => (
                      <li key={entry.path}>
                        <Button
                          size="sm"
                          variant="link"
                          className="max-w-full justify-start"
                          onClick={() =>
                            setFile({
                              candidateId: candidate.candidateId,
                              path: entry.path,
                              head: changeset.headSha,
                            })
                          }
                        >
                          {entry.path}
                        </Button>
                      </li>
                    ))}
                </ul>
              )}
            </article>
          )
        })}
      </div>
      {file && (
        <section aria-label={t("diff")} className="h-96 rounded border">
          <p className="break-all p-2 text-xs">
            {file.path} · {file.head}
          </p>
          {diffError === diffKey ? (
            <div role="alert">
              {t("diffFailed")}
              <Button
                variant="outline"
                onClick={() => {
                  setDiffError(null)
                  setDiffRetry((value) => value + 1)
                }}
              >
                {t("retry")}
              </Button>
            </div>
          ) : diff?.key === diffKey ? (
            <DiffViewer diff={diff.value} staged={false} readOnly />
          ) : (
            <p role="status">{t("loading")}</p>
          )}
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        {selected && group.phase !== "published" && (
          <Button
            variant="outline"
            disabled={!canManage || busy}
            onClick={() => void mutate(() => runChecksBestOfNCandidate(groupId))}
          >
            {t("runChecks")}
          </Button>
        )}
        <Button disabled={!publishable} onClick={() => setConfirmPublish(publishKey)}>
          {t("publish")}
        </Button>
        {!terminal && (
          <Button
            variant="outline"
            disabled={!canManage || busy || group.phase === "publishing"}
            onClick={() => void mutate(() => cancelBestOfN(groupId))}
          >
            {t("cancel")}
          </Button>
        )}
        {group.phase !== "publishing" &&
          (group.archiveStatus !== "archived" ||
            summary?.sessionArchiveError ||
            archiveFailure) && (
            <Button
              variant="outline"
              disabled={!canManage || busy}
              onClick={() => void mutate(() => archiveBestOfN(groupId))}
            >
              {t(
                group.archiveStatus === "failed" || summary?.sessionArchiveError || archiveFailure
                  ? "retryArchive"
                  : "archive"
              )}
            </Button>
          )}
      </div>
      {confirmPublish === publishKey && publishable && (
        <section
          role="alertdialog"
          aria-label={t("confirmTitle")}
          className="space-y-2 rounded border p-3"
        >
          <p>
            {t("confirmPublish", { sha: group.selectedHeadSha ?? "", branch: group.targetRef })}
          </p>
          <Button onClick={() => void mutate(() => publishBestOfNCandidate(groupId))}>
            {t("confirm")}
          </Button>
          <Button variant="outline" onClick={() => setConfirmPublish(null)}>
            {t("back")}
          </Button>
        </section>
      )}
      <p className="text-xs">
        {t("archiveStatus")}: {t(`archivePhase.${group.archiveStatus}`)}
      </p>
      {(group.archiveError || summary?.sessionArchiveError || archiveFailure) && (
        <p role="alert">{t("archiveFailed")}</p>
      )}
    </section>
  )
}
