"use client"

/**
 * What fills the context window, as a ring.
 *
 * The composer's hover card draws the same {@link ContextBreakdown} as a thin
 * segment bar and a list; in the dock there is room for the shape to be read at
 * a glance. Each occupied group is an arc in its legend colour (`GROUP_STROKE`,
 * held to `GROUP_COLOR` by test), the live path's free remainder is the muted
 * track, and the centre carries the occupancy the window header states.
 *
 * Deferred groups are skipped, exactly as the segment bar skips them: they are
 * declared, not loaded, and drawing them would push the ring past 100%. On the
 * estimate path the arcs are shares of what could be attributed (the
 * breakdown's `denominator`), which the caption says out loud.
 */

import { useTranslations } from "next-intl"

import { GROUP_LABEL_KEY, GROUP_STROKE } from "@/components/chat/context-detail-panel"
import type { ContextBreakdown, ContextGroup } from "@/lib/claude/context-breakdown"
import { cn } from "@/lib/utils"
import { formatTokens } from "@/types/system/usage"

const SIZE = 132
const STROKE = 14
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
/** Gap between arcs, in px of circumference, so adjacent groups stay distinct. */
const GAP = 1.5

/** Visible top groups in the side legend; the full list lives in the detail panel. */
const LEGEND_LIMIT = 5

export interface ContextCompositionDonutProps {
  breakdown: ContextBreakdown
  /** Occupancy to print in the centre, already formatted ("62%" or "—"). */
  centerLabel: string
}

function drawable(groups: readonly ContextGroup[]): ContextGroup[] {
  return groups.filter((group) => !group.deferred && group.fraction > 0)
}

export function ContextCompositionDonut({ breakdown, centerLabel }: ContextCompositionDonutProps) {
  const t = useTranslations("contextWorkbench.sessionUsage.composition")
  const tGroup = useTranslations("chat.composer.toolbar")
  const groups = drawable(breakdown.groups)
  const label = (group: ContextGroup) =>
    group.id === "other" ? (group.rawName ?? "") : tGroup(GROUP_LABEL_KEY[group.id])

  // Each arc starts where the previous ones end: a prefix sum, computed
  // without mutating a render-scope variable.
  const arcs = groups.map((group, i) => ({
    group,
    length: Math.max(0, group.fraction * CIRCUMFERENCE - GAP),
    offset: groups.slice(0, i).reduce((sum, prev) => sum + prev.fraction * CIRCUMFERENCE, 0),
  }))

  return (
    <div className="flex items-center gap-4" data-testid="context-composition">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="-rotate-90"
          role="img"
          aria-label={t("aria", {
            used: formatTokens(breakdown.usedTokens),
            max: formatTokens(breakdown.maxTokens),
          })}
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            className="stroke-muted"
          />
          {arcs.map(({ group, length, offset: start }) => (
            <circle
              key={group.key}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
              strokeDashoffset={-start}
              className={cn(GROUP_STROKE[group.id], "transition-[stroke-dasharray] duration-500")}
              data-group={group.key}
            >
              <title>{`${label(group)} · ${formatTokens(group.tokens)}`}</title>
            </circle>
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span
            className="font-mono text-xl font-semibold tabular-nums"
            data-testid="context-composition-center"
          >
            {centerLabel}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {formatTokens(breakdown.usedTokens)} / {formatTokens(breakdown.maxTokens)}
          </span>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <ul className="space-y-1" data-testid="context-composition-legend">
          {groups.slice(0, LEGEND_LIMIT).map((group) => (
            <li key={group.key} className="flex items-center gap-1.5 text-[11px]">
              <svg className="size-2 shrink-0" viewBox="0 0 8 8" aria-hidden>
                <circle
                  cx="4"
                  cy="4"
                  r="3"
                  fill="none"
                  strokeWidth={2}
                  className={GROUP_STROKE[group.id]}
                />
              </svg>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{label(group)}</span>
              <span className="shrink-0 font-mono tabular-nums">{formatTokens(group.tokens)}</span>
            </li>
          ))}
        </ul>
        <p className="text-[10px] text-muted-foreground" data-testid="context-composition-caption">
          {breakdown.denominator === "window" ? t("ofWindow") : t("ofAttributed")}
        </p>
      </div>
    </div>
  )
}
