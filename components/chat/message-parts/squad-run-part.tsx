"use client"

/**
 * The conversation's view of a turn handed to a Squad.
 *
 * Deliberately not a transcript of every member. A Squad is an *executor* —
 * the same axis as a model — so its members are implementation detail, folded
 * away by default. Giving each member its own message would flood the
 * conversation and would also collide head-on with the other thing called a
 * team here: a `kind: "team"` room, where several characters genuinely are the
 * conversation. One message with collapsible steps keeps the two readable as
 * different things.
 *
 * Everything below the identity line is live-queried from the execution run,
 * not baked into the message. A Squad run outlives the send that started it,
 * so a message frozen at dispatch time would be wrong within seconds and stay
 * wrong after a reload.
 *
 * Reads the journal directly rather than through the `/agent-runs` detail
 * projection: this is the at-a-glance view and only needs one row per step,
 * and the cockpit's projection is a much larger contract to depend on from a
 * chat message. The full detail is one click away.
 */

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import Link from "next/link"
import { ExternalLinkIcon, UsersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusBadge } from "@/components/status-badge"
import { ToolRowShell, type ToolDotStatus } from "@/components/chat/message-parts/tool-row"
import { getExecutionRun, listVisibleExecutionRunEvents } from "@/lib/db/execution-runs"
import { squadRunSteps, type SquadRunStep } from "@/lib/ai/agent/team/squad-run-steps"
import type { SquadRunPart as SquadRunPartType } from "@/lib/claude/parts-extensions"
import type { ExecutionRunStatus } from "@/types/execution/run"
import { cn } from "@/lib/utils"

interface Props {
  part: SquadRunPartType
}

const STEP_DOT: Record<SquadRunStep["status"], string> = {
  running: "animate-pulse bg-primary",
  completed: "bg-emerald-500",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/40",
}

/** Execution-run status → the shared status-dot colour language. */
const RUN_DOT: Record<ExecutionRunStatus, ToolDotStatus> = {
  queued: "pending",
  running: "running",
  waiting: "warning",
  paused: "warning",
  recovery_required: "warning",
  completed: "complete",
  failed: "error",
  cancelled: "output-denied",
}

export const SquadRunPart = memo(function SquadRunPart({ part }: Props) {
  const t = useTranslations("squadRun")
  const [open, setOpen] = useState(false)

  const view = useLiveQuery(
    async () => {
      const run = await getExecutionRun(part.runId)
      if (!run) return { run: undefined, steps: [] as SquadRunStep[] }
      // `includePrivate` — `resource.changed` is written private because it
      // names workspace paths, and that tier exists to keep paths out of
      // REMOTE projections, not out of the machine that owns the workspace.
      const events = await listVisibleExecutionRunEvents(part.runId, true)
      return { run, steps: squadRunSteps(events) }
    },
    [part.runId],
    undefined
  )

  const runHref = `/agent-runs?run=${encodeURIComponent(part.runId)}`
  const steps = view?.steps ?? []
  const runStatus = view?.run?.status

  return (
    // Same `ToolRowShell` grammar as every other stream row: status dot +
    // squad identity + status badge + "open run" hover action + trailing
    // chevron; the objective + member steps nest under the left rule.
    <ToolRowShell
      className="my-2"
      status={runStatus ? RUN_DOT[runStatus] : "pending"}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      ariaLabel={part.squadName}
      testId="squad-run-part"
      toggleTestId={steps.length > 0 ? "squad-run-activity-toggle" : undefined}
      dataStatus={runStatus}
      lead={
        <span className="min-w-0 max-w-[45%] truncate text-xs font-medium text-foreground/80">
          {part.squadName}
        </span>
      }
      icon={<UsersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      target={
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {steps.length > 0 ? t("memberActivity", { count: steps.length }) : part.objective}
        </span>
      }
      badges={
        view === undefined ? (
          <Skeleton className="h-5 w-16 rounded-full" />
        ) : view.run ? (
          <StatusBadge
            value={view.run.status satisfies ExecutionRunStatus}
            labelNamespace="squadRun.runStatus"
            className="shrink-0 text-[10px]"
            pulse={view.run.status === "running"}
          />
        ) : (
          // The run row is gone (pruned, or this device never had it). Say so
          // rather than showing a status the message cannot know.
          <Badge variant="outline" className="text-[10px]" data-testid="squad-run-unknown">
            {t("runUnavailable")}
          </Badge>
        )
      }
      actions={
        <Link
          href={runHref}
          className="flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          data-testid="squad-run-open"
          onClick={(e) => e.stopPropagation()}
        >
          {t("openRun")}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </Link>
      }
    >
      {/* No steps yet → the objective already sits in the row's target slot,
          so the row degrades to a static line with nothing to expand. */}
      {steps.length > 0 ? (
        <div className="mb-1 space-y-2 border-l pl-3 pt-1">
          <p className="line-clamp-2 text-xs text-muted-foreground">{part.objective}</p>
          <ul className="space-y-1" data-testid="squad-run-activity-list">
            {steps.map((step) => (
              <li
                key={step.id}
                className="flex min-w-0 items-center gap-2 text-xs"
                data-testid="squad-run-activity"
              >
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", STEP_DOT[step.status])}
                />
                <span className="min-w-0 flex-1 truncate">{step.label}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {t(`stepStatus.${step.status}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ToolRowShell>
  )
})

export default SquadRunPart
