"use client"

/**
 * The trace waterfall: one row per span — an indented label, a proportional
 * timing bar positioned by the span's offset/width within the trace, and an
 * expandable list of the span's mid-span events.
 *
 * `WaterfallList` owns the keyboard model; `WaterfallRow` is one row of it.
 *
 * **One tab stop, not one per span.** The list is a roving-tabindex composite:
 * only one row's select button is tab-reachable (the selected span, else the
 * row last arrowed to, else the first), and ↑/↓/Home/End move between rows.
 * A 400-span trace used to put 400 stops between the timeline and the detail
 * pane. → / ← expand and collapse a row's events, so the disclosure stays
 * keyboard-operable even though its own button is out of the tab order.
 *
 * **No nested interactive elements.** The row used to be a `role="button"`
 * div with the events toggle button INSIDE it — a control inside a control,
 * which assistive tech flattens unpredictably (and which needed a
 * `stopPropagation` to keep the toggle from also selecting the span). The two
 * are siblings now: the disclosure button sits in the indent, the select
 * button spans the label, bar and duration.
 *
 * Every row is selectable. There used to be a read-only mode for the
 * `/observability` drill-down drawer; that drawer folded into the `/logs`
 * Traces channel and nothing renders an inert waterfall any more, so the
 * branch (and the `onSelect`-optional prop it hung off) is gone.
 */

import { useCallback, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useObservabilityFormatters } from "@/hooks/observability/use-observability-formatters"
import type { WaterfallNode } from "@/lib/observability/trace-rollup"

export interface WaterfallRowProps {
  node: WaterfallNode
  totalMs: number
  /** Resolved bar color (already error-aware). */
  color: string
  /** Renders the row as the active span. */
  selected?: boolean
  onSelect: (spanId: string) => void
  /** This row's select button is the list's single tab stop. */
  tabbable?: boolean
  /** Row position, for the list's roving focus. */
  index?: number
  /** Arrow-key handling, owned by `WaterfallList`. */
  onNavigate?: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void
  /** The row received focus (so the list can move its tab stop there). */
  onFocusRow?: (index: number) => void
}

