"use client"

/** Collapsible tool run with lazy bodies and per-call controlled disclosure state. */

import { useCallback, useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon } from "lucide-react"
import type { ToolUIPart } from "ai"

import { ReadingCollapse } from "@/components/chat/motion/motion-reveal"
import { ToolStatusDot } from "@/components/chat/message-parts/tool-row"
import {
  aggregateToolStatus,
  countErroredTools,
  summarizeContextCounts,
} from "@/lib/chat/tool-summary"
import type { AgentFlowMode } from "@/types/appearance"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface ToolActivityGroupEntry {
  part: ToolUIPart
  key: string
  /** Caller-specific default; otherwise only detailed rows start expanded. */
  defaultOpen?: boolean
}

/** Controlled disclosure options, shared by every row shape. */
export interface ToolActivityChildOptions {
  expanded?: boolean
  onToggle?: () => void
}

export interface ToolActivityGroupProps {
  entries: ToolActivityGroupEntry[]
  mode: AgentFlowMode
  /** Explicit display preference also opens the enclosing group. */
  defaultOpen?: boolean
  /** Renders one child (a compact row or a full tool card — the caller decides). */
  renderChild: (part: ToolUIPart, key: string, opts: ToolActivityChildOptions) => ReactNode
}

export function ToolActivityGroup({
  entries,
  mode,
  defaultOpen,
  renderChild,
}: ToolActivityGroupProps) {
  const t = useTranslations("chat.agentFlow")

  const [expandedRows, setExpandedRows] = useState<Map<string, boolean>>(() => new Map())

  const status = useMemo(() => aggregateToolStatus(entries.map((e) => e.part.state)), [entries])
  const attentionState = useMemo(
    () =>
      entries.some((entry) => entry.part.state === "approval-requested")
        ? "awaitingApproval"
        : entries.some((entry) => entry.part.state === "output-denied")
          ? "denied"
          : null,
    [entries]
  )
  const errorCount = useMemo(() => countErroredTools(entries.map((e) => e.part.state)), [entries])
  // TUI-style count summary ("3 reads · 2 searches") for the collapsed header —
  // shared by every mode now that the header is a row in all of them.
  const counts = useMemo(() => summarizeContextCounts(entries.map((e) => e.part)), [entries])

  // A manual group toggle wins over later stream/default changes. Pending,
  // approval and denied calls must remain visible until explicitly collapsed.
  const autoOpen = defaultOpen ?? (mode !== "simplified" || status !== "complete")
  const [override, setOverride] = useState<boolean | null>(null)
  const groupOpen = override ?? autoOpen
  const rowDefaults = useMemo(
    () =>
      JSON.stringify(entries.map((entry) => [entry.key, entry.defaultOpen ?? mode === "detailed"])),
    [entries, mode]
  )
  const defaults = useMemo(() => new Map<string, boolean>(JSON.parse(rowDefaults)), [rowDefaults])

  // Drop clipped/replaced identities, bounding state for a subagent's rolling
  // tool window. Retained identities keep their manual state across reorders.
  if ([...expandedRows.keys()].some((key) => !defaults.has(key))) {
    setExpandedRows(new Map([...expandedRows].filter(([key]) => defaults.has(key))))
  }

  const expandAllActive =
    entries.length > 0 &&
    entries.every((entry) => expandedRows.get(entry.key) ?? defaults.get(entry.key))
  const toggleExpandAll = () => {
    setOverride(true)
    setExpandedRows(new Map(entries.map((entry) => [entry.key, !expandAllActive])))
  }
  const toggleRow = useCallback((key: string, fallback: boolean) => {
    setOverride(true)
    setExpandedRows((prev) => {
      const next = new Map(prev)
      next.set(key, !(prev.get(key) ?? fallback))
      return next
    })
  }, [])
  // The serialized identity/default list stays stable on streaming deltas and
  // fresh entries arrays, keeping unaffected memoized rows' callbacks stable.
  const rowToggles = useMemo(
    () => new Map([...defaults].map(([key, fallback]) => [key, () => toggleRow(key, fallback)])),
    [defaults, toggleRow]
  )

  const body: ReactNode = !groupOpen ? null : (
    <div className="space-y-0.5">
      {entries.map((entry) =>
        renderChild(entry.part, entry.key, {
          expanded: expandedRows.get(entry.key) ?? defaults.get(entry.key),
          onToggle: rowToggles.get(entry.key),
        })
      )}
    </div>
  )

  return (
    <div
      className="not-prose mb-2 w-full"
      data-testid="tool-activity-group"
      data-mode={mode}
      data-status={status}
    >
      {/* Reserve the bulk button's height while collapsed so the header stays put. */}
      <div className="flex min-h-8 items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/50">
        <button
          type="button"
          onClick={() => setOverride(!groupOpen)}
          aria-expanded={groupOpen}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
          data-testid="tool-activity-group-toggle"
        >
          <ToolStatusDot status={status} />
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            data-testid="tool-activity-group-tally"
          >
            <span className="font-medium text-foreground/80">
              {t("group.summary", { count: entries.length })}
            </span>
            {counts.length > 0 ? <span aria-hidden> · </span> : null}
            {counts.map((bucket, i) => (
              <span key={bucket.category}>
                {i > 0 ? <span aria-hidden> · </span> : null}
                {t(`count.${bucket.category}`, { count: bucket.count })}
              </span>
            ))}
          </span>
          {attentionState ? (
            <span className="shrink-0 text-[11px] text-amber-600">
              {t(`status.${attentionState}`)}
            </span>
          ) : null}
          {errorCount > 0 ? (
            <span
              className="shrink-0 text-[11px] font-medium text-red-600 dark:text-red-500"
              data-testid="tool-activity-group-failed"
            >
              {t("group.failed", { count: errorCount })}
            </span>
          ) : null}
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              groupOpen && "rotate-90"
            )}
            aria-hidden
          />
        </button>
        {groupOpen ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-[11px] text-muted-foreground"
            onClick={toggleExpandAll}
            aria-expanded={expandAllActive}
            data-testid="tool-activity-group-expand-all"
          >
            {expandAllActive ? t("group.collapseAll") : t("group.expandAll")}
          </Button>
        ) : null}
      </div>

      <ReadingCollapse open={groupOpen}>
        {/* The left rule mirrors the expansion indent of a single tool row, so
            a group reads as one row whose children happen to be more rows. */}
        <div className="ml-[15px] border-l-2 border-border/60 pl-1 pt-0.5 pb-0.5">{body}</div>
      </ReadingCollapse>
    </div>
  )
}
