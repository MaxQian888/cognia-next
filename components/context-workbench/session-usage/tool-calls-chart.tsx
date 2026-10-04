"use client"

/**
 * Which tools the conversation leaned on, as ranked horizontal bars.
 *
 * Tool outputs are usually the bulk of a long chat's context, so "what did it
 * call, and how often" is the first question when the window fills up. Rows
 * come from {@link rankToolCounts} (top tools plus one folded "other" row); the
 * error count sits beside the title because a tool that keeps failing is also
 * a tool that keeps re-filling the context with its errors.
 */

import { useTranslations } from "next-intl"

import { OTHER_TOOLS_KEY, type ToolCountRow } from "@/lib/analysis/session-report"

export interface ToolCallsChartProps {
  rows: readonly ToolCountRow[]
  total: number
  errors: number
}

export function ToolCallsChart({ rows, total, errors }: ToolCallsChartProps) {
  const t = useTranslations("contextWorkbench.sessionUsage.tools")
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="tool-calls-empty">
        {t("empty")}
      </p>
    )
  }
  const max = rows.reduce((m, row) => Math.max(m, row.count), 0)
  return (
    <div className="space-y-2" data-testid="tool-calls">
      <p className="text-[11px] text-muted-foreground">
        {t("summary", { total })}
        {errors > 0 ? (
          <span className="ml-1 text-destructive" data-testid="tool-calls-errors">
            {t("errors", { count: errors, pct: Math.round((errors / Math.max(1, total)) * 100) })}
          </span>
        ) : null}
      </p>
      <ul className="space-y-1">
        {rows.map((row) => {
          const label = row.tool === OTHER_TOOLS_KEY ? t("other") : row.tool
          return (
            <li
              key={row.tool}
              className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_2.5rem] items-center gap-2 text-[11px]"
              data-testid={`tool-calls-row-${row.tool}`}
            >
              <span className="truncate font-mono" title={label}>
                {label}
              </span>
              <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                <span
                  className="block h-full rounded-full bg-chart-2"
                  style={{ width: `${Math.max((row.count / max) * 100, 2)}%` }}
                />
              </span>
              <span className="text-right font-mono tabular-nums">{row.count}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
