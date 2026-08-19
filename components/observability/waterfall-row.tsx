"use client"

/**
 * One span row in the trace waterfall: an indented label + a proportional
 * timing bar positioned by the span's offset/width within the trace, with an
 * expandable list of the span's mid-span events.
 *
 * Selection (`selected` + `onSelect`) is optional. The observability drawer
 * renders the row as a read-only strip; the `/logs` Traces channel pairs the
 * waterfall with a span-detail pane and needs the row to be pickable. Without
 * `onSelect` the row stays exactly as inert as it was.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { WaterfallNode } from "@/lib/observability/trace-rollup"
import { formatMs, formatTokens, formatUsd } from "@/lib/observability/format-utils"

export interface WaterfallRowProps {
  node: WaterfallNode
  totalMs: number
  /** Resolved bar color (already error-aware). */
  color: string
  /** Renders the row as the active span. Requires `onSelect` to be meaningful. */
  selected?: boolean
  /** Makes the row pickable; omit for a read-only waterfall. */
  onSelect?: (spanId: string) => void
}

export function WaterfallRow({ node, totalMs, color, selected, onSelect }: WaterfallRowProps) {
  const t = useTranslations("observability.waterfall")
  const [open, setOpen] = useState(false)
  const events = node.span.events ?? []
  const hasEvents = events.length > 0

  const offsetPct = totalMs > 0 ? (node.offsetMs / totalMs) * 100 : 0
  const rawWidthPct = totalMs > 0 ? (node.widthMs / totalMs) * 100 : 100
  const widthPct = Math.min(Math.max(rawWidthPct, 0.5), Math.max(0, 100 - offsetPct))

  const usage = node.span.usage
  const tokenLabel = usage ? formatTokens(usage.inputTokens + usage.outputTokens) : null

  const selectable = typeof onSelect === "function"

  return (
    <li
      data-testid={`waterfall-row-${node.span.spanId}`}
      className={cn("border-b border-border/40 last:border-0", selected && "bg-accent/40")}
      // `aria-current`, not `aria-selected`: the row is a listitem, and
      // aria-selected is not supported on that role.
      aria-current={selectable && selected ? "true" : undefined}
    >
      <div
        className={cn(
          "flex items-center gap-2 py-1 text-xs",
          selectable &&
            "cursor-pointer rounded-sm focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
        )}
        role={selectable ? "button" : undefined}
        tabIndex={selectable ? 0 : undefined}
        onClick={selectable ? () => onSelect(node.span.spanId) : undefined}
        onKeyDown={
          selectable
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                onSelect(node.span.spanId)
              }
            : undefined
        }
      >
        <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: node.depth * 14 }}>
          {hasEvents ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                // The row itself may be selectable; expanding events must not
                // also change the selected span.
                event.stopPropagation()
                setOpen((o) => !o)
              }}
              aria-expanded={open}
              aria-label={t("toggleEvents")}
              data-testid={`waterfall-toggle-${node.span.spanId}`}
              className="size-4 text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon
                className={cn("size-3 transition-transform", open && "rotate-90")}
              />
            </Button>
          ) : (
            <span className="inline-block w-3" />
          )}
          {node.isError && <AlertTriangleIcon className="size-3 shrink-0 text-destructive" />}
          <span className="max-w-[180px] truncate font-medium" title={node.label}>
            {node.label}
          </span>
        </div>

        <div className="relative h-4 min-w-0 flex-1 rounded bg-muted/40">
          <div
            className="absolute top-0 h-full rounded"
            style={{ left: `${offsetPct}%`, width: `${widthPct}%`, backgroundColor: color }}
            data-testid={`waterfall-bar-${node.span.spanId}`}
          />
        </div>

        <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
          {formatMs(node.widthMs)}
        </span>
      </div>

      {open && (
        <div
          className="px-2 pb-2 pl-6 text-[11px] text-muted-foreground"
          data-testid={`waterfall-meta-${node.span.spanId}`}
        >
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            {node.span.responseModel && <span>{node.span.responseModel}</span>}
            {tokenLabel && <span>{t("tokens", { count: tokenLabel })}</span>}
            {typeof node.span.costUsdEstimate === "number" && (
              <span>{t("cost", { value: formatUsd(node.span.costUsdEstimate) })}</span>
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
                    +{formatMs(Math.max(0, e.at - node.span.startTime))}
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
