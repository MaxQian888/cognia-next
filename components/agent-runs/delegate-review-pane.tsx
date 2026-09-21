"use client"

/**
 * The delegate review of one run, inside the cockpit's detail pane
 * (ADR-0188 B4, D21, WP-D5).
 *
 * A delegate run is the one Router + Fusion mode that proposes to change a
 * person's files, so its surface is built around the two things that make that
 * safe: the evidence (an acceptance report a runtime produced, in a sandbox it
 * names) and the decision (an approval bound to a digest, API-08).
 *
 * Four rules are visible here:
 *
 * - the decision buttons settle the interrupt the run is parked on, through
 *   the same control plane every other approval uses. The pane sends no
 *   approval id of its own: the interrupt's id IS the run's approval id, which
 *   is derived from the request digest, and a pane that made one up could
 *   approve something the person never read;
 * - when the pending interrupt and the pending approval disagree, nothing is
 *   offered. That is the shape of a stale view, and API-08 says the standing
 *   request must not be settled by an answer that names something else;
 * - "Apply to workspace" is the approve verb of a `workspace_apply` request,
 *   not a write of its own. The write is a compare-and-swap inside the run
 *   (DEL-04), so a pane that wrote files itself would bypass the conflict
 *   check and the run's journal;
 * - nothing about Router + Fusion is imported until the master switch is on:
 *   the record read is a dynamic import behind it, so a device with the switch
 *   off renders exactly what it rendered before (D36/D37).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { AlertTriangleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DelegateChecksTable } from "@/components/router-fusion/delegate-checks-table"
import { DelegatePatchView } from "@/components/router-fusion/delegate-patch-view"
import { DelegateRunDetails } from "@/components/router-fusion/delegate-run-details"
import {
  loadDelegateReview,
  type DelegateReviewState,
} from "@/components/router-fusion/delegate-review-model"
import { saveFileAs } from "@/lib/files/file-bridge"
import { formatRelativeTime } from "@/lib/scheduler/format-utils"
import { cn } from "@/lib/utils"
import type { ExecutionRunInterrupt } from "@/types/execution/run"

const warnText = "text-amber-600 dark:text-amber-400"

/** The interrupt a parked delegate run raises (`types/execution/run.ts`). */
export function isFusionApprovalInterrupt(
  interrupt: Pick<ExecutionRunInterrupt, "type"> | null | undefined
): boolean {
  return interrupt?.type === "fusion_approval"
}

export interface DelegateReviewPaneProps {
  runId: string
  /**
   * The `fusion_approval` interrupt this run is parked on, when it is parked.
   * Absent for a finished run, whose record is still reviewable.
   */
  interrupt?: ExecutionRunInterrupt | null
  busy?: boolean
  /** Settles the interrupt through the cockpit's control plane. */
  onDecide?: (action: "approve" | "deny") => void
  /** Test seam for the record read. */
  load?: (runId: string) => Promise<DelegateReviewState>
  /** Test seam for the patch download. */
  save?: typeof saveFileAs
}

