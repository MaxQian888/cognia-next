"use client"

/**
 * The conversation's view of a turn handed to a Squad.
 *
 * Deliberately not a transcript of every member. A Squad is an *executor* —
 * the same axis as a model — so its members are implementation detail, folded
 * away by default. Giving each member its own message would flood the
 * conversation and would also collide head-on with the other thing called a
 * team here: a `kind: "team"` room, where several characters genuinely are the
 * conversation. One message with collapsible activity keeps the two readable
 * as different things.
 *
 * Everything below the identity line is live-queried from the execution run,
 * not baked into the message. A Squad run outlives the send that started it,
 * so a message frozen at dispatch time would be wrong within seconds and stay
 * wrong after a reload.
 */

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { ChevronRightIcon, ExternalLinkIcon, UsersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { ExecutionStatusPill } from "@/components/agent-runs/agent-run-status-pill"
import { useExecutionRunDetail } from "@/hooks/agent-runs/use-execution-run-detail"
import type { SquadRunPart as SquadRunPartType } from "@/lib/claude/parts-extensions"
import type { RunActivitySnapshot } from "@/types/execution/run"
import { cn } from "@/lib/utils"

interface Props {
  part: SquadRunPartType
}

export const SquadRunPart = memo(function SquadRunPart({ part }: Props) {
  const t = useTranslations("squadRun")
  const [open, setOpen] = useState(false)
  const { run, detail, journalAvailable, isLoading } = useExecutionRunDetail(part.runId)

  const activities = detail.activities
  const runHref = `/agent-runs?run=${encodeURIComponent(part.runId)}`

  return (
    <Card className="not-prose my-2 space-y-2 p-3" data-testid="squad-run-part">
      <div className="flex min-w-0 items-center gap-2">
        <UsersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">{part.squadName}</span>
        {run ? (
          <ExecutionStatusPill status={run.status} />
        ) : isLoading ? (
          <Skeleton className="h-5 w-16 rounded-full" />
        ) : (
          // The run row is gone (pruned, or this device never had it). Say so
          // rather than showing a status the message cannot know.
          <Badge variant="outline" className="text-[10px]" data-testid="squad-run-unknown">
            {t("runUnavailable")}
          </Badge>
        )}
        <Link
          href={runHref}
          className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          data-testid="squad-run-open"
        >
          {t("openRun")}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </Link>
      </div>

      <p className="line-clamp-2 text-xs text-muted-foreground">{part.objective}</p>

      {!journalAvailable && run ? (
        // Not "no activity" — a different and much better-defined statement
        // than a confident zero on a device the journal never reached.
        <p className="text-xs italic text-muted-foreground" data-testid="squad-run-no-journal">
          {t("journalUnavailable")}
        </p>
      ) : activities.length > 0 ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className="flex w-full items-center gap-1.5 rounded-sm py-1 text-xs text-muted-foreground hover:text-foreground"
            data-testid="squad-run-activity-toggle"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
            />
            {t("memberActivity", { count: activities.length })}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 space-y-1" data-testid="squad-run-activity-list">
              {activities.map((activity) => (
                <ActivityRow key={activity.id} activity={activity} />
              ))}
            </ul>
            {detail.omittedActivityCount > 0 ? (
              // The snapshot keeps a rolling window; saying how many fell out
              // of it is the difference between a summary and a lie.
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("omittedActivity", { count: detail.omittedActivityCount })}
              </p>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </Card>
  )
})

function ActivityRow({ activity }: { activity: RunActivitySnapshot }) {
  const t = useTranslations("squadRun")
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs" data-testid="squad-run-activity">
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          activity.status === "failed" && "bg-destructive",
          activity.status === "completed" && "bg-emerald-500",
          activity.status === "running" && "bg-primary animate-pulse",
          activity.status !== "failed" &&
            activity.status !== "completed" &&
            activity.status !== "running" &&
            "bg-muted-foreground/40"
        )}
      />
      <span className="min-w-0 flex-1 truncate">{activity.label}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {t(`activityStatus.${activity.status}`)}
      </span>
    </li>
  )
}

export default SquadRunPart
