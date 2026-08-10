"use client"

/**
 * Settings → External Bridge → Inbound review.
 *
 * The operator-facing half of ADR-0008 Phase 4. External agents, IDE scanners,
 * and the crawler all deposit `pending` drafts; nothing they submit reaches
 * live state until someone here says so.
 *
 * ## Why the raw body is shown, and shown fenced
 *
 * The submission is attacker-controllable text. Rendering it as Markdown would
 * let it impersonate Cognia's own UI, so it renders as pre-formatted plain text
 * inside a labelled untrusted region. Reviewing content you cannot actually see
 * is not review, so it is shown in full rather than truncated — but it is never
 * shown as though Cognia authored it.
 *
 * ## Why accept and reject are one-way
 *
 * Both are terminal (`lib/db/inbound-drafts.ts`). Accepting queues real work
 * that may already have produced a memory, a Skill, or a note by the time a
 * user changed their mind, so the dialog says so plainly instead of offering an
 * undo that could not be honoured.
 *
 * Materialization failures surface here with a retry, because the review
 * decision stands even when the follow-up work fails — the alternative would be
 * silently un-accepting something the operator approved.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { AlertTriangleIcon, ChevronRightIcon, RotateCcwIcon } from "lucide-react"
import { toast } from "sonner"

import { MotionCollapse } from "@/components/chat/motion/motion-reveal"
import { SettingsCard } from "@/components/settings/common/settings-section"
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
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  acceptInboundDraft,
  listInboundDrafts,
  materializableBody,
  rejectInboundDraft,
  type InboundDraftRow,
  type InboundDraftStatus,
} from "@/lib/db/inbound-drafts"
import { getDb } from "@/lib/db/schema"
import { retryMaterializationNow } from "@/lib/inbound/materializer"
import { stripUntrustedEnvelope } from "@/lib/inbound/canonical-hash"
import type { InboundMaterializationRow } from "@/lib/db/inbound-materializations"

type StatusFilter = InboundDraftStatus | "all"

const STATUS_FILTERS: readonly StatusFilter[] = ["pending", "accepted", "rejected", "all"]

/**
 * Narrow the queue to the selected status.
 *
 * Split out of the live query so the filtering is testable without a React
 * render — and so `"all"` staying a pass-through, rather than being compared
 * against a status that does not exist, is pinned by a test.
 */
export function filterDrafts(
  rows: readonly InboundDraftRow[],
  filter: StatusFilter
): InboundDraftRow[] {
  return filter === "all" ? [...rows] : rows.filter((row) => row.status === filter)
}

/** Index outbox rows by draft id so a row can render its own job state. */
export function indexJobsByDraft(
  rows: readonly InboundMaterializationRow[]
): Map<string, InboundMaterializationRow> {
  return new Map(rows.map((row) => [row.draftId, row]))
}

