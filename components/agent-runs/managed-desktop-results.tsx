"use client"

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { useAccountStore } from "@/stores/account/account-store"
import {
  getActiveRemoteEndpoint,
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import { useManagedDesktopResults } from "@/hooks/agent-runs/use-managed-desktop-results"
import type { ManagedDesktopResultsFilter } from "@/lib/automation/managed-desktop-results-client"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import { managedDesktopAcceptanceRunId } from "@/lib/execution/managed-desktop-results"

const noRemote = () => null
/** Each account/Host receives fresh state; terminal parent controls are never reused for review. */
export function ManagedDesktopResults(props: ManagedDesktopResultsFilter) {
  const account = useAccountStore((state) => (state.locked ? null : state.unlockedAccountId))
  const remote = useSyncExternalStore(
    subscribeActiveRemoteTransport,
    getActiveRemoteTransport,
    noRemote
  )
  if (!account || (!props.runId && !props.conversationId && !props.taskId)) return null
  return (
    <ResultHistory
      key={`${account}:${remote ? (getActiveRemoteEndpoint()?.remoteHost?.id ?? "remote") : "local"}:${props.runId ?? ""}:${props.conversationId ?? ""}:${props.taskId ?? ""}`}
      {...props}
    />
  )
}
function ResultHistory(props: ManagedDesktopResultsFilter) {
  const t = useTranslations("settings.managedDesktops.results")
  const state = useManagedDesktopResults(props)
  return (
    <section aria-label={t("title")} className="space-y-3 border-t pt-3">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p
        className="text-xs text-muted-foreground"
        data-dormant="managed-desktop-acceptance-execution"
      >
        {t("dormant")}
      </p>
      <p className="text-xs text-muted-foreground">{t("private")}</p>
      {state.loading ? <p>{t("loading")}</p> : null}
      {state.error ? <p role="alert">{t("unavailable")}</p> : null}
      {!state.loading && !state.error && !state.records.length ? <p>{t("empty")}</p> : null}
      {state.records.map((result) => (
        <article key={result.binding.acceptanceId} className="space-y-2 rounded border p-3">
          <p className="font-mono text-xs break-all">
            {t("commit", { commit: result.binding.commit })}
          </p>
          <p className="text-xs break-all">
            {t("source", { task: result.binding.taskId, run: result.binding.parentRunId })}
          </p>
          <p className="text-xs break-all">
            {t("acceptance", { id: managedDesktopAcceptanceRunId(result.binding.acceptanceId) })}
          </p>
          <Link
            href={`/agent-runs?run=${encodeURIComponent(managedDesktopAcceptanceRunId(result.binding.acceptanceId))}`}
            className="mr-3 text-sm underline"
          >
            {t("openRun")}
          </Link>
          {result.binding.originRunRef ? (
            <p className="text-xs">{t("origin", { run: result.binding.originRunRef })}</p>
          ) : null}
          <Link
            href={`/${buildSessionHref(result.binding.sessionId)}`}
            className="text-sm underline"
          >
            {t("openConversation")}
          </Link>
          {result.agentVerdict ? (
            <div>
              <p>
                {t("agentVerdict", { outcome: t(`outcome.${result.agentVerdict.input.outcome}`) })}
              </p>
              <p className="text-xs">
                {t("provenance", {
                  principal: result.agentVerdict.input.principalId,
                  at: new Date(result.agentVerdict.recordedAt).toISOString(),
                })}
              </p>
              <p className="text-sm whitespace-pre-wrap">{result.agentVerdict.input.summary}</p>
            </div>
          ) : (
            <p>{t("noAgentVerdict")}</p>
          )}
          {result.systemOutcome ? (
            <p>{t("systemOutcome", { outcome: t(`outcome.${result.systemOutcome.outcome}`) })}</p>
          ) : null}
          <ul className="space-y-2">
            {result.binding.criteria.map((criterion) => {
              const outcome =
                result.agentVerdict?.input.criteria.find(
                  (item) => item.criterionId === criterion.id
                )?.outcome ?? "incomplete"
              return (
                <li key={criterion.id}>
                  <p>
                    {criterion.text}: {t(`criterion.${outcome}`)}
                  </p>
                  {result.artifacts
                    .filter((artifact) => artifact.criterionId === criterion.id)
                    .map((artifact) => {
                      const url = state.previews[`${result.binding.acceptanceId}:${artifact.id}`]
                      return (
                        <div key={artifact.id}>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={state.busy || Boolean(url)}
                            onClick={() => void state.viewEvidence(result, artifact.id)}
                          >
                            {t("viewScreenshot", {
                              kind: t(`capture.${artifact.kind}`),
                              at: new Date(artifact.capturedAt).toISOString(),
                            })}
                          </Button>
                          {url ? (
                            <Image
                              src={url}
                              unoptimized
                              width={artifact.width}
                              height={artifact.height}
                              alt={t("screenshotAlt", { criterion: criterion.text })}
                              className="mt-2 max-h-96 max-w-full object-contain"
                            />
                          ) : null}
                        </div>
                      )
                    })}
                </li>
              )
            })}
          </ul>
          {result.evidenceLimitReached ? <p>{t("limitReached")}</p> : null}
          {result.cleanupPending ? <p>{t("cleanupPending")}</p> : null}
          <div className="space-y-2 border-t pt-2">
            <h4 className="text-sm font-medium">{t("humanApproval")}</h4>
            <p className="text-xs text-muted-foreground">{t("independent")}</p>
            {!result.humanApprovals.length ? <p>{t("notReviewed")}</p> : null}
            {result.humanApprovals.map((approval) => (
              <p key={approval.revision} className="text-xs">
                {t("approval", {
                  revision: approval.revision,
                  decision: t(`decision.${approval.input.decision}`),
                  principal: approval.input.principalId,
                  at: new Date(approval.recordedAt).toISOString(),
                })}
              </p>
            ))}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={state.busy || !(result.agentVerdict || result.systemOutcome)}
                onClick={() => void state.approve(result, "approved")}
              >
                {t("approve")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={state.busy || !(result.agentVerdict || result.systemOutcome)}
                onClick={() => void state.approve(result, "rejected")}
              >
                {t("reject")}
              </Button>
            </div>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={state.busy}>
                {t("delete")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
                <AlertDialogDescription>{t("deleteDescription")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void state.remove(result)}>
                  {t("deleteConfirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </article>
      ))}
    </section>
  )
}
