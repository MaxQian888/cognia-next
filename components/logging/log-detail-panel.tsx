"use client"

/**
 * LogDetailPanel
 *
 * Enhanced log detail view with JSON syntax highlighting,
 * parsed stack trace frames, related logs by traceId,
 * tag badges, and field-level copy.
 */

import { useState, useMemo, useCallback } from "react"
import { useTranslations, useLocale } from "next-intl"
import { toast } from "sonner"
import {
  X,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Tag,
  Clock,
  Layers,
  Hash,
  FileCode,
  Bookmark,
  BookmarkCheck,
  Zap,
  Coins,
  CheckCircle2,
  XCircle,
  Wrench,
  Brain,
  Crosshair,
  Filter,
  Waypoints,
} from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  StackTrace,
  StackTraceActions,
  StackTraceContent,
  StackTraceCopyButton,
  StackTraceError,
  StackTraceErrorMessage,
  StackTraceErrorType,
  StackTraceExpandButton,
  StackTraceFrames,
  StackTraceHeader,
} from "@/components/ai-elements/stack-trace"
import { cn } from "@/lib/utils"
import { openFileViewer } from "@/lib/file-viewer/open"
import {
  AGENT_TRACE_MODULE,
  getAgentTraceLogData,
  type AgentTraceLogData,
} from "@cognia/agent-trace/log-adapter"
import { AgentTraceTree } from "./agent-trace-tree"
import {
  LIVE_TRACE_EVENT_ICONS,
  LIVE_TRACE_EVENT_COLORS,
  formatDuration,
  formatTokens,
} from "@/lib/agent"
import { formatCost } from "@cognia/agent-trace/cost-formatter"
import type { AgentTraceEventType } from "@/types/agent/agent-trace"
import type { StructuredLogEntry } from "@cognia/logging"
import { LEVEL_THEME } from "@cognia/logging/level-theme"

export interface LogDetailPanelProps {
  log: StructuredLogEntry
  relatedLogs?: StructuredLogEntry[]
  isBookmarked?: boolean
  onClose?: () => void
  onToggleBookmark?: (id: string) => void
  onSelectRelated?: (log: StructuredLogEntry) => void
  /** Steps the selection to the previous/next log in the visible list. */
  onNavigate?: (delta: -1 | 1) => void
  /** 1-based position of this log in the visible list, for the header. */
  navPosition?: { index: number; total: number }
  /*
   * Pivots out of the entry. The pane used to be a dead end: it showed the
   * trace and session ids as text, and narrowing the list to either meant
   * closing it, hovering the row and finding the right icon. Each is offered
   * only when it would change something.
   */
  /** Narrow the list to this entry's trace. */
  onFocusTrace?: () => void
  /** Narrow the list to this entry's session. */
  onFocusSession?: () => void
  /** Open this entry's trace in the trace explorer (the Traces channel). */
  onOpenTrace?: () => void
  /**
   * `panel` (default) is the standalone pane: header, navigation, its own
   * scroll. `embedded` is the body only, for a host that already renders the
   * entry's level, title, time and trace in a header of its own and scrolls
   * the whole column — the Diagnostics channel used to nest the full pane
   * inside its detail, so the message, timestamp and trace id printed twice
   * and two scroll regions fought over one column.
   */
  variant?: "panel" | "embedded"
  className?: string
}

/** Span operations the trace detail names in words (`SpanOperationName`). */
const KNOWN_OPERATIONS = new Set([
  "invoke_agent",
  "execute_tool",
  "chat",
  "invoke_workflow",
  "retrieval",
  "embeddings",
])

/** How many neighbours either side of the entry the related list keeps. */
const RELATED_CONTEXT = 20

/** Radix wraps a ScrollArea's content in `display: table`, which sizes it to
 * its widest unbreakable child — a long source path or a related-log row — and
 * clips everything else at that width. */
const SCROLL_AREA_BLOCK = "[&_[data-slot=scroll-area-viewport]>div]:!block"

function JsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === "string") {
    // i18n-exempt: JSON syntax literal in the raw log value renderer
    return <span className="text-chart-2">&quot;{value}&quot;</span>
  }
  if (typeof value === "number") {
    return <span className="text-chart-3">{value}</span>
  }
  if (typeof value === "boolean") {
    return <span className="text-chart-1">{String(value)}</span>
  }
  if (value === null) {
    // i18n-exempt: JSON syntax literal in the raw log value renderer
    return <span className="text-chart-1">null</span>
  }
  return <span>{String(value)}</span>
}

function JsonTreeNode({
  label,
  value,
  depth = 0,
  defaultExpanded = depth === 0,
}: {
  label?: string
  value: unknown
  depth?: number
  defaultExpanded?: boolean
}) {
  const isArray = Array.isArray(value)
  const isObject = value !== null && typeof value === "object" && !isArray
  const entries = isArray
    ? (value as unknown[]).map((entry, index) => [String(index), entry] as const)
    : isObject
      ? Object.entries(value as Record<string, unknown>)
      : []
  const isCollapsible = isArray || isObject
  const [open, setOpen] = useState(defaultExpanded)
  const t = useTranslations("logging")

  if (!isCollapsible) {
    return (
      <div className="font-mono text-xs leading-5" style={{ paddingLeft: depth * 12 }}>
        {label ? (
          <>
            {/* i18n-exempt: JSON syntax literal in the raw log value renderer */}
            <span className="text-chart-4">&quot;{label}&quot;</span>
            <span>: </span>
          </>
        ) : null}
        <JsonPrimitive value={value} />
      </div>
    )
  }

  const wrapperOpen = isArray ? "[" : "{"
  const wrapperClose = isArray ? "]" : "}"

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div style={{ paddingLeft: depth * 12 }}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs font-mono hover:text-foreground">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {/* i18n-exempt: JSON syntax literal in the raw log value renderer */}
          {label ? <span className="text-chart-4">&quot;{label}&quot;:</span> : null}
          <span>{wrapperOpen}</span>
          <span className="text-muted-foreground">
            {isArray
              ? t("detail.jsonItems", { count: entries.length })
              : t("detail.jsonKeys", { count: entries.length })}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-1 pt-1">
          {entries.map(([entryLabel, entryValue]) => (
            <JsonTreeNode
              key={`${label || "root"}-${entryLabel}`}
              label={isArray ? `[${entryLabel}]` : entryLabel}
              value={entryValue}
              depth={depth + 1}
              defaultExpanded={depth === 0}
            />
          ))}
          <div
            className="font-mono text-xs leading-5 text-muted-foreground"
            style={{ paddingLeft: 12 }}
          >
            {wrapperClose}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function CopyButton({
  text,
  label,
  showText = false,
}: {
  /** Copy payload — pass a function to defer expensive serialization to click time. */
  text: string | (() => string)
  label: string
  showText?: boolean
}) {
  const [copied, setCopied] = useState(false)

  const t = useTranslations("logging")
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t("panel.copyFailed"))
    }
  }, [text, t])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={showText ? "outline" : "ghost"}
          size={showText ? "sm" : "icon"}
          className={cn(showText ? "h-7 gap-1.5 px-2 text-xs" : "h-6 w-6 shrink-0")}
          aria-label={showText ? undefined : label}
          onClick={() => void handleCopy()}
        >
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          {showText ? <span>{label}</span> : null}
        </Button>
      </TooltipTrigger>
      {!showText ? <TooltipContent>{label}</TooltipContent> : null}
    </Tooltip>
  )
}

/**
 * Agent trace detail section — renders structured trace data
 * (tokens, cost, tool info, duration, etc.) when a log entry
 * originates from the agent-trace module.
 */
