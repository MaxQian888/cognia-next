"use client"

/**
 * Aggregates a run of ≥2 consecutive tool calls into a single collapsible
 * "activity group" — e.g. "4 tool calls · 1 read · 1 search" — so a tool-dense
 * turn reads as one glanceable unit instead of a wall of calls. Provides
 * group-level collapse plus expand-all / collapse-all over the children.
 *
 * The chrome is one header *row* in every display mode — status dot + tally +
 * expand-all + chevron — with children nested under a left rule, matching the
 * inline-row language of `TerminalToolPart` / `FileToolPart` / `ToolCallRow`.
 * (It used to wrap standard/detailed children in a bordered card, which read
 * as a card of cards once the calls themselves became borderless rows.)
 *
 * Per display mode, only the child open-state channel differs:
 *  - simplified — collapsed by default; the group owns each child's open state
 *                 and hands it down as `expanded` + `onToggle`, so
 *                 expand/collapse all is a controlled state change.
 *  - standard   — expanded by default; children get `forceOpen` and a
 *                 generation-stamped key, so expand/collapse all remounts them
 *                 with the new default (the `<Tool>` Collapsible reads
 *                 `defaultOpen` only at mount).
 *  - detailed   — expanded by default; children render with `forceOpen: true`.
 *
 * Every child goes through the caller's `renderChild` in every mode. The group
 * owns *when* a child is open, never *what* a child looks like — that belongs
 * to the caller, which is what lets the main chat render mode-aware tool parts
 * (rows or cards, plus their per-call plugin action slot) while a sub-agent
 * tree renders plain rows, with no branch duplicated here.
 */

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
}

/** How the group wants one child rendered on this pass. */
export interface ToolActivityChildOptions {
  /**
   * standard / detailed — force the child open (`true`) or closed (`false`),
   * or `undefined` to keep its own per-state default. Paired with a
   * generation-stamped key so an uncontrolled child re-reads it.
   */
  forceOpen?: boolean
  /** simplified — controlled open state, owned by the group. */
  expanded?: boolean
  /** simplified — toggles this child's controlled open state. */
  onToggle?: () => void
}

export interface ToolActivityGroupProps {
  entries: ToolActivityGroupEntry[]
  mode: AgentFlowMode
  /** Renders one child (a compact row or a full tool card — the caller decides). */
  renderChild: (part: ToolUIPart, key: string, opts: ToolActivityChildOptions) => ReactNode
}

export function ToolActivityGroup({ entries, mode, renderChild }: ToolActivityGroupProps) {
  const t = useTranslations("chat.agentFlow")

  // Simplified: per-row open set. Standard/detailed: remount generation + value.
  const [expandedRows, setExpandedRows] = useState<Set<number>>(() => new Set())
  const [cardsOpen, setCardsOpen] = useState<boolean | null>(null)
  const [gen, setGen] = useState(0)

  const status = useMemo(() => aggregateToolStatus(entries.map((e) => e.part.state)), [entries])
  const errorCount = useMemo(() => countErroredTools(entries.map((e) => e.part.state)), [entries])
  // TUI-style count summary ("3 reads · 2 searches") for the collapsed header —
  // shared by every mode now that the header is a row in all of them.
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
      <div className="space-y-0.5">
        {entries.map((entry, i) =>
          renderChild(entry.part, entry.key, {
            expanded: expandedRows.has(i),
            onToggle: rowToggles[i],
          })
        )}
      </div>
    ) : (
      <div className="space-y-0.5">
        {entries.map((entry) =>
          renderChild(entry.part, `${entry.key}:${gen}`, {
            forceOpen: cardsOpen ?? (mode === "detailed" ? true : undefined),
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
      <div className="flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/50">
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
