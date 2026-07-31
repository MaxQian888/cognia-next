"use client"

/**
 * Aggregates a run of ≥2 consecutive tool calls into a single collapsible
 * "activity group" — e.g. "Ran 5 tools ✓" — so a tool-dense turn reads as one
 * glanceable unit instead of a wall of cards. Provides group-level collapse
 * plus expand-all / collapse-all over the children.
 *
 * Per display mode:
 *  - simplified — collapsed by default; children are compact `ToolCallRow`s
 *                 whose open state is owned by the group (expand/collapse all).
 *  - standard   — expanded by default; children are the full `Tool` cards via
 *                 `renderCard`; expand/collapse all remounts them open/closed.
 *  - detailed   — expanded by default; children render with `forceOpen`.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  CircleIcon,
  LayersIcon,
  XCircleIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ToolUIPart } from "ai"

import { ToolCallRow } from "@/components/chat/message-parts/tool-call-row"
import { MotionCollapse, MotionStatusSwap } from "@/components/chat/motion/motion-reveal"
import {
  aggregateToolStatus,
  countErroredTools,
  summarizeContextCounts,
  tallyToolNames,
  type AggregateStatus,
} from "@/lib/chat/tool-summary"
import type { AgentFlowMode } from "@/types/appearance"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const AGG_GLYPH: Record<AggregateStatus, { Icon: LucideIcon; className: string }> = {
  running: { Icon: ClockIcon, className: "animate-pulse text-muted-foreground" },
  error: { Icon: XCircleIcon, className: "text-red-600 dark:text-red-500" },
  complete: { Icon: CheckCircleIcon, className: "text-green-600 dark:text-green-500" },
  pending: { Icon: CircleIcon, className: "text-muted-foreground" },
}

export interface ToolActivityGroupEntry {
  part: ToolUIPart
  key: string
}

export interface ToolActivityGroupProps {
  entries: ToolActivityGroupEntry[]
  mode: AgentFlowMode
  /** Renders one full tool card (standard/detailed modes). */
  renderCard: (part: ToolUIPart, key: string, opts: { forceOpen?: boolean }) => ReactNode
}

