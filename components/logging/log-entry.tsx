"use client"

/**
 * LogEntry Components
 *
 * Extracted from log-panel.tsx — log entry rendering and search highlighting.
 *
 * A row is an `option` in the list's `listbox`, and the list keeps one of
 * them in the tab order (roving tabindex, driven by the panel's keyboard
 * cursor). Tab used to walk every row AND every hover action inside it —
 * four or five stops per entry, a thousand entries deep — before reaching the
 * detail pane. The row's own actions are out of the tab order now; each is
 * still one keystroke away (b bookmarks, Enter opens, e expands) and all of
 * them are in the row's context menu (the Menu key / Shift+F10).
 */

import { useState, useCallback, memo } from "react"
import { isToday } from "date-fns"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Filter,
  Bookmark,
  BookmarkCheck,
  Crosshair,
  PanelRightOpen,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { HOVER_REVEAL_GROUP_CLASS } from "@/lib/ui/hover-reveal"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
  /**
   * The row's primary action — a click on the row, or Enter while it has
   * focus. Hosts with a detail view pass "open this entry"; without it the
   * row falls back to expanding in place.
   */
  onActivate?: (log: StructuredLogEntry, index: number) => void
  /** The row's position in the host list, handed back to `onActivate` so the
   * host can bind one callback for every row and `React.memo` still holds. */
  index?: number
  /** Whether the keyboard cursor (j / k / arrows) is on this row. */
  isFocused?: boolean
  /**
   * Whether this row is the list's single tab stop (roving tabindex). Every
   * other row is `tabIndex={-1}`: reachable with the arrow keys, skipped by
   * Tab. Defaults to `true` so a row rendered on its own stays focusable.
   */
  isTabStop?: boolean
  /** Called with `index` when the row itself receives focus, so the host's
   * keyboard cursor follows a click or a Tab into the list. */
  onFocusRow?: (index: number) => void
  /** Total rows in the host list — `aria-setsize`, since a virtualized list
   * only mounts the rows on screen and the count cannot be inferred. */
  setSize?: number
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
  onActivate,
  index = -1,
  isFocused = false,
  isTabStop = true,
  onFocusRow,
  setSize,
  density = "comfortable",
  t,
}: LogEntryProps) {
  const locale = useLocale()
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

  // The write is awaited: it rejects when the document is not focused or the
  // permission is denied, and the check mark used to appear regardless.
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(log, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t("panel.copyFailed"))
    }
  }, [log, t])

  const handleToggle = useCallback(() => onToggle(log.id), [onToggle, log.id])
  const handleActivate = useCallback(() => {
    if (onActivate) onActivate(log, index)
    else onToggle(log.id)
  }, [onActivate, onToggle, log, index])
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
  const validTimestamp = !Number.isNaN(timestamp.getTime())
  // The app locale's digits and separators; the row was pinned to en-US.
  const timeStr = validTimestamp
    ? timestamp.toLocaleTimeString(locale, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
      })
    : log.timestamp
  // A row from another day says which. The list spans up to seven days under
  // the time-range presets, and "09:14:02.118" alone could be any of them.
  const dateStr =
    validTimestamp && !isToday(timestamp)
      ? timestamp.toLocaleDateString(locale, { month: "2-digit", day: "2-digit" })
      : null
  const expandLabel = isExpanded ? t("panel.collapseEntry") : t("panel.expandEntry")

  const hasDetails = log.data || log.stack || log.source

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid="log-entry-row"
          data-level={log.level}
          data-selected={isSelected || undefined}
          data-focused={isFocused || undefined}
          data-index={index >= 0 ? index : undefined}
          tabIndex={isTabStop ? 0 : -1}
          role="option"
          aria-selected={isSelected}
          aria-posinset={index >= 0 ? index + 1 : undefined}
          aria-setsize={setSize}
          onFocus={(event) => {
            if (event.target === event.currentTarget && index >= 0) onFocusRow?.(index)
          }}
          onKeyDown={(event) => {
            // Only keys aimed at the row itself; a button inside it handles
            // its own Enter / Space.
            if (event.target !== event.currentTarget) return
            if (event.key === "Enter") {
              event.preventDefault()
              handleActivate()
            } else if (event.key === " " && hasDetails) {
              event.preventDefault()
              handleToggle()
            }
          }}
          className={cn(
            "group border-b border-border/50 border-l-[3px] transition-colors outline-none",
            "hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40",
            isExpanded && theme.bgClass,
            theme.gutterClass,
            isFocused && "bg-muted/60 ring-1 ring-inset ring-ring/50",
            isSelected && "border-l-primary bg-primary/5 hover:bg-primary/10"
          )}
        >
          <div
            className={cn(
              "flex items-start gap-2 px-3 cursor-pointer",
              DENSITY_ROW_PADDING[density]
            )}
            data-density={density}
            onClick={handleActivate}
          >
            {hasDetails ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                tabIndex={-1}
                className="mt-0.5 size-4 shrink-0 rounded p-0 text-muted-foreground"
                aria-label={expandLabel}
                aria-expanded={isExpanded}
                data-testid="log-entry-expand"
                onClick={(event) => {
                  event.stopPropagation()
                  handleToggle()
                }}
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </Button>
            ) : (
              <div className="w-4 shrink-0" />
            )}

            <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", iconColor)} />

            {/*
              One line on a wide screen, two on a narrow one. The timestamp and
              the badges are all `shrink-0`, so on a 375px row they left the
              message about ninety pixels and it broke at every hyphen, one
              fragment per line. Below `sm` the message drops to its own
              full-width line under the metadata; `sm:flex-nowrap` puts the
              original single row back.
            */}
            <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2 sm:flex-nowrap">
              <span
                className="text-xs text-muted-foreground font-mono shrink-0"
                title={log.timestamp}
              >
                {dateStr ? <span className="mr-1 text-muted-foreground/70">{dateStr}</span> : null}
                {timeStr}
              </span>

              <Badge variant="outline" className="text-xs shrink-0 font-mono">
                {log.module}
              </Badge>

              {log.traceId && (
                <Tooltip>
                  {/* A real button, so the tooltip opens on focus as well as on
                      hover — a bare Badge could only ever be hovered. It is
                      out of the tab order like the row's other controls; the
                      full id is also in its accessible name. */}
                  <TooltipTrigger asChild>
                    <Badge
                      asChild
                      variant="secondary"
                      className="text-xs shrink-0 font-mono"
                      data-testid="log-entry-trace-badge"
                    >
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={t("panel.traceIdValue", { id: log.traceId })}
                      >
                        {log.traceId.slice(0, 8)}
                      </button>
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t("panel.traceIdValue", { id: log.traceId })}</p>
                  </TooltipContent>
                </Tooltip>
              )}

              <span className="w-full min-w-0 break-words text-sm sm:w-auto sm:flex-1">
                <HighlightedText text={log.message} query={searchQuery} useRegex={useRegex} />
              </span>
            </div>

            {/* Row actions: revealed on row hover, while a popup from it is
                open, and always on touch. They are pointer shortcuts — out of
                the tab order (see the header), each with a key and a context
                menu entry. "Open details" is not among them any more: the row
                click opens the entry, and the icon restated it. */}
            <div
              data-testid="log-entry-actions"
              className={cn("flex items-center gap-0.5 shrink-0", HOVER_REVEAL_GROUP_CLASS)}
            >
              {onToggleBookmark && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      tabIndex={-1}
                      className="h-6 w-6"
                      data-testid="log-entry-bookmark"
                      aria-label={isBookmarked ? t("panel.removeBookmark") : t("panel.addBookmark")}
                      aria-pressed={isBookmarked}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleToggleBookmark()
                      }}
                    >
                      {isBookmarked ? (
                        <BookmarkCheck className="h-3 w-3 text-warning" />
                      ) : (
                        <Bookmark className="h-3 w-3" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isBookmarked ? t("panel.removeBookmark") : t("panel.addBookmark")}
                  </TooltipContent>
                </Tooltip>
              )}

              {onFocusTrace && log.traceId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      tabIndex={-1}
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
                      tabIndex={-1}
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
                    tabIndex={-1}
                    className="h-6 w-6"
                    aria-label={t("panel.copyEntry")}
                    data-testid="log-entry-copy"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleCopy()
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
        <ContextMenuItem onClick={() => void handleCopy()}>
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
