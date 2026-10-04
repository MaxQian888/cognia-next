"use client"

/**
 * The keyboard-first half of a breakdown panel: one row per category, each a
 * real, visible pair of controls —
 *
 *   [■ value ········ 12]  [→]
 *    toggle (aria-pressed)  show traces
 *
 * The donut legend had the toggle; the bar panel had only `sr-only` buttons
 * (sighted keyboard users tabbed through invisible focus stops, and the bars
 * themselves are SVG with no keyboard path at all). Both panels now render
 * this list, so a filter can be set, and drilled into, without a pointer.
 *
 * The two controls are siblings, never nested, so each is its own tab stop
 * with its own accessible name. "Show traces" is the drill (it makes sure the
 * value IS selected and switches to Explore); the toggle is the in-place
 * cross-filter it always was.
 */

import { useTranslations } from "next-intl"
import { ListTreeIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ObservabilityFormatters } from "@/hooks/observability/use-observability-formatters"
import type { BreakdownMetric } from "@/lib/observability/breakdown"
import { cn } from "@/lib/utils"

/** A breakdown measure in the app locale: money for cost, a count otherwise. */
export function formatBreakdownMetric(
  value: number,
  metric: BreakdownMetric,
  fmt: Pick<ObservabilityFormatters, "usd" | "integer">
): string {
  return metric === "cost" ? fmt.usd(value) : fmt.integer(value)
}

export interface BreakdownLegendItem {
  key: string
  /** Display label; defaults to `key`. */
  label?: string
  /** Formatted measure for the row. */
  value: string
  color: string
}

export interface BreakdownLegendProps {
  items: BreakdownLegendItem[]
  selected: ReadonlySet<string>
  /** Toggle a value in the channel filters. Absent → rows are static text. */
  onSelectValue?: (value: string) => void
  /** Drill into Explore narrowed to the value. Absent → no drill button. */
  onShowTraces?: (value: string) => void
  /** Accessible name of the list (the panel title). */
  label: string
  /** `data-testid` prefix: rows get it, toggles `${prefix}-${key}`, drills
   * `${prefix}-show-${key}`. */
  testIdPrefix: string
  className?: string
}

export function BreakdownLegend({
  items,
  selected,
  onSelectValue,
  onShowTraces,
  label,
  testIdPrefix,
  className,
}: BreakdownLegendProps) {
  const t = useTranslations("observability")

  return (
    <ul
      aria-label={label}
      className={cn("flex max-h-full flex-col gap-0.5 overflow-auto pr-1 text-xs", className)}
    >
      {items.map((item) => {
        const isSelected = selected.has(item.key)
        const text = item.label ?? item.key
        const content = (
          <>
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-sm"
              style={{ backgroundColor: item.color }}
            />
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.key}>
              {text}
            </span>
            <span className="ml-auto shrink-0 tabular-nums">{item.value}</span>
          </>
        )
        return (
          <li key={item.key} className="flex items-center gap-0.5" data-testid={testIdPrefix}>
            {onSelectValue ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onSelectValue(item.key)}
                aria-pressed={isSelected}
                data-testid={`${testIdPrefix}-${item.key}`}
                className={cn(
                  "h-auto min-w-0 flex-1 justify-start gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs font-normal whitespace-normal",
                  isSelected && "bg-accent/60 font-medium"
                )}
              >
                {content}
              </Button>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5">
                {content}
              </span>
            )}
            {onShowTraces && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onShowTraces(item.key)}
                aria-label={t("drill.showTraces", { value: text })}
                title={t("drill.showTraces", { value: text })}
                data-testid={`${testIdPrefix}-show-${item.key}`}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <ListTreeIcon className="size-3" aria-hidden />
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
