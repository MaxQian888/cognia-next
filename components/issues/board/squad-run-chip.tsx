"use client"

/**
 * "Squad: name" chip on an issue card whose issue was dispatched to a Squad.
 *
 * `lib/issues/run/agent-team-adapter.ts` records the run, and the console
 * folds the newest one per issue into `squadRuns`. The chip is the way back
 * across: it lands on that Squad's workspace, where the task board carries the
 * matching `OriginIssueChip` pointing here again.
 *
 * It sits inside a draggable, clickable card, so every pointer and key event
 * it handles stops there. Otherwise a click would also select the card and a
 * press of Space on the focused link would start a drag.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { UsersIcon } from "lucide-react"
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react"

import { agentTeamWorkspaceHref } from "@/lib/issues/run/agent-team-adapter"
import type { SquadRunRef } from "@/lib/issues/run/running"
import { cn } from "@/lib/utils"

export interface SquadRunChipProps {
  run: SquadRunRef
  /** The overlay clone is not interactive. */
  inert?: boolean
  className?: string
}

const stop = (event: MouseEvent | PointerEvent | KeyboardEvent) => event.stopPropagation()

export function SquadRunChip({ run, inert, className }: SquadRunChipProps) {
  const t = useTranslations("board.squadRun")
  const name = run.teamName ?? t("unknownSquad")
  const label = t("label", { name })
  const chipClass = cn(
    "inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-control border px-1.5 text-[10px] font-normal text-muted-foreground",
    !inert && "hover:bg-accent hover:text-foreground",
    className
  )

  if (inert) {
    return (
      <span className={chipClass} data-testid={`squad-run-chip-${run.teamId}`}>
        <UsersIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    )
  }

  return (
    <Link
      href={agentTeamWorkspaceHref(run.teamId)}
      aria-label={t("open", { name })}
      title={t("open", { name })}
      data-testid={`squad-run-chip-${run.teamId}`}
      data-run-status={run.status}
      className={chipClass}
      onClick={stop}
      onPointerDown={stop}
      onKeyDown={stop}
    >
      <UsersIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  )
}
