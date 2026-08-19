"use client"

/**
 * The third column of the `/logs` Traces channel: everything one span knows.
 *
 * The waterfall row can only afford a name, a bar and a duration, and the
 * `LogDetailPanel`'s agent-trace section only ever showed the span that
 * happened to be selected in the log list. This pane is the span's full
 * record — identity, timing, model, token/cache/cost accounting, finish
 * reasons, hand-off, mid-span events, error, and the PII-gated content
 * previews — plus the two jumps that make a span actionable: into the log
 * stream focused on its trace, and into the session that produced it.
 *
 * Pure presentation. The Dexie read lives in `useTraceDetail`, one level up.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, ExternalLinkIcon, ScrollTextIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { useCopy } from "@/hooks/ui"
import { formatMs, formatTokens, formatUsd } from "@/lib/observability/format-utils"
import { cn } from "@/lib/utils"
import type { AgentTraceSpan, SpanStatus } from "@/types/agent-trace/span"

export interface TraceSpanDetailProps {
  span: AgentTraceSpan | null
  /** Trace start, so event offsets read as `+120ms` rather than epoch ms. */
  traceStart: number
  /** Opens the Logs channel focused on this span's trace. */
  onOpenInLogs?: (traceId: string) => void
  /** Opens the Logs channel focused on this span's session. */
  onOpenSession?: (sessionId: string) => void
  className?: string
}

/**
 * Effective lifecycle state. `status` is absent on pre-v172 rows, which meant
 * "settled" at the time they were written — read them the way they were meant,
 * rather than rendering an empty badge.
 */
export function resolveSpanStatus(span: AgentTraceSpan): SpanStatus {
  if (span.status) return span.status
  return span.errorType || span.errorMessage ? "error" : "ok"
}

const STATUS_TONE: Record<SpanStatus, string> = {
  ok: "border-success/40 text-success",
  error: "border-destructive/50 text-destructive",
  pending: "border-warning/40 text-warning",
  incomplete: "border-warning/40 text-warning",
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium break-words">{children}</span>
    </div>
  )
}

function Section({
  title,
  children,
  testid,
}: {
  title: string
  children: React.ReactNode
  testid?: string
}) {
  return (
    <section className="space-y-1" data-testid={testid}>
      <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      {children}
    </section>
  )
}

function CopyableId({ label, value }: { label: string; value: string }) {
  const { copied, copy } = useCopy()
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate font-mono" title={value}>
          {value}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`${label}: ${value}`}
          onClick={() => void copy(value)}
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </Button>
      </div>
    </div>
  )
}

