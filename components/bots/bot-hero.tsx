"use client"

/**
 * The Bot's masthead: what it is, and the numbers that explain it.
 *
 * The strip is here for the same reason `DeviceHero`'s is: a heading answers
 * "what am I looking at" and never "is anything wrong with it". `buildBotStats`
 * decides which numbers this row can answer at all, so nothing here renders a
 * placeholder for a Bot that has no credentials to bind.
 */

import { useTranslations } from "next-intl"

import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"
import { buildBotStats, type BotConsoleRow } from "@/lib/bot/console/bot-rows"
import type { PluginBotExecutor } from "@/types/plugin/plugin-bot"
import { cn } from "@/lib/utils"

import { BotLifecycleControls } from "./bot-lifecycle-controls"
import { RunBotNowButton } from "./run-bot-now-button"
import { BotExecutorIcon, BotOrphanBadge, BotSourceIcon, BotStatusBadge } from "./bot-visuals"

/**
 * A tinted plate behind the executor icon.
 *
 * The executor is the single most load-bearing fact about a Bot: it decides
 * what a run even is, what it costs and where it shows up. Giving it a colour
 * the eye lands on before reading matches how the rail already orders.
 */
const EXECUTOR_PLATE: Record<PluginBotExecutor, string> = {
  workflow: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  squad: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  "agent-turn": "bg-primary/10 text-primary",
  handler: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
}

export interface BotHeroProps {
  row: BotConsoleRow
  /** Called after the installation is removed, so the console can deselect. */
  onUninstalled?: () => void
}

export function BotHero({ row, onUninstalled }: BotHeroProps) {
  const t = useTranslations("bots")

  // Labels are translated here rather than inside the strip: `StatStrip` is
  // shared with `/devices` and `/workspace`, and calling `t()` in the cell is
  // what bound the original implementation to one namespace.
  const stats: StatStripItem[] = buildBotStats(row).map((stat) => ({
    id: stat.id,
    label: t(`stat.${stat.id}`),
    value: stat.value,
    ...(stat.total !== undefined ? { total: stat.total } : {}),
    tone: stat.tone,
  }))

  return (
    <div className="shrink-0 border-b px-4 py-3.5" data-testid="bot-hero">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            row.executor ? EXECUTOR_PLATE[row.executor] : "bg-muted text-muted-foreground"
          )}
        >
          {row.executor ? (
            <BotExecutorIcon executor={row.executor} className="size-4.5 text-current" />
          ) : (
            <BotSourceIcon source={row.source} className="size-4.5 text-current" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight">
              {row.name}
            </h2>
            {row.orphaned ? <BotOrphanBadge /> : <BotStatusBadge status={row.status} />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <BotSourceIcon source={row.source} className="size-3" />
              {t(`source.${row.source}`)}
            </span>
            {row.executor ? (
              <>
                <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/50" />
                <span>{t(`executor.${row.executor}`)}</span>
              </>
            ) : null}
            <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/50" />
            <span>{t(`scope.${row.scope.kind}`)}</span>
          </div>
          {row.description ? (
            <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{row.description}</p>
          ) : null}
        </div>
      </div>
      {/* One wrapping row rather than two stacked: "run it" and "switch or
          remove it" are the same question's two halves, and two rows spent
          ~40px of masthead on a seam nobody reads. When the write plane
          cannot act, each half still prints its own reason sentence beside
          its control. Above the strip because it acts on the Bot the strip
          describes. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <RunBotNowButton row={row} />
        <BotLifecycleControls row={row} {...(onUninstalled ? { onUninstalled } : {})} />
      </div>
      {stats.length > 0 ? (
        <StatStrip
          stats={stats}
          className="mt-3"
          testId="bot-stat-strip"
          cellTestIdPrefix="bot-stat"
        />
      ) : null}
    </div>
  )
}