export function WaterfallRow({
  node,
  totalMs,
  color,
  selected = false,
  onSelect,
  tabbable = true,
  index = 0,
  onNavigate,
  onFocusRow,
}: WaterfallRowProps) {
  const t = useTranslations("observability.waterfall")
  const fmt = useObservabilityFormatters()
  const [open, setOpen] = useState(false)
  const events = node.span.events ?? []
  const hasEvents = events.length > 0
  const spanId = node.span.spanId
  const metaId = `waterfall-meta-${spanId}`

  const offsetPct = totalMs > 0 ? (node.offsetMs / totalMs) * 100 : 0
  const rawWidthPct = totalMs > 0 ? (node.widthMs / totalMs) * 100 : 100
  const widthPct = Math.min(Math.max(rawWidthPct, 0.5), Math.max(0, 100 - offsetPct))

  const usage = node.span.usage
  const tokenLabel = usage ? fmt.compact(usage.inputTokens + usage.outputTokens) : null

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (hasEvents && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault()
      setOpen(event.key === "ArrowRight")
      return
    }
    onNavigate?.(event, index)
  }

  return (
    <li
      data-testid={`waterfall-row-${spanId}`}
      className={cn("border-b border-border/40 last:border-0", selected && "bg-accent/40")}
    >
      <div className="flex items-center gap-1 py-0.5 text-xs">
        <div
          className="flex shrink-0 items-center justify-end"
          style={{ width: node.depth * 14 + 16 }}
        >
          {hasEvents ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={open ? metaId : undefined}
              aria-label={t("toggleEvents", { name: node.label })}
              data-testid={`waterfall-toggle-${spanId}`}
              className="size-4 text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon
                aria-hidden
                className={cn("size-3 transition-transform", open && "rotate-90")}
              />
            </Button>
          ) : null}
        </div>

        <button
          type="button"
          data-waterfall-row={index}
          data-testid={`waterfall-select-${spanId}`}
          aria-current={selected ? "true" : undefined}
          aria-expanded={hasEvents ? open : undefined}
          tabIndex={tabbable ? 0 : -1}
          onClick={() => onSelect(spanId)}
          onKeyDown={handleKeyDown}
          onFocus={() => onFocusRow?.(index)}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm py-0.5 text-left",
            "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
          )}
        >
          <span className="flex min-w-0 items-center gap-1">
            {node.isError && (
              <AlertTriangleIcon
                className="size-3 shrink-0 text-destructive"
                aria-label={t("failed")}
                role="img"
              />
            )}
            <span className="max-w-[180px] truncate font-medium" title={node.label}>
              {node.label}
            </span>
          </span>

          <span className="relative h-4 min-w-0 flex-1 rounded bg-muted/40" aria-hidden>
            <span
              className="absolute top-0 h-full rounded"
              style={{ left: `${offsetPct}%`, width: `${widthPct}%`, backgroundColor: color }}
              data-testid={`waterfall-bar-${spanId}`}
            />
          </span>

          <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
            {fmt.duration(node.widthMs)}
          </span>
        </button>
      </div>

      {open && (
        <div
          id={metaId}
          className="px-2 pb-2 pl-6 text-[11px] text-muted-foreground"
          data-testid={metaId}
        >
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            {node.span.responseModel && <span>{node.span.responseModel}</span>}
            {tokenLabel && <span>{t("tokens", { count: tokenLabel })}</span>}
            {typeof node.span.costUsdEstimate === "number" && (
              <span>{t("cost", { value: fmt.usd(node.span.costUsdEstimate) })}</span>
            )}
            {node.span.errorMessage && (
              <span className="text-destructive">{node.span.errorMessage}</span>
            )}
          </div>
          {hasEvents && (
            <ul className="mt-1 space-y-0.5">
              {events.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="tabular-nums">
                    {t("eventOffset", {
                      offset: fmt.duration(Math.max(0, e.at - node.span.startTime)),
                    })}
                  </span>
                  <span className="truncate">{e.name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

export interface WaterfallListProps {
  rows: WaterfallNode[]
  totalMs: number
  /** Bar colour per row (already error-aware). */
  colorFor: (node: WaterfallNode) => string
  selectedSpanId: string | null
  onSelect: (spanId: string) => void
  /** Accessible name of the list. */
  label: string
  className?: string
}

/**
 * The waterfall rows under one roving tab stop — see the file header. The
 * cursor is state rather than DOM focus alone so the tab stop survives a
 * re-render (an auto-refresh, a zoom) instead of snapping back to row 0.
 */
export function WaterfallList({
  rows,
  totalMs,
  colorFor,
  selectedSpanId,
  onSelect,
  label,
  className,
}: WaterfallListProps) {
  const [cursor, setCursor] = useState<number | null>(null)
  const selectedIndex = rows.findIndex((node) => node.span.spanId === selectedSpanId)
  const tabIndex =
    cursor !== null && cursor < rows.length ? cursor : selectedIndex >= 0 ? selectedIndex : 0

  const handleNavigate = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      let next: number | null = null
      if (event.key === "ArrowDown") next = Math.min(rows.length - 1, index + 1)
      else if (event.key === "ArrowUp") next = Math.max(0, index - 1)
      else if (event.key === "Home") next = 0
      else if (event.key === "End") next = rows.length - 1
      if (next === null) return
      event.preventDefault()
      setCursor(next)
      const list = event.currentTarget.closest("ul")
      list?.querySelector<HTMLButtonElement>(`[data-waterfall-row="${next}"]`)?.focus()
    },
    [rows.length]
  )

  return (
    <ul aria-label={label} className={className} data-testid="waterfall-list">
      {rows.map((node, index) => (
        <WaterfallRow
          key={node.span.spanId}
          node={node}
          index={index}
          totalMs={totalMs}
          color={colorFor(node)}
          selected={node.span.spanId === selectedSpanId}
          onSelect={onSelect}
          tabbable={index === tabIndex}
          onNavigate={handleNavigate}
          onFocusRow={setCursor}
        />
      ))}
    </ul>
  )
}
