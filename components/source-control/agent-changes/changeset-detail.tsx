"use client"

import { useEffect, useId, useState } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
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
import type { AgentChangesActions } from "@/hooks/scm/use-agent-changesets"
import type { ChangesetEligibility, ScmHost } from "@/lib/scm/host"
import type { AgentChangeset } from "@/lib/scm/types"
import { changesetActions, reviewReasonKey } from "./presentation"

interface Props {
  changeset: AgentChangeset
  host: ScmHost
  projectId: string | null
  readOnly?: boolean
  actions?: Pick<
    AgentChangesActions,
    "review" | "approve" | "requestChanges" | "abandon" | "busy" | "error"
  >
}

export function ChangesetDetail({ changeset, host, projectId, actions, readOnly = false }: Props) {
  const t = useTranslations("agentChanges")
  const noteId = useId()
  const [note, setNote] = useState("")
  const [confirm, setConfirm] = useState<"approve" | "abandon" | null>(null)
  const [eligibility, setEligibility] = useState<{
    changeset: AgentChangeset
    value: ChangesetEligibility | null
  } | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    host.changesetEligibility(changeset.changesetId).then(
      (value) => {
        if (!cancelled) setEligibility({ changeset, value })
      },
      () => {
        if (!cancelled) setEligibility({ changeset, value: null })
      }
    )
    return () => {
      cancelled = true
    }
  }, [changeset, host, retry])

  const allowed = changesetActions(changeset.state)
  const review = changeset.review
  const currentEligibility = eligibility?.changeset === changeset ? eligibility : null
  const reasons = review?.reasons ?? []
  const confirmAction = async () => {
    if (!actions || readOnly) return
    const result =
      confirm === "approve"
        ? await actions.approve(changeset)
        : await actions.abandon(changeset.changesetId)
    if (result) setConfirm(null)
  }

  return (
    <section
      aria-label={t("detail.title")}
      className="space-y-4 rounded-md border p-4"
      data-testid="changeset-detail"
    >
      <div className="space-y-1">
        <h3 className="break-words font-medium">{changeset.title}</h3>
        <p className="text-xs text-muted-foreground">
          {t("detail.head", { sha: changeset.headSha.slice(0, 8) })}
        </p>
        {!projectId && (
          <p role="note" className="text-sm text-muted-foreground">
            {t("noProject")}
          </p>
        )}
      </div>
      <div>
        <h4 className="mb-2 text-sm font-medium">{t("detail.files")}</h4>
        <ul className="space-y-2 text-xs">
          {changeset.files.map((file) => (
            <li key={file.path} className="flex flex-wrap items-center gap-2">
              <span className="break-all font-mono">{file.path}</span>
              {file.oldPath && (
                <span className="break-all">{t("detail.renamedFrom", { path: file.oldPath })}</span>
              )}
              <Badge variant="outline">{t(`fileStatus.${file.status}`)}</Badge>
              <span>
                {t("lineTotals", {
                  insertions: file.insertions ?? 0,
                  deletions: file.deletions ?? 0,
                })}
              </span>
              {file.binary && <Badge variant="secondary">{t("detail.binary")}</Badge>}
              {file.excluded && <Badge variant="outline">{t("detail.withheldSensitive")}</Badge>}
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t("detail.review")}</h4>
        {review ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge>{t(`verdicts.${review.verdict}`)}</Badge>
              <Badge variant="outline">{t(`reviewers.${review.reviewer}`)}</Badge>
              <Badge variant={review.riskTier === "high" ? "destructive" : "secondary"}>
                {t(`risk.${review.riskTier}`)}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("detail.reviewHead", { sha: review.headSha.slice(0, 8) })}
            </p>
            {review.headSha !== changeset.headSha && (
              <p role="alert" className="text-sm text-destructive">
                {t("gaps.staleHead")}
              </p>
            )}
            <ul className="list-inside list-disc text-sm" data-testid="review-reasons">
              {reasons.map((code, index) => (
                <li key={`${code}:${index}`}>{t(reviewReasonKey(code), { code })}</li>
              ))}
            </ul>
            {review.requiresHumanApproval && (
              <p className="text-sm">{t("detail.humanApprovalRequired")}</p>
            )}
            {(["critical", "warning", "info"] as const).map((severity) => {
              const findings = review.findings.filter((finding) => finding.severity === severity)
              return (
                findings.length > 0 && (
                  <div key={severity}>
                    <h5 className="text-sm font-medium">{t(`severity.${severity}`)}</h5>
                    <ul className="space-y-1 text-sm">
                      {findings.map((finding, index) => (
                        <li key={index} className="break-words">
                          <span className="font-mono">{finding.path}</span>
                          <p className="whitespace-pre-wrap">{finding.note}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              )
            })}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("detail.noReview")}</p>
        )}
        {changeset.approval && (
          <p className="text-xs text-muted-foreground">
            {t("detail.approvalHead", {
              sha: changeset.approval.headSha.slice(0, 8),
              approver: changeset.approval.approver,
            })}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t("detail.checks")}</h4>
        {changeset.checks.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("detail.noChecks")}</p>
        )}
        {changeset.checks.map((check, index) => (
          <div key={`${check.profileId}:${index}`} className="space-y-1 rounded border p-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-all">{check.profileId}</span>
              <Badge variant="outline">{t(`checkOutcomes.${check.outcome}`)}</Badge>
              <span>{t("detail.checkTier", { tier: check.tier ?? t("detail.unknownTier") })}</span>
              <code>{check.headSha.slice(0, 8)}</code>
            </div>
            {check.logTail && (
              <details>
                <summary className="cursor-pointer">{t("detail.logTail")}</summary>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
                  {check.logTail}
                </pre>
              </details>
            )}
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t("detail.eligibility")}</h4>
        {!currentEligibility ? (
          <p role="status">{t("loading")}</p>
        ) : currentEligibility.value ? (
          <>
            {currentEligibility.value.eligible && <p className="text-sm">{t("detail.eligible")}</p>}
            <ul className="list-inside list-disc text-sm">
              {currentEligibility.value.gaps.map((gap, index) => (
                <li key={index}>
                  {t(`gaps.${gap.kind}`, {
                    profile: "profile" in gap ? gap.profile : "",
                    outcome: "outcome" in gap ? t(`checkOutcomes.${gap.outcome}`) : "",
                  })}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div role="alert">
            <p>{t("errors.eligibility")}</p>
            <Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>
              {t("retry")}
            </Button>
          </div>
        )}
      </div>
      {!readOnly && actions && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={actions.busy || !allowed.review}
              onClick={() => void actions.review(changeset.changesetId)}
              data-testid="changeset-review"
            >
              {t("actions.review")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={actions.busy || !allowed.approve}
              onClick={() => setConfirm("approve")}
              data-testid="changeset-approve"
            >
              {t("actions.approve")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={actions.busy || !allowed.abandon}
              onClick={() => setConfirm("abandon")}
              data-testid="changeset-abandon"
            >
              {t("actions.abandon")}
            </Button>
          </div>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!allowed.requestChanges || actions.busy || !note.trim()) return
              void actions.requestChanges(changeset, note.trim()).then((result) => {
                if (result) setNote("")
              })
            }}
          >
            <Label htmlFor={noteId}>{t("detail.changeNote")}</Label>
            <Textarea
              id={noteId}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={actions.busy || !allowed.requestChanges}
            />
            <Button
              size="sm"
              type="submit"
              variant="outline"
              disabled={actions.busy || !allowed.requestChanges || !note.trim()}
              data-testid="changeset-request-changes"
            >
              {t("actions.requestChanges")}
            </Button>
          </form>
          <AlertDialog
            open={confirm !== null}
            onOpenChange={(open) => {
              if (!open && !actions.busy) setConfirm(null)
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {confirm === "approve" ? t("confirm.approveTitle") : t("confirm.abandonTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {confirm === "approve"
                    ? t("confirm.approveDescription", { sha: changeset.headSha.slice(0, 8) })
                    : t("confirm.abandonDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {confirm === "approve" && review?.requiresHumanApproval && (
                <ul className="max-h-60 list-inside list-disc overflow-auto text-sm">
                  {reasons.map((code, index) => (
                    <li key={index}>{t(reviewReasonKey(code), { code })}</li>
                  ))}
                </ul>
              )}
              {actions.error && <p role="alert">{t("errors.action")}</p>}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={actions.busy}>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={
                    actions.busy || (confirm === "approve" ? !allowed.approve : !allowed.abandon)
                  }
                  onClick={(event) => {
                    event.preventDefault()
                    void confirmAction()
                  }}
                  data-testid="changeset-confirm"
                >
                  {t("confirm.continue")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </section>
  )
}
