"use client"

/**
 * What this Bot has actually been asked to do lately, and what became of it.
 *
 * The queue is the only place a failure is legible. An `ExecutionRun` exists
 * for a delivery that got as far as running, so `/agent-runs` shows those, but
 * a delivery that dead-lettered before its first attempt, or that is parked
 * waiting on a person, has no run to show and is invisible everywhere else.
 *
 * Retry stays in the delivery queue. Terminal failures get a fresh linked
 * execution, while a dead letter with a resumable run retains its checkpoints.
 */

import { useTranslations } from "next-intl"
import Link from "next/link"
import { botEventId } from "@/lib/bot/events/envelope"
import { RotateCcwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useBotControlActions, useBotWriteReadiness } from "@/hooks/bots/use-bot-control-writes"
import { useBotDeliveries } from "@/hooks/bots/use-bot-deliveries"
import { BOT_WRITE_COMMANDS } from "@/lib/bot/control-writes"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"
import type { BotDeliveryStatus, BotEventDeliveryRow } from "@/lib/db/bot-types"
import { cn } from "@/lib/utils"

import { useBotRelativeTime } from "../bot-visuals"

/**
 * A hue per status, exhaustive over the union so a ninth status is a type
 * error here rather than an unpainted dot.
 *
 * `parked` is amber and not muted: a run waiting on a person is the state that
 * needs someone, and painting it like a settled row hides the only delivery on
 * the list that will never move on its own.
 */
const STATUS_DOT: Record<BotDeliveryStatus, string> = {
  pending: "bg-muted-foreground/40",
  leased: "bg-sky-500",
  running: "bg-sky-500",
  parked: "bg-amber-500",
  succeeded: "bg-emerald-500",
  failed: "bg-amber-500",
  deadletter: "bg-red-500",
  dismissed: "bg-muted-foreground/40",
}

function DeliveryRow({
  delivery,
  canReplay,
  busy,
  onReplay,
  successor,
  previousRunId,
}: {
  delivery: BotEventDeliveryRow
  canReplay: boolean
  busy: boolean
  onReplay: () => void
  successor?: BotEventDeliveryRow
  previousRunId?: string
}) {
  const t = useTranslations("bots")
  const relative = useBotRelativeTime()
  const replayable =
    !successor &&
    (delivery.status === "deadletter" ||
      ((delivery.status === "dismissed" || delivery.status === "failed") &&
        Boolean(delivery.runId)))

  return (
    <li
      className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0"
      data-testid={`bot-delivery-${delivery.id}`}
      data-status={delivery.status}
    >
      <span
        aria-hidden
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", STATUS_DOT[delivery.status])}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{delivery.type}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t(`delivery.status.${delivery.status}`)}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/80">
            {relative(delivery.receivedAt)}
          </span>
        </div>
        <p className="mt-0.5 break-words text-[11px] leading-snug text-muted-foreground">
          {t("delivery.attempts", { count: delivery.attempts })}
          {delivery.triggerId ? ` · ${delivery.triggerId}` : ""}
          {/* The error is the reason a person opened this section. Shown in
              full rather than truncated: half a stack trace is not a clue. */}
          {delivery.lastError ? ` · ${delivery.lastError}` : ""}
        </p>
        <div className="flex gap-2 text-[11px]">
          {delivery.runId ? (
            <Link
              href={`/agent-runs?run=${encodeURIComponent(delivery.runId)}`}
              className="underline"
            >
              {t("delivery.viewRun")}
            </Link>
          ) : null}
          {previousRunId ? (
            <Link
              href={`/agent-runs?run=${encodeURIComponent(previousRunId)}`}
              className="underline"
            >
              {t("delivery.previousRun")}
            </Link>
          ) : null}
          {successor ? (
            successor.runId ? (
              <Link
                href={`/agent-runs?run=${encodeURIComponent(successor.runId)}`}
                className="underline"
              >
                {t("delivery.retryRun")}
              </Link>
            ) : (
              <span>{t("delivery.retryQueued")}</span>
            )
          ) : null}
        </div>
      </div>
      {replayable ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 px-2 text-[11px]"
          disabled={!canReplay || busy}
          onClick={onReplay}
          data-testid={`bot-delivery-replay-${delivery.id}`}
        >
          {busy ? <Spinner className="size-3" /> : <RotateCcwIcon className="size-3" aria-hidden />}
          {t("delivery.replay")}
        </Button>
      ) : null}
    </li>
  )
}

export function BotDeliveriesSection({ row }: { row: BotConsoleRow }) {
  const t = useTranslations("bots")
  const { rows, loading } = useBotDeliveries(row.id)
  const readiness = useBotWriteReadiness(BOT_WRITE_COMMANDS.replayDelivery)
  const actions = useBotControlActions()

  if (loading) {
    return (
      <div className="flex flex-col gap-1.5" data-testid="bot-deliveries-loading">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <Empty className="border-none py-4">
        <EmptyHeader>
          <EmptyTitle className="text-sm">{t("delivery.emptyTitle")}</EmptyTitle>
          <EmptyDescription className="text-xs">{t("delivery.emptyBody")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const successorFor = (delivery: BotEventDeliveryRow) =>
    rows.find(
      (candidate) => candidate.eventId === botEventId(delivery.source, `retry:${delivery.id}`)
    )
  const hasRetryable = rows.some(
    (delivery) =>
      !successorFor(delivery) &&
      (delivery.status === "deadletter" ||
        ((delivery.status === "dismissed" || delivery.status === "failed") &&
          Boolean(delivery.runId)))
  )

  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y" data-testid="bot-deliveries">
        {rows.map((delivery) => (
          <DeliveryRow
            key={delivery.id}
            delivery={delivery}
            canReplay={readiness.can}
            busy={actions.pending.has(`delivery:${delivery.id}`)}
            onReplay={() => void actions.replayDelivery(delivery.id)}
            successor={successorFor(delivery)}
            previousRunId={
              rows.find(
                (previous) =>
                  previous.eventId === delivery.envelope.provenance?.causationEventIds?.[0]
              )?.runId
            }
          />
        ))}
      </ul>
      {hasRetryable && !readiness.can ? (
        <p
          className="text-[11px] leading-snug text-muted-foreground"
          data-testid="bot-replay-blocked"
        >
          {t(`write.reason.${readiness.availability.reason}`)}
        </p>
      ) : null}
    </div>
  )
}
