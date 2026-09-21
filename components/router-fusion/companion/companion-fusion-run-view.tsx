"use client"

// One Router + Fusion run a paired device started (ADR-0188 D25, the
// `companion` surface), followed from the mobile remote-session view.
//
// Three stages, each read from where its truth lives:
//  1. queued — the outbound queue row (`execution_run_create`): pending until
//     the host has it, dead-lettered if it never will;
//  2. delivered — the same request under the same key reads the run back
//     (a replay, never a second run);
//  3. running — `execution_run_events` paged by seq (REC-07), folded into the
//     same `FusionRunDetails` card the desktop shows, and the verified answer
//     from the run's snapshot once it succeeded.
//
// The client is loaded with a dynamic import, so nothing Router + Fusion loads
// on this device until a run exists to show.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, Loader2, SquareIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { FusionRunDetails, KNOWN_RUN_STATUSES } from "@/components/router-fusion/fusion-run-details"
import { getDb } from "@/lib/db/schema"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import type {
  CompanionRunError,
  CompanionRunFollow,
  PendingCompanionRun,
} from "@/lib/router-fusion/api/companion-run-client"

type CompanionRunClient = typeof import("@/lib/router-fusion/api/companion-run-client")

/** Queue states that mean the row will never reach the host on its own. */
const UNDELIVERABLE = new Set<MobileOutboundJobRow["status"]>([
  "deadlettered",
  "rejected",
  "conflicted",
])

export type CompanionRunStage = "queued" | "undelivered" | "starting" | "refused" | "following"

export interface CompanionFusionRunViewProps {
  run: PendingCompanionRun
  onDismiss: (rowId: string) => void
  /** Test seam for the dynamically loaded client. */
  loadClient?: () => Promise<CompanionRunClient>
}

const loadCompanionRunClient = () => import("@/lib/router-fusion/api/companion-run-client")

