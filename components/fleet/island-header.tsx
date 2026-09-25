"use client"

/**
 * IslandHeader — what the island says before it is expanded, in both layouts.
 *
 * Flat: one line across the pill — the status dot, the named task (its source,
 * title and state) and how many more there are, or a count when there is
 * nothing to name.
 *
 * Notch: the same facts split across the two ears either side of the camera
 * housing, because nothing can be drawn where the camera is. The leading ear
 * carries the dot and the task's name, the trailing ear its state and the
 * count of the rest. Minimal keeps only the dot and one number, which is all
 * that fits in the narrow ears the menu bar can spare.
 *
 * Rendered inside the shell's pill button, which owns focus, the toggle and
 * the accessible name; this component is presentation only.
 */

import { useTranslations } from "next-intl"
import { CheckIcon } from "lucide-react"

import type { IslandLayout, IslandPresentation } from "@/lib/island/layout"
import type { IslandRowProjection } from "@/lib/island/types"
import { cn } from "@/lib/utils"

export interface IslandHeaderProps {
  layout: IslandLayout
  presentation: IslandPresentation
  /** The task compact names: a just-finished one being announced, else the top one. */
  focus: IslandRowProjection | undefined
  /** Whether `focus` is a just-finished task being announced. */
  announcing: boolean
  total: number
  waiting: number
  active: number
  /** Housing width (logical px); only read by the notch layout. */
  notchWidth: number
}

function StatusDot({
  waiting,
  total,
  announcing,
}: {
  waiting: number
  total: number
  announcing: boolean
}) {
  if (announcing) {
    return (
      <CheckIcon
        aria-hidden
        data-testid="island-announce-done"
        className="size-3 shrink-0 text-emerald-400"
      />
    )
  }
  return (
    <span
      aria-hidden
      data-testid="island-status-dot"
      className={cn(
        "size-1.5 shrink-0 rounded-full transition-colors duration-300",
        waiting > 0 ? "animate-pulse bg-amber-400" : total > 0 ? "bg-emerald-400" : "bg-white/30"
      )}
    />
  )
}

export function IslandHeader({
  layout,
  presentation,
  focus,
  announcing,
  total,
  waiting,
  active,
  notchWidth,
}: IslandHeaderProps) {
  const t = useTranslations("fleet.island")
  const dot = <StatusDot waiting={waiting} total={total} announcing={announcing} />
  const state = focus
    ? announcing
      ? t("state.done")
      : focus.summary || t(`state.${focus.statusKey ?? focus.status}`)
    : null
  const more =
    total > 1 ? (
      <span data-testid="island-compact-more" className="shrink-0 tabular-nums text-white/40">
        {t("more", { count: total - 1 })}
      </span>
    ) : null
  const summary = (
    <span data-testid="island-summary" className="min-w-0 truncate">
      {total === 0
        ? t("empty")
        : waiting > 0
          ? t("summaryWaiting", { count: total, waiting })
          : t("summary", { count: total })}
    </span>
  )

  if (layout === "notch") {
    const count = waiting > 0 ? waiting : active
    return (
      <span
        data-testid="island-header"
        data-layout="notch"
        className="grid h-full w-full items-center"
        style={{ gridTemplateColumns: `minmax(0, 1fr) ${notchWidth}px minmax(0, 1fr)` }}
      >
        <span
          data-testid="island-ear-leading"
          className="flex min-w-0 items-center justify-start gap-1.5 pl-3"
        >
          {presentation === "minimal" && count === 0 && !announcing ? null : dot}
          {presentation !== "minimal" && focus ? (
            <span
              data-testid="island-compact-title"
              className="min-w-0 truncate font-medium text-white/90"
            >
              {focus.title}
            </span>
          ) : null}
        </span>
        {/* The camera housing: nothing is ever drawn here. */}
        <span aria-hidden />
        <span
          data-testid="island-ear-trailing"
          className="flex min-w-0 items-center justify-end gap-1.5 pr-3"
        >
          {presentation === "minimal" ? (
            count > 0 ? (
              <span
                data-testid="island-minimal"
                className={cn(
                  "text-[10px] font-semibold tabular-nums",
                  waiting > 0 ? "text-amber-300" : "text-white/70"
                )}
              >
                {count}
              </span>
            ) : null
          ) : focus ? (
            <>
              <span data-testid="island-compact-summary" className="min-w-0 truncate text-white/50">
                {state}
              </span>
              {more}
            </>
          ) : (
            summary
          )}
        </span>
      </span>
    )
  }

  return (
    <span
      data-testid="island-header"
      data-layout="flat"
      className={cn(
        "flex w-full min-w-0 items-center gap-2",
        focus && presentation !== "minimal" ? "justify-start" : "justify-center"
      )}
    >
      {dot}
      {focus && presentation !== "minimal" ? (
        <>
          <span
            data-testid="island-compact-source"
            className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/60"
          >
            {t(`source.${focus.source}`)}
          </span>
          <span
            data-testid="island-compact-title"
            className="min-w-0 shrink truncate font-medium text-white/90"
          >
            {focus.title}
          </span>
          <span
            data-testid="island-compact-summary"
            className="min-w-0 shrink truncate text-white/50"
          >
            {state}
          </span>
          {more ? <span className="ml-auto flex shrink-0">{more}</span> : null}
        </>
      ) : (
        summary
      )}
    </span>
  )
}

export default IslandHeader