export function ToolActivityGroup({ entries, mode, renderCard }: ToolActivityGroupProps) {
  const t = useTranslations("chat.agentFlow")

  // Simplified: per-row open set. Standard/detailed: remount generation + value.
  const [expandedRows, setExpandedRows] = useState<Set<number>>(() => new Set())
  const [cardsOpen, setCardsOpen] = useState<boolean | null>(null)
  const [gen, setGen] = useState(0)

  const status = useMemo(() => aggregateToolStatus(entries.map((e) => e.part.state)), [entries])
  const glyph = AGG_GLYPH[status]
  const errorCount = useMemo(() => countErroredTools(entries.map((e) => e.part.state)), [entries])
  // Type-count preview ("read ×3 · grep ×1 · edit ×1") for the collapsed header
  // (standard/detailed). Simplified swaps in a TUI-style count summary instead.
  const tally = useMemo(() => tallyToolNames(entries.map((e) => e.part)), [entries])
  const counts = useMemo(() => summarizeContextCounts(entries.map((e) => e.part)), [entries])

  // Open state follows the run's status until the user takes over: a simplified
  // group opens while any child is still running or has errored (so live
  // progress / failures aren't hidden) and auto-collapses once every child has
  // settled error-free. A manual toggle pins `override` and wins thereafter.
  const autoOpen = mode !== "simplified" || status === "running" || status === "error"
  const [override, setOverride] = useState<boolean | null>(null)
  const groupOpen = override ?? autoOpen

  const allRowsExpanded = expandedRows.size === entries.length && entries.length > 0
  const expandAllActive = mode === "simplified" ? allRowsExpanded : cardsOpen === true

  const toggleExpandAll = () => {
    if (mode === "simplified") {
      setExpandedRows(expandAllActive ? new Set() : new Set(entries.map((_, i) => i)))
    } else {
      setCardsOpen(!expandAllActive)
      setGen((g) => g + 1)
    }
  }

  // Stable per-index toggle so the memoized `ToolCallRow` children don't all
  // re-render when one row's open state changes. A fresh inline closure here
  // would make every row's `onToggle` prop unequal and defeat the row memo.
  const toggleRow = useCallback((i: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }, [])
  const rowToggles = useMemo(
    () => entries.map((_, i) => () => toggleRow(i)),
    [entries.length, toggleRow] // eslint-disable-line react-hooks/exhaustive-deps -- positional handlers keyed on count
  )

  const body: ReactNode =
    mode === "simplified" ? (
      <div className="space-y-1">
        {entries.map((entry, i) => (
          <ToolCallRow
            key={entry.key}
            part={entry.part}
            expanded={expandedRows.has(i)}
            onToggle={rowToggles[i]}
          />
        ))}
      </div>
    ) : (
      <div className="space-y-0">
        {entries.map((entry) =>
          renderCard(entry.part, `${entry.key}:${gen}`, {
            forceOpen: cardsOpen ?? (mode === "detailed" ? true : undefined),
          })
        )}
      </div>
    )

  // Simplified mode reads as a recessive Codex-style stack: no card chrome, the
  // header muted, and the collapsed rows nested under it. Standard/detailed keep
  // the bordered card that wraps their full tool cards.
  const simplified = mode === "simplified"

  return (
    <div
      className={cn("not-prose w-full", simplified ? "mb-2" : "mb-4 rounded-md border bg-card")}
      data-testid="tool-activity-group"
      data-mode={mode}
      data-status={status}
    >
      <div className={cn("flex items-center gap-2", simplified ? "px-1.5 py-1" : "p-2.5")}>
        <button
          type="button"
          onClick={() => setOverride(!groupOpen)}
          aria-expanded={groupOpen}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
          data-testid="tool-activity-group-toggle"
        >
          <ChevronDownIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              !groupOpen && "-rotate-90"
            )}
          />
          <LayersIcon className="size-4 shrink-0 text-muted-foreground" />
          {simplified ? (
            // TUI-style count summary ("3 reads · 2 searches") — the compact
            // tally of the whole context-read burst.
            <span
              className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground"
              data-testid="tool-activity-group-actions"
            >
              {counts.map((bucket, i) => (
                <span key={bucket.category}>
                  {i > 0 ? <span aria-hidden> · </span> : null}
                  {t(`count.${bucket.category}`, { count: bucket.count })}
                </span>
              ))}
            </span>
          ) : (
            <>
              <span className="shrink-0 text-sm font-medium">
                {t("group.summary", { count: entries.length })}
              </span>
              {/* Type-count preview — keeps the collapsed group glanceable. */}
              <span
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                data-testid="tool-activity-group-tally"
              >
                {tally.map((bucket, i) => (
                  <span key={bucket.name}>
                    {i > 0 ? <span aria-hidden> · </span> : null}
                    {t("group.tally", { name: bucket.name, count: bucket.count })}
                  </span>
                ))}
              </span>
            </>
          )}
          {errorCount > 0 ? (
            <span
              className="shrink-0 text-xs font-medium text-red-600 dark:text-red-500"
              data-testid="tool-activity-group-failed"
            >
              {t("group.failed", { count: errorCount })}
            </span>
          ) : null}
          <MotionStatusSwap swapKey={status} className="shrink-0">
            <glyph.Icon className={cn("size-4", glyph.className)} aria-hidden />
          </MotionStatusSwap>
        </button>
        {groupOpen ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground"
            onClick={toggleExpandAll}
            data-testid="tool-activity-group-expand-all"
          >
            {expandAllActive ? t("group.collapseAll") : t("group.expandAll")}
          </Button>
        ) : null}
      </div>

      <MotionCollapse open={groupOpen}>
        <div className={cn(simplified ? "pl-4 pt-0.5 pb-1" : "border-t p-2")}>{body}</div>
      </MotionCollapse>
    </div>
  )
}
