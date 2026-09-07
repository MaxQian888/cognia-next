"use client"

/**
 * The record a console section holds: label above value, wrapping in columns.
 *
 * Lifted from `components/devices/device-visuals.tsx`, which wrote down the
 * reasoning, and put here for the same reason `ConsoleSection` and `StatStrip`
 * were: nothing in it was ever device-specific, and a second console copying
 * the markup is how two panes that should read identically drift apart within
 * a week. `DeviceFactList` / `DeviceFactRow` forward to these.
 *
 * The one thing that IS per-console is which card container the columns size
 * off. `ConsoleSection` names its inner container per pane, so the breakpoints
 * have to name the same one or a fact list in a 300px card seats three columns
 * because the monitor is wide.
 */

import type { ConsolePaneName } from "@/components/surface/console-section"
import { cn } from "@/lib/utils"

/**
 * Spelled out per pane rather than interpolated: Tailwind's scanner reads
 * source text, so `@sm/${name}-card:grid-cols-2` emits nothing.
 */
const FACT_COLUMNS: Record<ConsolePaneName, string> = {
  "console-pane": "@sm/console-card:grid-cols-2 @3xl/console-card:grid-cols-3",
  "device-pane": "@sm/device-card:grid-cols-2 @3xl/device-card:grid-cols-3",
  "workspace-pane": "@sm/workspace-card:grid-cols-2 @3xl/workspace-card:grid-cols-3",
}

/**
 * One labelled fact, stacked label-over-value.
 *
 * A definition list rather than a grid of plain divs, because these really are
 * term/description pairs. A screen reader reading "Paired, 3 days ago" as a
 * pair is the difference between a fact and two loose strings.
 *
 * Stacked rather than label-left/value-right: the detail pane is the wide half
 * of a console, and a `justify-between` row there strands the value against
 * the far edge with several hundred pixels of nothing in between, so the eye
 * has to cross the full width to bind each pair.
 *
 * Values wrap instead of truncating. A fingerprint or a base URL is exactly
 * the fact someone opened this pane to read, and half of one is not useful.
 */
export function FactRow({
  label,
  children,
  mono,
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] leading-tight text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 min-w-0 break-words text-xs font-medium leading-snug",
          mono && "font-mono text-[11px] font-normal break-all"
        )}
      >
        {children}
      </dd>
    </div>
  )
}

/**
 * Wraps a group of {@link FactRow}s in the `<dl>` they belong to.
 *
 * Frameless on purpose: these live inside a `ConsoleSection` card, which
 * already draws the border. A second one here is the classic nested-panel
 * look, and it makes the card read as two cards.
 */
export function FactList({
  children,
  className,
  pane = "console-pane",
}: {
  children: React.ReactNode
  className?: string
  pane?: ConsolePaneName
}) {
  return <dl className={cn("grid gap-x-5 gap-y-3", FACT_COLUMNS[pane], className)}>{children}</dl>
}
