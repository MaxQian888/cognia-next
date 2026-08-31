"use client"

/**
 * "This conversation has work running in the background" chip.
 *
 * A conversation in `delegate` hands its turn to a team or workflow, and the
 * run detaches: it reports milestones back into the thread and settles on its
 * own. The thread shows those milestones, but nothing said how many runs are
 * in flight or gave a way to reach the cockpit that can steer or stop them.
 * `executionRunBindings` is indexed by `conversationKey` and has held the
 * answer since ADR-0089.
 *
 * Renders nothing when the conversation has no live run, which is the common
 * case. It lives in the header's overflow popover rather than the strip: the
 * strip is at its control budget (`lib/ui/chrome-budget.ts`), and this is
 * status, not a control the operator needs before every message.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { PlayCircleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getDb } from "@/lib/db/schema"

/**
 * Binding statuses that mean a run is still going.
 *
 * `degraded` counts: the run is live, only its card is failing to update, and
 * hiding it would take away the one route to the cockpit at exactly the moment
 * the thread has stopped reporting.
 */
const LIVE_STATUSES = new Set(["active", "degraded"])

export interface ActiveDelegationsChipProps {
  conversationKey: string
}

export function ActiveDelegationsChip({ conversationKey }: ActiveDelegationsChipProps) {
  const t = useTranslations("inbox.activeDelegations")
  const count =
    useLiveQuery(async () => {
      if (typeof window === "undefined") return 0
      const rows = await getDb()
        .executionRunBindings.where("conversationKey")
        .equals(conversationKey)
        .toArray()
      return rows.filter((row) => LIVE_STATUSES.has(row.status)).length
    }, [conversationKey]) ?? 0

  if (count === 0) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="items-center gap-1 text-xs"
          data-testid="active-delegations-chip"
          data-count={count}
          asChild
        >
          <Link href="/agent-runs">
            <PlayCircleIcon className="size-3" aria-hidden />
            {t("count", { count })}
          </Link>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{t("tooltip", { count })}</TooltipContent>
    </Tooltip>
  )
}
