"use client"

/**
 * "From MERC-2" chips on the Squad task board header.
 *
 * The issue run adapter stamps `metadata.issueId` and `metadata.issueIdentifier`
 * on the task it dispatches to a Squad. This reads those stamps off the board's
 * tasks and links back to `/issues` with that issue selected, which is the
 * other half of the issue card's `SquadRunChip`. One chip per distinct issue,
 * nothing at all for a board the team filled on its own.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { CircleDotIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { originIssuesOfTasks } from "@/lib/ai/agent/team/board-model"
import { issueHref } from "@/lib/issues/hrefs"
import { cn } from "@/lib/utils"
import type { AgentTeamTask } from "@/types/agent/agent-team"

export interface OriginIssueChipsProps {
  tasks: readonly AgentTeamTask[]
  className?: string
}

export function OriginIssueChips({ tasks, className }: OriginIssueChipsProps) {
  const t = useTranslations("board.originIssue")
  const origins = originIssuesOfTasks(tasks)
  if (origins.length === 0) return null

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      data-testid="board-origin-issues"
    >
      {origins.map((origin) => {
        const identifier = origin.identifier ?? origin.issueId
        return (
          <Badge
            key={origin.issueId}
            asChild
            variant="outline"
            className="h-5 gap-1 px-1.5 text-[10px] font-normal text-muted-foreground hover:text-foreground"
          >
            <Link
              href={issueHref(origin.issueId)}
              aria-label={t("open", { identifier })}
              title={t("open", { identifier })}
              data-testid={`origin-issue-chip-${origin.issueId}`}
            >
              <CircleDotIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{t("label", { identifier })}</span>
            </Link>
          </Badge>
        )
      })}
    </div>
  )
}