export function CompanionFusionRunView({
  run,
  onDismiss,
  loadClient = loadCompanionRunClient,
}: CompanionFusionRunViewProps) {
  const t = useTranslations("routerFusionCompanion.run")
  const tPicker = useTranslations("routerFusionCompanion.picker")
  const tReason = useTranslations("routerFusionCompanion.reason")
  const tRefusal = useTranslations("routerFusion.refusal")
  const tCard = useTranslations("routerFusion.runCard")

  const [client, setClient] = useState<CompanionRunClient | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<CompanionRunError | null>(null)
  const [follow, setFollow] = useState<CompanionRunFollow | null>(null)
  const [stopping, setStopping] = useState(false)

  // `null` is a row the queue no longer holds (vacuumed after delivery),
  // `undefined` is the first read still in flight.
  const row = useLiveQuery(
    async () => (await getDb().mobileOutboundQueue.get(run.rowId)) ?? null,
    [run.rowId]
  )
  const delivered = row === null || row?.status === "sent"
  const undeliverable = row ? UNDELIVERABLE.has(row.status) : false

  useEffect(() => {
    let cancelled = false
    void loadClient().then((loaded) => {
      if (!cancelled) setClient(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [loadClient])

  // Delivered: the same request under the same key answers with its run.
  useEffect(() => {
    if (!client || !delivered || runId || refusal) return
    let cancelled = false
    void client.readBackCompanionFusionRun(run).then((outcome) => {
      if (cancelled) return
      if (outcome.ok) setRunId(outcome.value.run_id)
      else setRefusal(outcome.error)
    })
    return () => {
      cancelled = true
    }
  }, [client, delivered, refusal, run, runId])

  // Running: page the events by seq until the run is terminal.
  useEffect(() => {
    if (!client || !runId) return
    const controller = new AbortController()
    void client.followCompanionFusionRun(runId, {
      signal: controller.signal,
      onUpdate: (next) => {
        if (!controller.signal.aborted) setFollow(next)
      },
    })
    return () => controller.abort()
  }, [client, runId])

  const reasonText = useCallback(
    (code: string) => {
      if (typeof tReason.has === "function" && tReason.has(code as never)) {
        return tReason(code as never)
      }
      if (typeof tRefusal.has === "function" && tRefusal.has(code as never)) {
        return tRefusal(code as never)
      }
      return tRefusal("unknown", { code })
    },
    [tReason, tRefusal]
  )

  const summary = useMemo(
    () => (client && follow ? client.companionRunSummaryOf(follow) : null),
    [client, follow]
  )
  const answer = client && follow ? client.companionRunAnswerOf(follow) : null
  const terminal = follow?.terminal === true
  const stage: CompanionRunStage = undeliverable
    ? "undelivered"
    : refusal
      ? "refused"
      : runId
        ? "following"
        : delivered
          ? "starting"
          : "queued"
  const dismissable = stage === "undelivered" || stage === "refused" || terminal
  const modeLabel = tPicker(run.mode)
  const status = summary?.status ?? null

  const stop = useCallback(async () => {
    if (!client || !runId) return
    setStopping(true)
    try {
      const answered = await client.cancelCompanionFusionRun(runId, follow?.lastSeq ?? 0)
      if (!answered.accepted) {
        toast.error(t("stopFailed", { reason: answered.code ?? answered.reason ?? "" }))
      }
    } finally {
      setStopping(false)
    }
  }, [client, follow?.lastSeq, runId, t])

  return (
    <section
      className="rounded-lg border bg-card p-3 text-xs"
      data-testid="companion-fusion-run"
      data-stage={stage}
      data-run-id={runId ?? undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {!dismissable ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> : null}
          <span className="truncate font-medium">{t("title", { mode: modeLabel })}</span>
          {status ? (
            <Badge
              variant="outline"
              className="shrink-0 text-[10px]"
              data-testid="companion-fusion-run-status"
            >
              {KNOWN_RUN_STATUSES.has(status)
                ? tCard(`statusValue.${status}` as never)
                : tCard("statusValue.unknown", { status })}
            </Badge>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {runId && !terminal ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2"
              disabled={stopping || !client}
              onClick={() => void stop()}
              aria-label={t("stopAria")}
              data-testid="companion-fusion-run-stop"
            >
              <SquareIcon className="size-3" aria-hidden />
              {t("stop")}
            </Button>
          ) : null}
          {dismissable ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={() => onDismiss(run.rowId)}
              aria-label={t("dismissAria")}
              data-testid="companion-fusion-run-dismiss"
            >
              <XIcon className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-2 space-y-2 text-muted-foreground">
        {stage === "queued" ? <p data-testid="companion-fusion-run-queued">{t("queued")}</p> : null}
        {stage === "undelivered" ? (
          <p className="text-destructive" data-testid="companion-fusion-run-undelivered">
            {t("undelivered", { reason: row?.lastError ?? tReason("unknownDelivery") })}
          </p>
        ) : null}
        {stage === "starting" ? <p>{t("starting")}</p> : null}
        {stage === "refused" && refusal ? (
          <p className="text-destructive" data-testid="companion-fusion-run-refused">
            {t("refused", { reason: reasonText(refusal.code) })}
          </p>
        ) : null}
        {stage === "following" && !terminal ? (
          follow?.error ? (
            <p data-testid="companion-fusion-run-retrying">
              {t("retrying", { seq: follow.lastSeq + 1 })}
            </p>
          ) : (
            <p>{t("running")}</p>
          )
        ) : null}
        {follow?.historyExpired ? (
          <p
            className="text-amber-600 dark:text-amber-400"
            data-testid="companion-fusion-run-history-expired"
          >
            {t("historyExpired")}
          </p>
        ) : null}
        {terminal && follow?.error ? (
          <p className="text-destructive" data-testid="companion-fusion-run-refused">
            {t("refused", { reason: reasonText(follow.error.code) })}
          </p>
        ) : null}
        {terminal && summary?.status === "succeeded" ? (
          <div className="space-y-1 text-foreground">
            <p className="font-medium">{t("answer")}</p>
            {answer ? (
              <p
                className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words"
                data-testid="companion-fusion-run-answer"
              >
                {answer}
              </p>
            ) : (
              <p className="text-muted-foreground">
                {follow?.resultExpired ? t("answerExpired") : t("noAnswer")}
              </p>
            )}
          </div>
        ) : null}
        {summary ? (
          <Collapsible>
            <CollapsibleTrigger
              className="flex items-center gap-1 text-[11px] underline-offset-2 hover:underline"
              data-testid="companion-fusion-run-details-toggle"
            >
              <ChevronDownIcon className="size-3" aria-hidden />
              {t("details")}
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 text-[11px]">
              <FusionRunDetails summary={summary} />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </section>
  )
}

export interface CompanionFusionRunListProps {
  runs: readonly PendingCompanionRun[]
  onDismiss: (rowId: string) => void
  loadClient?: () => Promise<CompanionRunClient>
}

/** The runs started from this conversation on this device, newest last. */
export function CompanionFusionRunList({
  runs,
  onDismiss,
  loadClient,
}: CompanionFusionRunListProps) {
  const t = useTranslations("routerFusionCompanion.run")
  if (runs.length === 0) return null
  return (
    <div
      role="region"
      aria-label={t("regionAria")}
      className="max-h-[45%] shrink-0 space-y-2 overflow-y-auto px-3 pb-2"
      data-testid="companion-fusion-runs"
    >
      {runs.map((run) => (
        <CompanionFusionRunView
          key={run.rowId}
          run={run}
          onDismiss={onDismiss}
          {...(loadClient ? { loadClient } : {})}
        />
      ))}
    </div>
  )
}
