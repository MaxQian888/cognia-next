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
import {
  X,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
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
} from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import {
  AGENT_TRACE_MODULE,
  getAgentTraceLogData,
  type AgentTraceLogData,
} from "@/lib/agent-trace/log-adapter"
import {
  LIVE_TRACE_EVENT_ICONS,
  LIVE_TRACE_EVENT_COLORS,
  formatDuration,
  formatTokens,
} from "@/lib/agent"
import { formatCost } from "@/lib/agent-trace/cost-estimator"
import type { AgentTraceEventType } from "@/types/agent/agent-trace"
import type { StructuredLogEntry, LogLevel } from "@/lib/logger"

export interface LogDetailPanelProps {
  log: StructuredLogEntry
  relatedLogs?: StructuredLogEntry[]
  isBookmarked?: boolean
  onClose?: () => void
  onToggleBookmark?: (id: string) => void
  onSelectRelated?: (log: StructuredLogEntry) => void
  className?: string
}

const LEVEL_BADGE_COLORS: Record<LogLevel, string> = {
  trace: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  debug: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  info: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  warn: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
  error: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  fatal: "bg-red-200 text-red-900 dark:bg-red-900/50 dark:text-red-200",
}

/**
 * Parse a stack trace string into individual frames.
 */
function parseStackTrace(stack: string): { fn: string; file: string; line: string; col: string }[] {
  const frames: { fn: string; file: string; line: string; col: string }[] = []
  const lines = stack.split("\n")

  for (const line of lines) {
    // Chrome/V8 style: "    at functionName (file:line:col)"
    const chromeMatch = line.match(/^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/)
    if (chromeMatch) {
      frames.push({
        fn: chromeMatch[1],
        file: chromeMatch[2],
        line: chromeMatch[3],
        col: chromeMatch[4],
      })
      continue
    }

    // Chrome/V8 anonymous: "    at file:line:col"
    const anonMatch = line.match(/^\s*at\s+(.+?):(\d+):(\d+)/)
    if (anonMatch) {
      frames.push({
        fn: "<anonymous>",
        file: anonMatch[1],
        line: anonMatch[2],
        col: anonMatch[3],
      })
      continue
    }

    // Firefox style: "functionName@file:line:col"
    const ffMatch = line.match(/^(.+?)@(.+?):(\d+):(\d+)/)
    if (ffMatch) {
      frames.push({
        fn: ffMatch[1] || "<anonymous>",
        file: ffMatch[2],
        line: ffMatch[3],
        col: ffMatch[4],
      })
    }
  }

  return frames
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <span className="text-green-600 dark:text-green-400">&quot;{value}&quot;</span>
  }
  if (typeof value === "number") {
    return <span className="text-blue-600 dark:text-blue-400">{value}</span>
  }
  if (typeof value === "boolean") {
    return <span className="text-orange-600 dark:text-orange-400">{String(value)}</span>
  }
  if (value === null) {
    return <span className="text-orange-600 dark:text-orange-400">null</span>
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

  if (!isCollapsible) {
    return (
      <div className="font-mono text-xs leading-5" style={{ paddingLeft: depth * 12 }}>
        {label ? (
          <>
            <span className="text-purple-600 dark:text-purple-400">&quot;{label}&quot;</span>
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
          {label ? (
            <span className="text-purple-600 dark:text-purple-400">&quot;{label}&quot;:</span>
          ) : null}
          <span>{wrapperOpen}</span>
          <span className="text-muted-foreground">{entries.length}</span>
          <span className="text-muted-foreground">{isArray ? "items" : "keys"}</span>
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
  text: string
  label: string
  showText?: boolean
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={showText ? "outline" : "ghost"}
          size={showText ? "sm" : "icon"}
          className={cn(showText ? "h-7 gap-1.5 px-2 text-xs" : "h-6 w-6 shrink-0")}
          onClick={handleCopy}
        >
          {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
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
          <Badge variant="outline" className="text-xs capitalize">
            {data.eventType?.replace(/_/g, " ") ?? "unknown"}
          </Badge>
          {data.success === true && (
            <Badge
              variant="secondary"
              className="text-xs gap-1 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
            >
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
  className,
}: LogDetailPanelProps) {
  const t = useTranslations("logging")
  const locale = useLocale()

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

  const stackFrames = useMemo(() => {
    if (!log.stack) return []
    return parseStackTrace(log.stack)
  }, [log.stack])

  const filteredRelated = useMemo(() => {
    return relatedLogs.filter((r) => r.id !== log.id).slice(0, 20)
  }, [relatedLogs, log.id])

  return (
    <div className={cn("flex flex-col border-l bg-background", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold truncate">{t("detail.title")}</h3>
          <Badge className={cn("text-xs shrink-0", LEVEL_BADGE_COLORS[log.level])}>
            {log.level.toUpperCase()}
          </Badge>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onToggleBookmark && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onToggleBookmark(log.id)}
                >
                  {isBookmarked ? (
                    <BookmarkCheck className="h-4 w-4 text-yellow-500" />
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
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Message */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("detail.message")}
              </span>
              <CopyButton text={log.message} label={t("detail.copyMessage")} />
            </div>
            <p className="text-sm break-words">{log.message}</p>
          </div>

          <Separator />

          {/* Metadata Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <div>
                <p className="text-muted-foreground">{t("detail.timestamp")}</p>
                <p className="font-mono">{timeStr}</p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-muted-foreground" />
              <div>
                <p className="text-muted-foreground">{t("detail.module")}</p>
                <p className="font-mono">{log.module}</p>
              </div>
            </div>

            {log.traceId && (
              <div className="flex items-center gap-1.5 sm:col-span-2">
                <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-muted-foreground">{t("panel.traceId")}</p>
                  <div className="flex items-center gap-1">
                    <p className="font-mono truncate">{log.traceId}</p>
                    <CopyButton text={log.traceId} label={t("detail.copyTraceId")} />
                  </div>
                </div>
              </div>
            )}

            {log.sessionId && (
              <div className="flex items-center gap-1.5 sm:col-span-2">
                <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-muted-foreground">{t("detail.sessionId")}</p>
                  <p className="font-mono truncate">{log.sessionId}</p>
                </div>
              </div>
            )}

            {log.source && (
              <div className="flex items-center gap-1.5 sm:col-span-2">
                <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
                <div>
                  <p className="text-muted-foreground">{t("panel.source")}</p>
                  <p className="font-mono">
                    {log.source.file}:{log.source.line}
                    {log.source.function && (
                      <span className="text-muted-foreground"> ({log.source.function})</span>
                    )}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Tags */}
          {log.tags && log.tags.length > 0 && (
            <>
              <Separator />
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("detail.tags")}
                  </span>
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

          {/* Data (JSON tree) */}
          {log.data && !(log.module === AGENT_TRACE_MODULE) && (
            <>
              <Separator />
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("panel.data")}
                  </span>
                  <CopyButton
                    text={JSON.stringify(log.data, null, 2)}
                    label={t("detail.copyJson")}
                    showText
                  />
                </div>
                <div className="rounded-md bg-muted/50 p-3">
                  <JsonTreeNode value={log.data} />
                </div>
              </div>
            </>
          )}

          {/* Stack Trace (parsed frames) */}
          {log.stack && (
            <>
              <Separator />
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("panel.stackTrace")}
                  </span>
                  <CopyButton text={log.stack} label={t("detail.copyStack")} />
                </div>

                {stackFrames.length > 0 ? (
                  <div className="space-y-0.5">
                    {stackFrames.map((frame, i) => (
                      <div
                        key={i}
                        className={cn(
                          "flex items-start gap-2 px-2 py-1.5 rounded text-xs font-mono",
                          i === 0
                            ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
                            : "bg-muted/30 text-muted-foreground"
                        )}
                      >
                        <ChevronRight className="h-3 w-3 mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <span className="font-semibold">{frame.fn}</span>
                          <div className="flex items-center gap-1 text-[11px] opacity-75">
                            <ExternalLink className="h-2.5 w-2.5" />
                            <span className="truncate">
                              {frame.file}:{frame.line}:{frame.col}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <ScrollArea className="max-h-40 rounded-md bg-red-50 dark:bg-red-900/20">
                    <pre className="text-xs font-mono whitespace-pre-wrap p-3 text-red-600 dark:text-red-400">
                      {log.stack}
                    </pre>
                  </ScrollArea>
                )}
              </div>
            </>
          )}

          {/* Related Logs (same traceId) */}
          {filteredRelated.length > 0 && (
            <>
              <Separator />
              <div>
                <span className="text-xs font-medium text-muted-foreground mb-2 block">
                  {t("detail.relatedLogs")} ({filteredRelated.length})
                </span>
                <div className="space-y-1">
                  {filteredRelated.map((related) => {
                    const relTime = new Date(related.timestamp).toLocaleTimeString(locale, {
                      hour12: false,
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })
                    return (
                      <Button
                        key={related.id}
                        variant="ghost"
                        className="flex items-center gap-2 w-full justify-start px-2 py-1.5 h-auto text-xs font-normal motion-safe:transition-colors"
                        onClick={() => onSelectRelated?.(related)}
                        data-testid={`related-log-${related.id}`}
                      >
                        <Badge
                          className={cn(
                            "text-[10px] shrink-0 px-1.5",
                            LEVEL_BADGE_COLORS[related.level]
                          )}
                        >
                          {related.level}
                        </Badge>
                        <span className="font-mono text-muted-foreground shrink-0">{relTime}</span>
                        <span className="truncate">{related.message}</span>
                      </Button>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

export default LogDetailPanel