export function TraceSpanDetail({
  span,
  traceStart,
  onOpenInLogs,
  onOpenSession,
  className,
}: TraceSpanDetailProps) {
  const t = useTranslations("logging.workspace.traces.span")

  const usage = span?.usage
  const totalTokens = useMemo(() => {
    if (!usage) return null
    return usage.inputTokens + usage.outputTokens
  }, [usage])

  if (!span) {
    return (
      <div
        className={cn(
          "flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground",
          className
        )}
        data-testid="trace-span-detail-empty"
      >
        {t("empty")}
      </div>
    )
  }

  const status = resolveSpanStatus(span)
  const events = span.events ?? []
  const metadataEntries = Object.entries(span.metadata ?? {})

  return (
    <ScrollArea className={cn("h-full", className)}>
      <div className="space-y-4 p-3" data-testid="trace-span-detail">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={cn("text-[10px]", STATUS_TONE[status])}>
              {t(`status.${status}`)}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {span.operationName}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {span.surface}
            </Badge>
            {span.spanKind && span.spanKind !== "internal" && (
              <Badge variant="outline" className="text-[10px]">
                {span.spanKind}
              </Badge>
            )}
          </div>
          <h3 className="text-sm font-semibold break-words">
            {span.toolName ?? span.agentName ?? span.operationName}
          </h3>
        </div>

        <Section title={t("timing")}>
          <Row label={t("duration")}>{formatMs(span.durationMs ?? 0)}</Row>
          <Row label={t("startedAt")}>{new Date(span.startTime).toLocaleTimeString()}</Row>
          <Row label={t("offset")}>+{formatMs(Math.max(0, span.startTime - traceStart))}</Row>
        </Section>

        <Separator />

        <Section title={t("model")}>
          <Row label={t("provider")}>{span.providerName}</Row>
          {span.requestModel && <Row label={t("requestModel")}>{span.requestModel}</Row>}
          {span.responseModel && <Row label={t("responseModel")}>{span.responseModel}</Row>}
          {span.agentName && <Row label={t("agent")}>{span.agentName}</Row>}
          {span.pluginId && <Row label={t("plugin")}>{span.pluginId}</Row>}
          {span.finishReasons && span.finishReasons.length > 0 && (
            <Row label={t("finishReasons")}>{span.finishReasons.join(", ")}</Row>
          )}
        </Section>

        {usage && (
          <>
            <Separator />
            <Section title={t("usage")} testid="trace-span-usage">
              <Row label={t("inputTokens")}>{formatTokens(usage.inputTokens)}</Row>
              <Row label={t("outputTokens")}>{formatTokens(usage.outputTokens)}</Row>
              {usage.cacheReadTokens > 0 && (
                <Row label={t("cacheRead")}>{formatTokens(usage.cacheReadTokens)}</Row>
              )}
              {usage.cacheCreationTokens > 0 && (
                <Row label={t("cacheWrite")}>
                  {formatTokens(usage.cacheCreationTokens)}
                  {(usage.cacheCreation5mTokens ?? usage.cacheCreation1hTokens) !== undefined && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      {t("cacheWriteSplit", {
                        short: formatTokens(usage.cacheCreation5mTokens ?? 0),
                        long: formatTokens(usage.cacheCreation1hTokens ?? 0),
                      })}
                    </span>
                  )}
                </Row>
              )}
              {totalTokens !== null && (
                <Row label={t("totalTokens")}>{formatTokens(totalTokens)}</Row>
              )}
              {typeof span.costUsdEstimate === "number" && (
                <Row label={t("cost")}>{formatUsd(span.costUsdEstimate)}</Row>
              )}
            </Section>
          </>
        )}

        {span.handoff && (
          <>
            <Separator />
            <Section title={t("handoff")} testid="trace-span-handoff">
              <Row label={t("handoffFrom")}>{span.handoff.fromAgent}</Row>
              <Row label={t("handoffTo")}>{span.handoff.toAgent}</Row>
              {span.handoff.reason && <Row label={t("handoffReason")}>{span.handoff.reason}</Row>}
            </Section>
          </>
        )}

        {(span.errorType || span.errorMessage) && (
          <>
            <Separator />
            <Section title={t("error")} testid="trace-span-error">
              {span.errorType && <Row label={t("errorType")}>{span.errorType}</Row>}
              {span.errorMessage && (
                <p className="rounded-md bg-destructive/5 p-2 text-xs break-words text-destructive">
                  {span.errorMessage}
                </p>
              )}
            </Section>
          </>
        )}

        {events.length > 0 && (
          <>
            <Separator />
            <Section title={t("events", { count: events.length })} testid="trace-span-events">
              <ul className="space-y-1 text-xs">
                {events.map((event, index) => (
                  <li key={`${event.name}-${index}`} className="flex gap-2">
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      +{formatMs(Math.max(0, event.at - span.startTime))}
                    </span>
                    <span className="min-w-0 break-words">{event.name}</span>
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}

        {(span.inputPreview || span.outputPreview) && (
          <>
            <Separator />
            <Section title={t("content")} testid="trace-span-content">
              <p className="text-[11px] text-muted-foreground">{t("contentHint")}</p>
              {span.inputPreview && (
                <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px] whitespace-pre-wrap">
                  {span.inputPreview}
                </pre>
              )}
              {span.outputPreview && (
                <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px] whitespace-pre-wrap">
                  {span.outputPreview}
                </pre>
              )}
            </Section>
          </>
        )}

        {metadataEntries.length > 0 && (
          <>
            <Separator />
            <Section title={t("metadata")} testid="trace-span-metadata">
              {metadataEntries.map(([key, value]) => (
                <Row key={key} label={key}>
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </Row>
              ))}
            </Section>
          </>
        )}

        <Separator />

        <Section title={t("identity")}>
          <CopyableId label={t("traceId")} value={span.traceId} />
          <CopyableId label={t("spanId")} value={span.spanId} />
          {span.parentSpanId && <CopyableId label={t("parentSpanId")} value={span.parentSpanId} />}
          <CopyableId label={t("sessionId")} value={span.sessionId} />
          {span.runId && <CopyableId label={t("runId")} value={span.runId} />}
        </Section>

        <div className="flex flex-col gap-1.5">
          {onOpenInLogs && (
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={() => onOpenInLogs(span.traceId)}
              data-testid="trace-span-open-logs"
            >
              <ScrollTextIcon className="mr-1.5 size-3.5" />
              {t("openInLogs")}
            </Button>
          )}
          {onOpenSession && span.sessionId && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={() => onOpenSession(span.sessionId)}
              data-testid="trace-span-open-session"
            >
              <ExternalLinkIcon className="mr-1.5 size-3.5" />
              {t("openSession")}
            </Button>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

export default TraceSpanDetail