export function DelegateReviewPane({
  runId,
  interrupt,
  busy = false,
  onDecide,
  load = loadDelegateReview,
  save = saveFileAs,
}: DelegateReviewPaneProps) {
  const t = useTranslations("routerFusionDelegate.review")
  const tPatch = useTranslations("routerFusionDelegate.patch")
  const [result, setResult] = useState<{ forKey: string; state: DelegateReviewState } | null>(null)
  const [downloading, setDownloading] = useState(false)
  // Re-read when the run parks on (or leaves) a decision: the patch, the
  // report and the approval history all move with it.
  const interruptId = interrupt?.id ?? null
  const interruptStatus = interrupt?.status ?? null
  const loadKey = `${runId}:${interruptId ?? ""}:${interruptStatus ?? ""}`
  // Render-derived reset: a result tagged with a stale key reads as "loading"
  // instead of a synchronous setState inside the effect.
  const state = result?.forKey === loadKey ? result.state : null

  useEffect(() => {
    let cancelled = false
    const key = loadKey
    void load(runId)
      .then((next) => {
        if (!cancelled) setResult({ forKey: key, state: next })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResult({
            forKey: key,
            state: {
              state: "unavailable",
              reason: error instanceof Error ? error.message : String(error),
            },
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [runId, loadKey, load])

  const review = state?.state === "ready" ? state.review : null
  const patch = review?.patch ?? null

  const download = useCallback(async () => {
    if (!patch?.document) return
    setDownloading(true)
    try {
      const saved = await save({
        defaultName: `delegate-patch-${runId}.json`,
        content: patch.document,
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
      if (saved) toast.success(tPatch("downloaded"))
    } catch (error) {
      console.error("[router-fusion] delegate patch download failed", error)
      toast.error(tPatch("downloadFailed"))
    } finally {
      setDownloading(false)
    }
  }, [patch, runId, save, tPatch])

  if (state === null) {
    return (
      <p role="status" className="py-2 text-xs text-muted-foreground">
        {t("loading")}
      </p>
    )
  }
  // Switched off, or a run that is not a delegation: the cockpit keeps the
  // pane it had, with nothing of this subsystem mounted.
  if (state.state === "off" || state.state === "not-delegate") return null
  if (state.state === "unavailable") {
    return (
      <p
        role="status"
        className={cn("flex items-start gap-1.5 py-2 text-xs", warnText)}
        data-testid="delegate-review-unavailable"
      >
        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {t("unavailable", { reason: state.reason })}
      </p>
    )
  }

  if (!review) return null

  const pending = review.pendingApproval
  // API-08: the interrupt's id IS the approval's id. A view that has drifted
  // offers nothing rather than settling the wrong request.
  const decidable =
    pending !== null &&
    interrupt !== null &&
    interrupt !== undefined &&
    interrupt.status === "pending" &&
    interrupt.id === pending.id &&
    onDecide !== undefined
  const mismatched =
    pending !== null &&
    interrupt !== null &&
    interrupt !== undefined &&
    interrupt.status === "pending" &&
    interrupt.id !== pending.id
  const history = review.approvals.filter((one) => one.status !== "pending")

  return (
    <section className="space-y-3" aria-labelledby="delegate-review" data-testid="delegate-review">
      <h3 id="delegate-review" className="text-sm font-medium">
        {t("title")}
      </h3>

      {pending ? (
        <div
          className="space-y-2 rounded-md border p-3 text-xs"
          data-testid="delegate-review-approval"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="text-xs font-medium">{t("approval.title")}</h4>
            <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">
              {t(`approval.kind.${pending.kind}`)}
            </Badge>
          </div>
          <p className="text-[11px] text-muted-foreground">{t(`approval.what.${pending.kind}`)}</p>
          <dl className="space-y-1">
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-muted-foreground">{t("approval.revision")}</dt>
              <dd className="min-w-0 break-all text-right font-mono text-[10px]">
                {pending.revision}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-muted-foreground">{t("approval.digest")}</dt>
              <dd className="min-w-0 break-all text-right font-mono text-[10px]">
                {pending.requestDigest}
              </dd>
            </div>
            {pending.paths.length > 0 ? (
              <div className="flex items-start justify-between gap-3">
                <dt className="shrink-0 text-muted-foreground">{t("approval.paths")}</dt>
                <dd className="min-w-0 text-right">
                  <ul>
                    {pending.paths.map((path) => (
                      <li key={path} className="break-all font-mono text-[10px]">
                        {path}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null}
          </dl>
          {mismatched ? (
            <p
              role="status"
              className={cn("flex items-start gap-1.5 text-[11px]", warnText)}
              data-testid="delegate-review-mismatch"
            >
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
              {t("approval.mismatch")}
            </p>
          ) : null}
          {decidable ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onDecide?.("approve")}
                data-testid="delegate-review-approve"
              >
                {pending.kind === "workspace_apply" ? t("approval.apply") : t("approval.approve")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => onDecide?.("deny")}
                data-testid="delegate-review-deny"
              >
                {t("approval.deny")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : patch && patch.delivery === "patch_only" && patch.appliedRevision === null ? (
        <p className="text-[11px] text-muted-foreground" data-testid="delegate-review-apply-note">
          {t("applyElsewhere")}
        </p>
      ) : null}

      <DelegateChecksTable acceptance={review?.acceptance ?? null} />

      <DelegatePatchView
        patch={patch}
        downloading={downloading}
        onDownload={() => void download()}
      />

      <DelegateRunDetails progress={review.progress} />

      {history.length > 0 ? (
        <section className="space-y-1 text-xs" data-testid="delegate-review-history">
          <h4 className="text-xs font-medium">{t("approval.history")}</h4>
          <ul className="space-y-1">
            {history.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2 rounded border px-2 py-1">
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {t(`approval.kind.${entry.kind}`)}
                </Badge>
                <span className="min-w-0 flex-1 truncate">
                  {t("approval.decidedAt", {
                    status: t(`approval.status.${entry.status}`),
                    when: formatRelativeTime(new Date(entry.decidedAt ?? entry.createdAt)),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  )
}
