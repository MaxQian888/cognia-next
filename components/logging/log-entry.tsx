"use client"

/**
 * LogEntry Components
 *
 * Extracted from log-panel.tsx — log entry rendering, highlighting, and trace group display.
 */

import { useState, useCallback, memo } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Check,
  Filter,
  Bookmark,
  BookmarkCheck,
  Crosshair,
  PanelRightOpen,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { AGENT_TRACE_MODULE } from "@cognia/agent-trace/log-adapter"
import { LIVE_TRACE_EVENT_ICONS, LIVE_TRACE_EVENT_COLORS } from "@/lib/agent"
import { LEVEL_THEME, ALL_LEVELS } from "@cognia/logging/level-theme"
import type { StructuredLogEntry } from "@cognia/logging"
import type { AgentTraceEventType } from "@/types/agent/agent-trace"

export { LEVEL_THEME, ALL_LEVELS }

/**
 * Split text by search query into parts for highlighting.
 * Returns null if query is invalid or empty.
 */
export function splitByQuery(
  text: string,
  query: string,
  isRegex: boolean
): { parts: string[]; regex: RegExp } | null {
  if (!query) return null
  try {
    const regex = isRegex
      ? new RegExp(`(${query})`, "gi")
      : new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi")
    return { parts: text.split(regex), regex }
  } catch {
    return null
  }
}

/**
 * Highlight search matches within text.
 */
