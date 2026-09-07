"use client"

/**
 * One row in the Bots rail.
 *
 * A button rather than a list item with nested controls, so the whole row is
 * the target and the rail stays usable with a keyboard and on touch. Plain
 * flex with `min-w-0` rather than the `Item` primitives, because `ItemTitle`
 * is `w-fit` and a long Bot name then runs out from under the trailing badge
 * instead of truncating.
 *
 * The second line answers the question the list exists for: what runs this,
 * and how many of its triggers are actually armed. A Bot with zero armed
 * triggers is installed and inert, which looks identical to a healthy one
 * unless the row says so.
 */

import { useTranslations } from "next-intl"

import { botRowNeedsAttention, type BotConsoleRow } from "@/lib/bot/console/bot-rows"
import { cn } from "@/lib/utils"

import { BotExecutorIcon, BotOrphanBadge, BotStatusDot } from "./bot-visuals"

export interface BotRowButtonProps {
  row: BotConsoleRow
  selected: boolean
  onSelect: (installationId: string) => void
}

export function BotRowButton({ row, selected, onSelect }: BotRowButtonProps) {
  const t = useTranslations("bots")
  const needsAttention = botRowNeedsAttention(row)

  return (
    <button
      type="button"
      onClick={() => onSelect(row.id)}
      aria-current={selected ? "true" : undefined}
      data-testid={`bot-row-${row.id}`}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
        "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-muted"
      )}
    >
      {row.executor ? (
        <BotExecutorIcon executor={row.executor} className="mt-0.5" />
      ) : (
        <span aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <BotStatusDot status={row.status} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
          {needsAttention ? (
            <span
              aria-label={t("row.needsAttention")}
              className="size-1.5 shrink-0 rounded-full bg-amber-500"
            />
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {row.executor ? t(`executor.${row.executor}`) : row.definitionId}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground/80 tabular-nums">
            {t("row.armedOfTotal", {
              armed: row.armedTriggers,
              total: row.triggers.length,
            })}
          </span>
        </span>
        {row.orphaned ? (
          <span className="mt-1 flex">
            <BotOrphanBadge />
          </span>
        ) : null}
        {row.deadLetters > 0 ? (
          <span className="mt-1 flex text-[11px] text-amber-600 dark:text-amber-400">
            {t("row.deadLetters", { count: row.deadLetters })}
          </span>
        ) : null}
      </span>
    </button>
  )
}
