"use client"

/**
 * The durable operation journal, expanded.
 *
 * `siteOperations` / `siteOperationEvents` are the crash-recovery and
 * provider-reconciliation record ADR-0084 specifies, and the console used to
 * render them as a type, a status chip, and the sentence "N events" — the
 * attempt count, the provider request id, the error message, and every event
 * message were all dropped. When an upload failed there was nowhere to read
 * why. This shows the whole row and expands into the event stream.
 */
import { useTranslations, useFormatter, useNow } from "next-intl"
import { ChevronDownIcon, CopyIcon, RefreshCwIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useCopy } from "@/hooks/ui"
import { eventsForOperation, operationFailureText } from "@/lib/sites/console-model"
import { cn } from "@/lib/utils"
import type { SiteOperationEventRow, SiteOperationRow } from "@/types/sites"
import {
  SITE_EVENT_TONE,
  SITE_OPERATION_FACE,
  SITE_TONE_DOT,
  SITE_TONE_TEXT,
  SiteStatusPill,
} from "./site-status"

export interface SiteOperationTimelineProps {
  events: readonly SiteOperationEventRow[]
}

/** The event stream for one operation, oldest first, on a vertical rail. */
export function SiteOperationTimeline({ events }: SiteOperationTimelineProps) {
  const t = useTranslations("sites")
  const format = useFormatter()

  if (events.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{t("operations.noEvents")}</p>
  }

  return (
    <ol
      className="relative space-y-0 border-t bg-muted/20 py-2 pl-8 pr-3"
      data-testid="site-operation-events"
    >
      <span aria-hidden className="absolute bottom-3 left-[15px] top-3 w-px bg-border" />
      {events.map((event) => {
        const tone = SITE_EVENT_TONE[event.type]
        return (
          <li
            key={event.id}
            className="relative flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5"
          >
            <span
              aria-hidden
              className={cn(
                "absolute -left-[17px] top-2.5 size-2 rounded-full ring-2 ring-background",
                SITE_TONE_DOT[tone]
              )}
            />
            <span className="w-6 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
              {String(event.sequence).padStart(2, "0")}
            </span>
            <span className={cn("shrink-0 text-xs font-medium", SITE_TONE_TEXT[tone])}>
              {t(`operationEvent.${event.type}`)}
            </span>
            <span className="min-w-0 flex-1 break-words text-xs text-muted-foreground">
              {event.message ?? "—"}
            </span>
            <time
              dateTime={new Date(event.createdAt).toISOString()}
              className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground"
            >
              {format.dateTime(new Date(event.createdAt), {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </time>
          </li>
        )
      })}
    </ol>
  )
}

export interface SiteOperationJournalProps {
  operations: readonly SiteOperationRow[]
  events: readonly SiteOperationEventRow[]
  /** Re-read one operation on demand — useful for a stuck `waiting-reconcile`. */
  onRefresh?: (operationId: string) => void
  refreshDisabled?: boolean
  refreshTitle?: string
}

export function SiteOperationJournal({
  operations,
  events,
  onRefresh,
  refreshDisabled,
  refreshTitle,
}: SiteOperationJournalProps) {
  const t = useTranslations("sites")
  const format = useFormatter()
  const now = useNow()
  const { copy, copied } = useCopy()

  if (operations.length === 0) {
    return (
      <Empty role="status" className="gap-3 px-4 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RefreshCwIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="text-sm">{t("operations.title")}</EmptyTitle>
          <EmptyDescription className="max-w-[20rem] text-xs">
            {t("operations.empty")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  // Newest first: the thing that just failed is the thing being looked for.
  const ordered = [...operations].sort((left, right) => right.updatedAt - left.updatedAt)

  return (
    <div className="overflow-hidden rounded-xl border" data-testid="site-operation-journal">
      {ordered.map((operation) => {
        const failure = operationFailureText(operation, events)
        const operationEvents = eventsForOperation(events, operation.id)
        return (
          <Collapsible key={operation.id} className="border-b last:border-b-0">
            <CollapsibleTrigger
              className="group flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 motion-reduce:transition-none"
              data-testid={`site-operation-${operation.id}`}
            >
              <span className="shrink-0 text-sm font-medium">
                {t(`operationType.${operation.type}`)}
              </span>
              <SiteStatusPill
                face={SITE_OPERATION_FACE[operation.status]}
                label={t(`operationStatus.${operation.status}`)}
              />
              {operation.attemptCount > 1 ? (
                <Badge variant="outline" className="shrink-0 font-normal tabular-nums">
                  {t("operations.attempts", { count: operation.attemptCount })}
                </Badge>
              ) : null}
              {failure ? (
                <span className="min-w-0 flex-1 truncate text-xs text-destructive" title={failure}>
                  {failure}
                </span>
              ) : (
                <span className="min-w-0 flex-1" />
              )}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {format.relativeTime(new Date(operation.updatedAt), now)}
              </span>
              <ChevronDownIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              />
            </CollapsibleTrigger>

            <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up motion-reduce:animate-none">
              <div className="flex flex-wrap items-center gap-2 border-t bg-muted/20 px-3 py-2 text-xs">
                <span className="text-muted-foreground">{t("operations.providerRequestId")}</span>
                <code className="min-w-0 truncate font-mono">
                  {operation.providerRequestId ?? "—"}
                </code>
                {operation.providerRequestId ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("actions.copyUrl")}
                    onClick={() => copy(operation.providerRequestId as string)}
                  >
                    <CopyIcon aria-hidden className={cn("size-3", copied && "text-success")} />
                  </Button>
                ) : null}
                {onRefresh ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="ml-auto"
                    disabled={refreshDisabled}
                    title={refreshTitle}
                    onClick={() => onRefresh(operation.id)}
                  >
                    <RefreshCwIcon aria-hidden className="size-3" />
                    {t("actions.refreshOperation")}
                  </Button>
                ) : null}
              </div>
              <SiteOperationTimeline events={operationEvents} />
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}