function AgentTraceDetailSection({
  data,
  t,
}: {
  data: AgentTraceLogData
  t: ReturnType<typeof useTranslations>
}) {
  const EventIcon = data.eventType
    ? LIVE_TRACE_EVENT_ICONS[data.eventType as AgentTraceEventType]
    : undefined
  const eventColor = data.eventType
    ? LIVE_TRACE_EVENT_COLORS[data.eventType as AgentTraceEventType]
    : undefined

  return (
    <>
      <Separator />
      <div className="space-y-3">
        {/* Event type + status header */}
        <div className="flex items-center gap-2 flex-wrap">
          {EventIcon && (
            <EventIcon className={cn("h-4 w-4", eventColor ?? "text-muted-foreground")} />
          )}
          {/* The span's operation, in words. It printed the raw OTel token
              ("execute_tool" → "execute tool") in every language; an
              operation this build does not know is shown as written, in mono,
              so it still reads as an identifier rather than prose. */}
          <Badge
            variant="outline"
            className={cn(
              "text-xs",
              data.eventType && !KNOWN_OPERATIONS.has(data.eventType) && "font-mono"
            )}
            data-testid="log-detail-trace-operation"
          >
            {!data.eventType
              ? t("trace.unknownEvent")
              : KNOWN_OPERATIONS.has(data.eventType)
                ? t(`trace.operations.${data.eventType as "chat"}`)
                : data.eventType}
          </Badge>
          {data.success === true && (
            <Badge variant="secondary" className="text-xs gap-1 bg-success/15 text-success">
              <CheckCircle2 className="h-3 w-3" />
              {t("trace.success")}
            </Badge>
          )}
          {data.success === false && (
            <Badge variant="destructive" className="text-xs gap-1">
              <XCircle className="h-3 w-3" />
              {t("trace.failed")}
            </Badge>
          )}
          {data.modelId && (
            <Badge variant="secondary" className="text-[10px] font-mono">
              {data.modelId}
            </Badge>
          )}
        </div>

        {/* Tool name and args */}
        {data.toolName && (
          <div className="flex items-center gap-2">
            <Wrench className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground">{t("trace.toolName")}:</span>
            <Badge variant="outline" className="text-xs font-mono">
              {data.toolName}
            </Badge>
          </div>
        )}

        {data.toolArgs && (
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground motion-safe:transition-colors">
              <ChevronRight className="h-3 w-3" />
              {t("trace.toolArgs")}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ScrollArea className="max-h-[200px] mt-1 rounded bg-muted/50">
                <pre className="text-[11px] font-mono p-2 whitespace-pre">{data.toolArgs}</pre>
              </ScrollArea>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Duration */}
        {data.duration !== undefined && (
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground">{t("trace.duration")}:</span>
            <span className="text-xs font-mono">{formatDuration(data.duration)}</span>
          </div>
        )}

        {/* Token usage */}
        {data.tokenUsage && data.tokenUsage.totalTokens > 0 && (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground">{t("trace.tokenUsage")}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 pl-5">
              <div className="text-center">
                <div className="text-[10px] text-muted-foreground">{t("trace.promptTokens")}</div>
                <div className="text-xs font-mono font-medium">
                  {formatTokens(data.tokenUsage.promptTokens)}
                </div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-muted-foreground">
                  {t("trace.completionTokens")}
                </div>
                <div className="text-xs font-mono font-medium">
                  {formatTokens(data.tokenUsage.completionTokens)}
                </div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-muted-foreground">{t("trace.totalTokens")}</div>
                <div className="text-xs font-mono font-semibold">
                  {formatTokens(data.tokenUsage.totalTokens)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Cost estimate */}
        {data.costEstimate && data.costEstimate.totalCost > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <Coins className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground">{t("trace.costEstimate")}:</span>
            <span className="text-xs font-mono">{formatCost(data.costEstimate.totalCost)}</span>
            <span className="text-[10px] text-muted-foreground">
              ({t("trace.costInputPrefix")} {formatCost(data.costEstimate.inputCost)},{" "}
              {t("trace.costOutputPrefix")} {formatCost(data.costEstimate.outputCost)})
            </span>
          </div>
        )}

        {/* Error message */}
        {data.error && (
          <Alert variant="destructive" className="py-2">
            <AlertDescription className="text-xs break-words">{data.error}</AlertDescription>
          </Alert>
        )}

        {/* Response preview */}
        {data.responsePreview && (
          <div>
            <span className="text-xs text-muted-foreground block mb-1">
              {t("trace.responsePreview")}
            </span>
            <p className="text-xs text-muted-foreground/80 line-clamp-4 break-words">
              {data.responsePreview.slice(0, 300)}
              {data.responsePreview.length > 300 && "..."}
            </p>
          </div>
        )}

        {/* Files */}
        {data.files && data.files.length > 0 && (
          <div>
            <span className="text-xs text-muted-foreground block mb-1">{t("trace.files")}</span>
            <div className="space-y-0.5">
              {data.files.map((file) => (
                <div key={file} className="text-xs font-mono text-muted-foreground truncate">
                  {file}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step number */}
        {data.stepNumber !== undefined && (
          <div className="flex items-center gap-2">
            <Brain className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground">{t("trace.stepNumber")}:</span>
            <span className="text-xs font-mono">#{data.stepNumber}</span>
          </div>
        )}
      </div>
    </>
  )
}

export function LogDetailPanel({
  log,
  relatedLogs = [],
  isBookmarked = false,
  onClose,
  onToggleBookmark,
  onSelectRelated,
  onNavigate,
  navPosition,
  onFocusTrace,
  onFocusSession,
  onOpenTrace,
  variant = "panel",
  className,
}: LogDetailPanelProps) {
  const t = useTranslations("logging")
  const locale = useLocale()
  const embedded = variant === "embedded"

  const timestamp = new Date(log.timestamp)
  const timeStr = timestamp.toLocaleString(locale, {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  })

  /**
   * The trace's entries in the order they happened, with this one in its
   * place. The list used to be newest-first with the entry itself removed, so
   * "what led up to this" read bottom-to-top around a gap you had to infer.
   * Long traces keep `RELATED_CONTEXT` neighbours either side of the entry.
   */
  const related = useMemo(() => {
    const ordered = [...relatedLogs].sort((a, b) =>
      a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? -1 : 1
    )
    if (!ordered.some((entry) => entry.id === log.id) && log.traceId) {
      // A host that hands over only the neighbours still gets the entry placed.
      const at = ordered.findIndex((entry) => entry.timestamp > log.timestamp)
      ordered.splice(at < 0 ? ordered.length : at, 0, log)
    }
    const index = ordered.findIndex((entry) => entry.id === log.id)
    const start = Math.max(0, index - RELATED_CONTEXT)
    const window = ordered.slice(start, index + RELATED_CONTEXT + 1)
    const others = window.filter((entry) => entry.id !== log.id).length
    return { entries: others > 0 ? window : [], others, total: ordered.length - 1 }
  }, [relatedLogs, log])

  // Serialize on demand — stringifying a large `data` payload on every render
  // is one of the things that made opening the detail panel feel sluggish.
  const copyDataJson = useCallback(() => JSON.stringify(log.data, null, 2), [log.data])
  const copyEntryJson = useCallback(() => JSON.stringify(log, null, 2), [log])

  // The JSON tree only depends on `log.data`; memoizing the element keeps the
  // recursive Collapsible tree from re-rendering on unrelated parent updates
  // (e.g. relatedLogs churning on every poll).
  const dataTree = useMemo(() => (log.data ? <JsonTreeNode value={log.data} /> : null), [log.data])

  const hasPivots = Boolean(onFocusTrace || onFocusSession || onOpenTrace)

  const body = (
    <div className={cn("space-y-4", embedded ? "min-w-0" : "p-4")}>
      {!embedded && (
        <>
          {/* Message */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("detail.message")}
              </span>
              <CopyButton text={log.message} label={t("detail.copyMessage")} />
            </div>
            <p className="text-sm break-words whitespace-pre-wrap">{log.message}</p>
          </div>

          {/* Pivots and whole-entry copy. */}
          <div className="flex flex-wrap items-center gap-1.5" data-testid="log-detail-actions">
            {onFocusTrace && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                data-testid="log-detail-focus-trace"
                onClick={onFocusTrace}
              >
                <Crosshair className="h-3 w-3" />
                {t("detail.focusTrace")}
              </Button>
            )}
            {onFocusSession && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                data-testid="log-detail-focus-session"
                onClick={onFocusSession}
              >
                <Filter className="h-3 w-3" />
                {t("detail.focusSession")}
              </Button>
            )}
            {onOpenTrace && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                data-testid="log-detail-open-trace"
                onClick={onOpenTrace}
              >
                <Waypoints className="h-3 w-3" />
                {t("detail.openTrace")}
              </Button>
            )}
            <div className={cn(hasPivots && "ms-auto")}>
              <CopyButton text={copyEntryJson} label={t("detail.copyEntry")} showText />
            </div>
          </div>

          <Separator />
        </>
      )}

      {/* Metadata Grid — in the embedded body only what the host header does
          not already print (session, source), and nothing at all when the
          entry has neither. */}
      {(!embedded || log.sessionId || log.source) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {!embedded && (
            <>
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-muted-foreground">{t("detail.timestamp")}</p>
                  <p className="font-mono">{timeStr}</p>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-muted-foreground">{t("detail.module")}</p>
                  <p className="font-mono break-all">{log.module}</p>
                </div>
              </div>

              {log.traceId && (
                <div className="flex items-center gap-1.5 sm:col-span-2">
                  <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-muted-foreground">{t("panel.traceId")}</p>
                    <div className="flex items-center gap-1">
                      <p className="font-mono truncate" title={log.traceId}>
                        {log.traceId}
                      </p>
                      <CopyButton text={log.traceId} label={t("detail.copyTraceId")} />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {log.sessionId && (
            <div className="flex items-center gap-1.5 sm:col-span-2">
              <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-muted-foreground">{t("detail.sessionId")}</p>
                <div className="flex items-center gap-1">
                  <p className="font-mono truncate" title={log.sessionId}>
                    {log.sessionId}
                  </p>
                  <CopyButton text={log.sessionId} label={t("detail.copySessionId")} />
                </div>
              </div>
            </div>
          )}

          {log.source && (
            <div className="flex items-start gap-1.5 sm:col-span-2">
              <FileCode className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-muted-foreground">{t("panel.source")}</p>
                {/* A bundled chunk URL is one unbroken token; it has to be
                  allowed to break anywhere or it widens the whole pane. */}
                <p className="font-mono break-all">
                  {log.source.file}:{log.source.line}
                  {log.source.function && (
                    <span className="text-muted-foreground"> ({log.source.function})</span>
                  )}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tags */}
      {log.tags && log.tags.length > 0 && (
        <>
          <Separator />
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Tag className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">{t("detail.tags")}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {log.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Agent Trace Detail Section */}
      {log.module === AGENT_TRACE_MODULE &&
        (() => {
          const traceData = getAgentTraceLogData(log)
          return traceData ? <AgentTraceDetailSection data={traceData} t={t} /> : null
        })()}

      {/* Agent Trace Tree — parent → child span timeline for the same
          traceId. Rendered alongside the single-span detail above so the
          user can see the call graph at a glance. */}
      {log.module === AGENT_TRACE_MODULE && log.traceId && (
        <>
          <Separator />
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-2">
              {t("panel.agentTrace.tree.title")}
            </div>
            <AgentTraceTree traceId={log.traceId} activeSpanId={log.id} />
          </div>
        </>
      )}

      {/* Data (JSON tree) */}
      {log.data && !(log.module === AGENT_TRACE_MODULE) && (
        <>
          <Separator />
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground">{t("panel.data")}</span>
              <CopyButton text={copyDataJson} label={t("detail.copyJson")} showText />
            </div>
            <div className="overflow-x-auto rounded-md bg-muted/50 p-3">{dataTree}</div>
          </div>
        </>
      )}

      {/* Stack Trace (parsed frames) */}
      {log.stack && (
        <>
          <Separator />
          <div>
            <StackTrace
              trace={log.stack}
              defaultOpen
              onFilePathClick={(path, line, column) => openFileViewer(path, { line, column })}
            >
              <StackTraceHeader aria-label={t("panel.stackTrace")}>
                <StackTraceError>
                  <StackTraceErrorType />
                  <StackTraceErrorMessage />
                </StackTraceError>
                <StackTraceActions aria-label={t("detail.copyStack")}>
                  <StackTraceCopyButton aria-label={t("detail.copyStack")} />
                  <StackTraceExpandButton aria-label={t("panel.stackTrace")} />
                </StackTraceActions>
              </StackTraceHeader>
              <StackTraceContent maxHeight={320}>
                <StackTraceFrames showRawWhenEmpty />
              </StackTraceContent>
            </StackTrace>
          </div>
        </>
      )}

      {/* Related Logs (same traceId), chronological, with this entry in place */}
      {related.entries.length > 0 && (
        <>
          <Separator />
          <div data-testid="log-detail-related">
            <span className="text-xs font-medium text-muted-foreground mb-2 block">
              {t("detail.relatedLogs")} ({related.total})
            </span>
            <div className="space-y-1">
              {related.entries.map((entry) => {
                const relTime = new Date(entry.timestamp).toLocaleTimeString(locale, {
                  hour12: false,
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })
                const isCurrent = entry.id === log.id
                const content = (
                  <>
                    <Badge
                      className={cn(
                        "text-[10px] shrink-0 px-1.5",
                        LEVEL_THEME[entry.level].badgeClass
                      )}
                    >
                      {t(`levels.${entry.level}`)}
                    </Badge>
                    <span className="font-mono text-muted-foreground shrink-0">{relTime}</span>
                    <span className="min-w-0 flex-1 truncate text-left">{entry.message}</span>
                  </>
                )
                return isCurrent ? (
                  <div
                    key={entry.id}
                    aria-current="true"
                    className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-xs"
                    data-testid="related-log-current"
                  >
                    {content}
                    <span className="shrink-0 text-[10px] text-primary">
                      {t("detail.thisEntry")}
                    </span>
                  </div>
                ) : (
                  <Button
                    key={entry.id}
                    variant="ghost"
                    className="flex h-auto w-full min-w-0 items-center justify-start gap-2 px-2 py-1.5 text-xs font-normal motion-safe:transition-colors"
                    onClick={() => onSelectRelated?.(entry)}
                    data-testid={`related-log-${entry.id}`}
                  >
                    {content}
                  </Button>
                )
              })}
            </div>
            {related.total > related.others && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("detail.relatedWindowed", { shown: related.others, total: related.total })}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )

  if (embedded) {
    return (
      <div className={cn("min-w-0", className)} data-testid="log-detail-embedded">
        {body}
      </div>
    )
  }

  return (
    <div className={cn("flex min-w-0 flex-col border-l bg-background", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold truncate">{t("detail.title")}</h3>
          <Badge className={cn("text-xs shrink-0", LEVEL_THEME[log.level].badgeClass)}>
            {t(`levels.${log.level}`)}
          </Badge>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onNavigate && navPosition && (
            <div className="flex items-center gap-0.5 mr-1" data-testid="log-detail-nav">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={navPosition.index <= 1}
                    aria-label={t("detail.prevLog")}
                    data-testid="log-detail-nav-prev"
                    onClick={() => onNavigate(-1)}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("detail.prevLog")}</TooltipContent>
              </Tooltip>
              <span className="text-[11px] font-mono text-muted-foreground tabular-nums px-0.5">
                {navPosition.index}/{navPosition.total}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={navPosition.index >= navPosition.total}
                    aria-label={t("detail.nextLog")}
                    data-testid="log-detail-nav-next"
                    onClick={() => onNavigate(1)}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("detail.nextLog")}</TooltipContent>
              </Tooltip>
            </div>
          )}
          {onToggleBookmark && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={isBookmarked ? t("detail.removeBookmark") : t("detail.addBookmark")}
                  aria-pressed={isBookmarked}
                  data-testid="log-detail-bookmark"
                  onClick={() => onToggleBookmark(log.id)}
                >
                  {isBookmarked ? (
                    <BookmarkCheck className="h-4 w-4 text-warning" />
                  ) : (
                    <Bookmark className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isBookmarked ? t("detail.removeBookmark") : t("detail.addBookmark")}
              </TooltipContent>
            </Tooltip>
          )}
          {onClose && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t("detail.close")}
                  data-testid="log-detail-close"
                  onClick={onClose}
                >
                  <X className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("detail.close")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <ScrollArea className={cn("min-h-0 flex-1", SCROLL_AREA_BLOCK)}>{body}</ScrollArea>
    </div>
  )
}

export default LogDetailPanel
