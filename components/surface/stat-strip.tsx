"use client"

/**
 * The hairline number strip a console masthead carries.
 *
 * Lifted from `components/devices/device-hero.tsx`, whose header wrote down why
 * it exists: a tab bar answers "where do I click" and never "is anything wrong
 * here". Each stat can be a fraction whose denominator is what the subject
 * *could* have, so a shortfall is legible without opening the section that
 * details it.
 *
 * It is here rather than under `components/devices/` because the shape is not
 * device-specific and `/workspace` was hand-rolling a weaker version of it.
 * Labels arrive already translated: the original called `t()` inside the cell,
 * which bound the whole strip to the `devices` namespace.
 *
 * This is NOT a replacement for `components/scheduler/stat-card.tsx#StatCard`.
 * That one is a standalone card with an icon and an accent gradient, and it has
 * around 20 consumers. This one is a joined fraction strip. Merging them would
 * produce a third thing, not fewer things.
 */

import type { ConsolePaneName } from "@/components/surface/console-section"
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"

/**
 * `critical` is the tone a strip needs to be able to say "this is bad", not
 * merely "look here". Without it a failing success rate had to read amber,
 * the same colour as a paused-but-fine count, and the two are not the same
 * news.
 */
export type StatStripTone = "positive" | "attention" | "critical" | "neutral"

/**
 * Makes a cell a button that opens what the number summarises. A count the
 * reader cannot drill into ("Agents working 2" — which two?) is a dead end.
 */
export interface StatStripAction {
  onSelect: () => void
  /** Already-translated hint appended to the cell's accessible name. */
  label: string
  /** Disclosure state, when the cell toggles an inline region. */
  expanded?: boolean
  /** Id of the region the cell controls. */
  controls?: string
}

export interface StatStripItem {
  /** Stable id, also the cell's `data-testid` suffix. */
  id: string
  /** Already-translated label. */
  label: string
  value: number | string
  /** Renders as `value/total`. Omit for a plain count. */
  total?: number | string
  tone?: StatStripTone
  /** Optional drill-down; omitted cells stay plain, non-interactive text. */
  action?: StatStripAction
}

/**
 * As many columns as there are stats, never four with a hole.
 *
 * A fixed `grid-cols-4` leaves an empty tile that reads as a value which failed
 * to load. Spelled out per pane rather than interpolated so Tailwind's scanner
 * actually emits these classes.
 */
const STAT_COLUMNS: Record<ConsolePaneName, Record<number, string>> = {
  "console-pane": {
    1: "grid-cols-1",
    2: "grid-cols-2",
    3: "grid-cols-1 @lg/console-pane:grid-cols-3",
    4: "grid-cols-2 @xl/console-pane:grid-cols-4",
  },
  "device-pane": {
    1: "grid-cols-1",
    2: "grid-cols-2",
    3: "grid-cols-1 @lg/device-pane:grid-cols-3",
    4: "grid-cols-2 @xl/device-pane:grid-cols-4",
  },
  "workspace-pane": {
    1: "grid-cols-1",
    2: "grid-cols-2",
    3: "grid-cols-1 @lg/workspace-pane:grid-cols-3",
    4: "grid-cols-2 @xl/workspace-pane:grid-cols-4",
  },
}

const STAT_TONE: Record<StatStripTone, string> = {
  positive: "text-emerald-600 dark:text-emerald-400",
  attention: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
  neutral: "text-foreground",
}

export interface StatStripProps {
  stats: readonly StatStripItem[]
  /** Which pane grid the strip sits in. Decides the responsive column steps. */
  pane?: ConsolePaneName
  /** Test id for the strip itself. Lets `DeviceHero` keep its existing one. */
  testId?: string
  /** Test id prefix for each cell. */
  cellTestIdPrefix?: string
  className?: string
}

export function StatStrip({
  stats,
  pane = "console-pane",
  testId = "stat-strip",
  cellTestIdPrefix = "stat",
  className,
}: StatStripProps) {
  if (stats.length === 0) return null

  const columns = STAT_COLUMNS[pane]
  return (
    // `Surface` owns the radius so the strip follows the same corner scale as
    // the cards around it. Its `--surface-bg` is deliberately overridden with
    // `bg-border` here: the strip's ground IS the hairline, showing through the
    // 1px grid gaps, which is what makes the cells read as one instrument
    // rather than four boxes. The cells paint `bg-card` back over it.
    <Surface asChild radius="panel">
      <div
        className={cn(
          "grid gap-px overflow-hidden border bg-border",
          columns[stats.length] ?? columns[4],
          className
        )}
        data-testid={testId}
      >
        {stats.map((stat) => {
          const body = (
            <>
              <div className="flex items-baseline gap-0.5">
                <span
                  className={cn(
                    "text-lg font-semibold leading-none tabular-nums",
                    STAT_TONE[stat.tone ?? "neutral"]
                  )}
                >
                  {stat.value}
                </span>
                {stat.total !== undefined ? (
                  <span className="text-xs leading-none tabular-nums text-muted-foreground">
                    /{stat.total}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">{stat.label}</p>
            </>
          )
          if (stat.action) {
            return (
              // The visible number and label stay the button's name; the hint
              // is appended for assistive tech rather than replacing them.
              <button
                key={stat.id}
                type="button"
                onClick={stat.action.onSelect}
                aria-expanded={stat.action.expanded}
                aria-controls={stat.action.controls}
                className="min-w-0 cursor-pointer bg-card px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                data-testid={`${cellTestIdPrefix}-${stat.id}`}
              >
                {body}
                <span className="sr-only">{stat.action.label}</span>
              </button>
            )
          }
          return (
            <div
              key={stat.id}
              className="min-w-0 bg-card px-3 py-2"
              data-testid={`${cellTestIdPrefix}-${stat.id}`}
            >
              {body}
            </div>
          )
        })}
      </div>
    </Surface>
  )
}
