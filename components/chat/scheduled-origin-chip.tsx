"use client"

/**
 * "Scheduled · <task>" chip for a conversation a scheduled run opened.
 *
 * A chat, agent, skill or goal task creates a new conversation every time it
 * fires. Those conversations used to appear in the list with a "(scheduled)"
 * title suffix and nothing else: no way to see which task opened it, whether
 * that task is still on the schedule, or to go and change it. The executor now
 * stamps `session.origin` (`lib/scheduler/executors/session-attribution.ts`);
 * this chip reads it and opens that task, and that run, on the scheduler page.
 *
 * Renders nothing for any other session. Sibling of {@link ImportedOriginChip}
 * in the header's provenance row.
 */

import { useTranslations } from "next-intl"
import { CalendarClockIcon } from "lucide-react"
import { useRouter } from "next/navigation"

import type { ChatSession } from "@cognia/agent-config-types"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLiveScheduledTask } from "@/hooks/scheduler/use-live-scheduled-task"
import { isCompanionShell } from "@/lib/chat/room/shell"
import { schedulerItemHref } from "@/lib/scheduler/page-query"
import { cn } from "@/lib/utils"
import { unifiedKindForTaskType } from "@/types/scheduler/unified"

export function ScheduledOriginChip({
  session,
  className,
}: {
  session: ChatSession
  className?: string
}) {
  const t = useTranslations("chat.scheduledOrigin")
  const router = useRouter()
  const origin = session.origin?.kind === "scheduled-task" ? session.origin : null
  const live = useLiveScheduledTask(origin?.taskId)
  if (!origin) return null

  // The live name wins (the task may have been renamed since); the stamped one
  // keeps the chip meaningful after the task is deleted.
  const name = live?.name ?? origin.taskName
  // The lookup reads THIS device's schedule. A companion shell's conversations
  // were opened by the host's scheduler, so finding nothing locally says
  // nothing about the task; only the host could, and its scheduler page does.
  const gone = live === null && !isCompanionShell()
  const href = schedulerItemHref(
    { kind: unifiedKindForTaskType(live?.type ?? ""), sourceId: origin.taskId },
    origin.runId
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => router.push(href)}
          disabled={gone}
          aria-label={gone ? t("goneHint", { name }) : t("hint", { name })}
          data-testid="scheduled-origin-chip"
          data-gone={gone || undefined}
        >
          <Badge
            variant="secondary"
            className={cn(
              "h-5 max-w-56 shrink-0 gap-1 px-1.5 text-[10px] font-normal transition-colors",
              gone ? "opacity-60" : "hover:bg-secondary/70",
              className
            )}
          >
            <CalendarClockIcon className="size-3" aria-hidden="true" />
            <span className="truncate">{t("label", { name })}</span>
          </Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {gone ? t("goneHint", { name }) : t("hint", { name })}
      </TooltipContent>
    </Tooltip>
  )
}
