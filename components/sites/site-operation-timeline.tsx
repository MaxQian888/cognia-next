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
import { memo, useMemo, useRef } from "react"
import { useTranslations, useFormatter, useNow } from "next-intl"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronDownIcon, CopyIcon, RefreshCwIcon, XCircleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useCopy } from "@/hooks/ui"
import { useSiteOperationEvents } from "@/hooks/sites/use-site-operation-events"
import { operationFailureText } from "@/lib/sites/console-model"
import { cn } from "@/lib/utils"
import type { SiteOperationEventRow, SiteOperationRow } from "@/types/sites"
import {
  SITE_EVENT_TONE,
  SITE_OPERATION_FACE,
  SITE_TONE_DOT,
  SITE_TONE_TEXT,
  SiteStatusPill,
} from "./site-status"

/** Statuses that can no longer change, so cancelling them is meaningless. */
const TERMINAL_STATUSES = new Set<SiteOperationRow["status"]>(["succeeded", "failed", "cancelled"])

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
  /** Re-read one operation on demand — useful for a stuck `waiting-reconcile`. */
  onRefresh?: (operationId: string) => void
  /** Abandon an operation that will never finish. Only offered while non-terminal. */
  onCancel?: (operationId: string) => void
  refreshDisabled?: boolean
  refreshTitle?: string
}

/**
 * The event rail for one operation, loaded on demand.
 *
 * Mounted inside `CollapsibleContent`, which Radix unmounts while closed — so a
 * journal nobody has expanded issues zero event queries, and expanding one row
 * reads exactly that row's events instead of every operation's.
 */
function SiteOperationTimelineLoader({ operationId }: { operationId: string }) {
  const events = useSiteOperationEvents(operationId)
  return <SiteOperationTimeline events={events} />
}

interface SiteOperationJournalRowProps {
  operation: SiteOperationRow
  onRefresh?: (operationId: string) => void
  onCancel?: (operationId: string) => void
  refreshDisabled?: boolean
  refreshTitle?: string
}

/**
 * One operation. Memoized because the journal is virtualized and the console
 * re-renders on every operation write — a build in flight would otherwise
 * repaint every visible row on each transition.
 */
const SiteOperationJournalRow = memo(function SiteOperationJournalRow({
  operation,
  onRefresh,
  onCancel,
  refreshDisabled,
  refreshTitle,
}: SiteOperationJournalRowProps) {
  const t = useTranslations("sites")
  const format = useFormatter()
  const now = useNow()
  const { copy, copied } = useCopy()
  const failure = operationFailureText(operation)
  return (
    <Collapsible key={operation.id} className="border-b last:border-b-0">
      <CollapsibleTrigger
        className="group flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 motion-reduce:transition-none"
        data-testid={`site-operation-${operation.id}`}
      >
        <span className="shrink-0 text-sm font-medium">{t(`operationType.${operation.type}`)}</span>
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
          <code className="min-w-0 truncate font-mono">{operation.providerRequestId ?? "—"}</code>
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
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {onRefresh ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={refreshDisabled}
                title={refreshTitle}
                onClick={() => onRefresh(operation.id)}
              >
                <RefreshCwIcon aria-hidden className="size-3" />
                {t("actions.refreshOperation")}
              </Button>
            ) : null}
            {onCancel && !TERMINAL_STATUSES.has(operation.status) ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                title={t("operations.cancelHint")}
                onClick={() => onCancel(operation.id)}
                data-testid={`site-operation-cancel-${operation.id}`}
              >
                <XCircleIcon aria-hidden className="size-3" />
                {t("actions.cancelOperation")}
              </Button>
            ) : null}
          </span>
        </div>
        <SiteOperationTimelineLoader operationId={operation.id} />
      </CollapsibleContent>
    </Collapsible>
  )
})

export function SiteOperationJournal({
  operations,
  onRefresh,
  onCancel,
  refreshDisabled,
  refreshTitle,
}: SiteOperationJournalProps) {
  const t = useTranslations("sites")
  // Newest first: the thing that just failed is the thing being looked for.
  // Above the empty-state return — a hook cannot sit behind a conditional.
  const ordered = useMemo(
    () => [...operations].sort((left, right) => right.updatedAt - left.updatedAt),
    [operations]
  )
  // One row per operation, several per build, kept forever. Collapsed rows are
  // uniform; `measureElement` corrects the ones the user expands.
  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: ordered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 46,
    overscan: 8,
    getItemKey: (index) => ordered[index]?.id ?? index,
  })

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

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto rounded-xl border"
      data-testid="site-operation-journal"
    >
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const operation = ordered[virtualRow.index]
          if (!operation) return null
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <SiteOperationJournalRow
                operation={operation}
                onRefresh={onRefresh}
                onCancel={onCancel}
                refreshDisabled={refreshDisabled}
                refreshTitle={refreshTitle}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