export function HighlightedText({
  text,
  query,
  useRegex,
}: {
  text: string
  query: string
  useRegex: boolean
}) {
  const result = splitByQuery(text, query, useRegex)
  if (!result) return <>{text}</>

  const { parts, regex } = result
  return (
    <>
      {parts.map((part, i) => {
        regex.lastIndex = 0
        return regex.test(part) ? (
          <mark key={i} className="bg-warning/30 text-foreground rounded px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      })}
    </>
  )
}

export type LogEntryDensity = "compact" | "comfortable" | "spacious"

export interface LogEntryProps {
  log: StructuredLogEntry
  isExpanded: boolean
  /** Called with `log.id`; bind once at the call site so `React.memo` short-circuits. */
  onToggle: (id: string) => void
  onSelect?: (log: StructuredLogEntry) => void
  onFocusTrace?: (traceId: string, log: StructuredLogEntry) => void
  onFocusSession?: (sessionId: string, log: StructuredLogEntry) => void
  searchQuery: string
  useRegex: boolean
  isBookmarked: boolean
  onToggleBookmark?: (id: string) => void
  /** Whether this row's detail panel is currently open. */
  isSelected?: boolean
  /** Visual density — controls row padding. Default `"comfortable"`. */
  density?: LogEntryDensity
  t: ReturnType<typeof useTranslations>
}

const DENSITY_ROW_PADDING: Record<LogEntryDensity, string> = {
  compact: "py-0.5",
  comfortable: "py-2",
  spacious: "py-3",
}

export function LogEntry({
  log,
  isExpanded,
  onToggle,
  onSelect,
  onFocusTrace,
  onFocusSession,
  searchQuery,
  useRegex,
  isBookmarked,
  onToggleBookmark,
  isSelected = false,
  density = "comfortable",
  t,
}: LogEntryProps) {
  const [copied, setCopied] = useState(false)
  const theme = LEVEL_THEME[log.level]
  const isTraceEntry = log.module === AGENT_TRACE_MODULE
  const TraceIcon =
    isTraceEntry && log.eventId
      ? LIVE_TRACE_EVENT_ICONS[log.eventId as AgentTraceEventType]
      : undefined
  const traceColor =
    isTraceEntry && log.eventId
      ? LIVE_TRACE_EVENT_COLORS[log.eventId as AgentTraceEventType]
      : undefined
  const Icon = (TraceIcon ?? theme.icon) as React.ComponentType<{ className?: string }>
  const iconColor = traceColor ?? theme.iconColor

  const handleCopy = useCallback(() => {
    const text = JSON.stringify(log, null, 2)
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [log])

  const handleToggle = useCallback(() => onToggle(log.id), [onToggle, log.id])
  const handleSelect = useCallback(() => onSelect?.(log), [onSelect, log])
  const handleToggleBookmark = useCallback(
    () => onToggleBookmark?.(log.id),
    [onToggleBookmark, log.id]
  )
  const handleFocusTrace = useCallback(() => {
    if (log.traceId) onFocusTrace?.(log.traceId, log)
  }, [onFocusTrace, log])
  const handleFocusSession = useCallback(() => {
    if (log.sessionId) onFocusSession?.(log.sessionId, log)
  }, [onFocusSession, log])

  const timestamp = new Date(log.timestamp)
  const timeStr = timestamp.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  })

  const hasDetails = log.data || log.stack || log.source

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid="log-entry-row"
          data-level={log.level}
          data-selected={isSelected || undefined}
          tabIndex={0}
          role="button"
          aria-expanded={hasDetails ? isExpanded : undefined}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              handleToggle()
            }
          }}
          className={cn(
            "group border-b border-border/50 border-l-[3px] transition-colors outline-none",
            "hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40",
            isExpanded && theme.bgClass,
            theme.gutterClass,
            isSelected && "border-l-primary bg-primary/5 hover:bg-primary/10"
          )}
        >
          <div
            className={cn(
              "flex items-start gap-2 px-3 cursor-pointer",
              DENSITY_ROW_PADDING[density]
            )}
            data-density={density}
            onClick={handleToggle}
          >
            {hasDetails ? (
              isExpanded ? (
                <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
              )
            ) : (
              <div className="w-4" />
            )}

            <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", iconColor)} />

            <span className="text-xs text-muted-foreground font-mono shrink-0">{timeStr}</span>

            <Badge variant="outline" className="text-xs shrink-0 font-mono">
              {log.module}
            </Badge>

            {log.traceId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="text-xs shrink-0 font-mono">
                    {log.traceId.slice(0, 8)}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    {t("panel.traceId")}: {log.traceId}
                  </p>
                </TooltipContent>
              </Tooltip>
            )}

            <span className="text-sm flex-1 break-words">
              <HighlightedText text={log.message} query={searchQuery} useRegex={useRegex} />
            </span>

            <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              {onToggleBookmark && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-6 w-6",
                        !isBookmarked && "opacity-0 group-hover:opacity-100 transition-opacity"
                      )}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleToggleBookmark()
                      }}
                    >
                      {isBookmarked ? (
                        <BookmarkCheck className="h-3 w-3 text-warning" />
                      ) : (
                        <Bookmark className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isBookmarked ? t("panel.removeBookmark") : t("panel.addBookmark")}
                  </TooltipContent>
                </Tooltip>
              )}

              {onSelect && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      data-testid="log-entry-open-details"
                      aria-label={t("panel.viewDetails")}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleSelect()
                      }}
                    >
                      <PanelRightOpen className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("panel.viewDetails")}</TooltipContent>
                </Tooltip>
              )}

              {onFocusTrace && log.traceId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={t("panel.focusTrace")}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleFocusTrace()
                      }}
                    >
                      <Crosshair className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("panel.focusTrace")}</TooltipContent>
                </Tooltip>
              )}

              {onFocusSession && log.sessionId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={t("panel.focusSession")}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleFocusSession()
                      }}
                    >
                      <Filter className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("panel.focusSession")}</TooltipContent>
                </Tooltip>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleCopy()
                    }}
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-success" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("panel.copyEntry")}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {isExpanded && hasDetails && (
            <div className="px-3 pb-3 pl-12 space-y-2">
              {log.data && (
                <div className="rounded bg-muted p-2">
                  <div className="text-xs text-muted-foreground mb-1">{t("panel.data")}:</div>
                  <pre className="text-xs font-mono overflow-x-auto">
                    {JSON.stringify(log.data, null, 2)}
                  </pre>
                </div>
              )}

              {log.stack && (
                <div className="rounded bg-destructive/10 p-2">
                  <div className="text-xs text-muted-foreground mb-1">{t("panel.stackTrace")}:</div>
                  <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap text-destructive">
                    {log.stack}
                  </pre>
                </div>
              )}

              {log.source && (
                <div className="text-xs text-muted-foreground">
                  {t("panel.source")}: {log.source.file}:{log.source.line}
                  {log.source.function && ` (${log.source.function})`}
                </div>
              )}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleCopy}>
          <Copy className="h-4 w-4 mr-2" /> {t("panel.copyLogEntry")}
        </ContextMenuItem>
        {onSelect && (
          <ContextMenuItem onClick={handleSelect}>
            <PanelRightOpen className="h-4 w-4 mr-2" /> {t("panel.viewDetailsMenu")}
          </ContextMenuItem>
        )}
        {onFocusTrace && log.traceId && (
          <ContextMenuItem onClick={handleFocusTrace}>
            <Crosshair className="h-4 w-4 mr-2" /> {t("panel.focusTraceMenu")}
          </ContextMenuItem>
        )}
        {onFocusSession && log.sessionId && (
          <ContextMenuItem onClick={handleFocusSession}>
            <Filter className="h-4 w-4 mr-2" /> {t("panel.focusSessionMenu")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {onToggleBookmark && (
          <ContextMenuItem onClick={handleToggleBookmark}>
            {isBookmarked ? (
              <>
                <BookmarkCheck className="h-4 w-4 mr-2 text-warning" /> {t("panel.removeBookmark")}
              </>
            ) : (
              <>
                <Bookmark className="h-4 w-4 mr-2" /> {t("panel.addBookmark")}
              </>
            )}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export const MemoizedLogEntry = memo(LogEntry)

export interface TraceGroupProps {
  traceId: string
  logs: StructuredLogEntry[]
  expandedIds: Set<string>
  toggleExpanded: (id: string) => void
  onFocusTrace?: (traceId: string, log: StructuredLogEntry) => void
  onFocusSession?: (sessionId: string, log: StructuredLogEntry) => void
  searchQuery: string
  useRegex: boolean
  bookmarkedIds: Set<string>
  onToggleBookmark?: (id: string) => void
  selectedLogId?: string | null
  density?: LogEntryDensity
  t: ReturnType<typeof useTranslations>
}

export function TraceGroup({
  traceId,
  logs,
  expandedIds,
  toggleExpanded,
  onFocusTrace,
  onFocusSession,
  searchQuery,
  useRegex,
  bookmarkedIds,
  onToggleBookmark,
  selectedLogId = null,
  density = "comfortable",
  t,
}: TraceGroupProps) {
  const [isOpen, setIsOpen] = useState(true)
  const hasErrors = logs.some((l) => l.level === "error" || l.level === "fatal")
  const hasWarnings = logs.some((l) => l.level === "warn")

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mb-2 border-y">
      <CollapsibleTrigger className="flex items-center gap-2 w-full px-3 py-2 hover:bg-muted/50">
        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Clock className="h-4 w-4 text-muted-foreground" />
        <span className="font-mono text-sm">
          {traceId === "no-trace" ? t("panel.noTraceId") : traceId}
        </span>
        <Badge variant="outline" className="ml-auto">
          {logs.length} {t("panel.logs")}
        </Badge>
        {hasErrors && <Badge variant="destructive">{t("panel.error")}</Badge>}
        {hasWarnings && !hasErrors && (
          <Badge variant="secondary" className="bg-warning/15 text-warning">
            {t("panel.warning")}
          </Badge>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {logs.map((log) => (
          <MemoizedLogEntry
            key={log.id}
            log={log}
            isExpanded={expandedIds.has(log.id)}
            onToggle={toggleExpanded}
            onFocusTrace={onFocusTrace}
            onFocusSession={onFocusSession}
            searchQuery={searchQuery}
            useRegex={useRegex}
            isBookmarked={bookmarkedIds.has(log.id)}
            onToggleBookmark={onToggleBookmark}
            isSelected={log.id === selectedLogId}
            density={density}
            t={t}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}