export function BridgeInboundPanel() {
  const t = useTranslations("settings.externalBridge")
  const [filter, setFilter] = useState<StatusFilter>("pending")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<{ draft: InboundDraftRow; edited: string } | null>(
    null
  )
  const [rejecting, setRejecting] = useState<InboundDraftRow | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const drafts =
    useLiveQuery(async () => filterDrafts(await listInboundDrafts(250), filter), [filter]) ?? []

  // Keyed by draft id so a row can show "attempt 3 — failed" next to its own
  // decision rather than sending the operator to a separate queue view.
  const jobs =
    useLiveQuery(
      async () => indexJobsByDraft(await getDb().inboundMaterializations.toArray()),
      []
    ) ?? new Map<string, InboundMaterializationRow>()

  const onAccept = useCallback(async () => {
    if (!confirming) return
    const { draft, edited } = confirming
    setConfirming(null)
    setBusy(draft.id)
    try {
      const trimmed = edited.trim()
      const original = stripUntrustedEnvelope(materializableBody(draft)).trim()
      await acceptInboundDraft(draft.id, {
        // Only record an edit when the operator actually changed something —
        // an unchanged `editedBody` would mask the original for no reason.
        ...(trimmed && trimmed !== original ? { editedBody: wrapEdited(trimmed) } : {}),
      })
      toast.success(t("inbound.toastAccepted"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [confirming, t])

  const onReject = useCallback(async () => {
    if (!rejecting) return
    const draft = rejecting
    setRejecting(null)
    setBusy(draft.id)
    try {
      await rejectInboundDraft(draft.id)
      toast.success(t("inbound.toastRejected"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [rejecting, t])

  const onRetry = useCallback(
    async (draftId: string) => {
      setBusy(draftId)
      try {
        const result = await retryMaterializationNow(draftId)
        if (result.status === "completed") toast.success(t("inbound.toastRetried"))
        else toast.error(result.error ?? t("inbound.retryFailed"))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
      }
    },
    [t]
  )

  const pendingCount = drafts.filter((d) => d.status === "pending").length

  return (
    <div className="space-y-4">
      <SettingsCard
        title={t("inbound.title")}
        description={t("inbound.description")}
        headerAction={
          <Select value={filter} onValueChange={(v) => setFilter(v as StatusFilter)}>
            <SelectTrigger className="h-8 w-32 text-xs" aria-label={t("inbound.filterAria")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`inbound.filter.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {drafts.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("inbound.empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="bridge-inbound-list">
            {drafts.map((draft) => (
              <InboundDraftRowView
                key={draft.id}
                draft={draft}
                job={jobs.get(draft.id)}
                busy={busy === draft.id}
                isExpanded={expanded === draft.id}
                onToggle={() => setExpanded((cur) => (cur === draft.id ? null : draft.id))}
                onAccept={(edited) => setConfirming({ draft, edited })}
                onReject={() => setRejecting(draft)}
                onRetry={() => void onRetry(draft.id)}
              />
            ))}
          </ul>
        )}
        {filter === "pending" && pendingCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("inbound.pendingCount", { count: pendingCount })}
          </p>
        ) : null}
      </SettingsCard>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("inbound.acceptConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming ? t(`inbound.acceptConfirmDesc.${confirming.draft.kind}`) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("inbound.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onAccept()}>
              {t("inbound.accept")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rejecting !== null} onOpenChange={(open) => !open && setRejecting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("inbound.rejectConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("inbound.rejectConfirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("inbound.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onReject()}>
              {t("inbound.reject")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Re-fence an operator's edit. Editing hostile text does not make it trusted. */
function wrapEdited(text: string): string {
  return `<untrusted_content>\n${text}\n</untrusted_content>`
}

function InboundDraftRowView({
  draft,
  job,
  busy,
  isExpanded,
  onToggle,
  onAccept,
  onReject,
  onRetry,
}: {
  draft: InboundDraftRow
  job: InboundMaterializationRow | undefined
  busy: boolean
  isExpanded: boolean
  onToggle: () => void
  onAccept: (edited: string) => void
  onReject: () => void
  onRetry: () => void
}) {
  const t = useTranslations("settings.externalBridge")
  const body = stripUntrustedEnvelope(materializableBody(draft)).trim()
  const [edited, setEdited] = useState(body)
  const isPending = draft.status === "pending"
  const origin = typeof draft.metadata?.origin === "string" ? draft.metadata.origin : undefined
  const failed = job?.status === "failed"

  return (
    <li className="px-3 py-2 text-sm" data-testid={`bridge-inbound-row-${draft.id}`}>
      <div className="flex items-start gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-expanded={isExpanded}
          aria-label={t("inbound.detailAria", { title: draft.title })}
          className="mt-0.5 size-5 rounded-sm text-muted-foreground hover:bg-muted"
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")}
            aria-hidden
          />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium">{draft.title}</span>
            <Badge variant="outline" className="text-[10px]">
              {t(`inbound.kind.${draft.kind}`)}
            </Badge>
            <Badge
              variant={isPending ? "secondary" : "outline"}
              className={cn(
                "text-[10px]",
                draft.status === "accepted" && "text-emerald-600 dark:text-emerald-400",
                draft.status === "rejected" && "text-muted-foreground"
              )}
            >
              {t(`inbound.status.${draft.status}`)}
            </Badge>
            {origin ? (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {t(`inbound.origin.${origin}`)}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {new Date(draft.createdAt).toLocaleString()}
            {draft.source ? ` · ${draft.source}` : ""}
          </p>
          {failed ? (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">
                {t("inbound.materializeFailed", { attempts: job.attempts, error: job.error ?? "" })}
              </span>
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isPending ? (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={onReject}>
                {t("inbound.reject")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => onAccept(edited)}>
                {t("inbound.accept")}
              </Button>
            </>
          ) : null}
          {failed ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onRetry}
              aria-label={t("inbound.retryAria", { title: draft.title })}
            >
              <RotateCcwIcon className="size-3.5" aria-hidden />
              {t("inbound.retry")}
            </Button>
          ) : null}
        </div>
      </div>

      <MotionCollapse open={isExpanded}>
        <div className="mt-2 space-y-2 pl-6">
          <div>
            {/* Labelled as untrusted and rendered as plain pre-formatted text:
                Markdown here would let a submission impersonate Cognia's UI. */}
            <p className="mb-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              {t("inbound.untrustedLabel")}
            </p>
            {isPending ? (
              <Textarea
                value={edited}
                onChange={(e) => setEdited(e.target.value)}
                aria-label={t("inbound.editAria", { title: draft.title })}
                className="min-h-32 font-mono text-xs"
              />
            ) : (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-[11px]">
                {body}
              </pre>
            )}
          </div>
          {draft.rejectionReason ? (
            <p className="text-[11px] text-muted-foreground">
              {t("inbound.rejectionReason", { reason: draft.rejectionReason })}
            </p>
          ) : null}
          {job?.producedId ? (
            <p className="text-[11px] text-muted-foreground">
              {t("inbound.producedId", { id: job.producedId })}
            </p>
          ) : null}
        </div>
      </MotionCollapse>
    </li>
  )
}
