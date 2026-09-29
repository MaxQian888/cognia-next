"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { GitBranchIcon } from "lucide-react"
import { SessionRunIndicator } from "@/components/chat/session-run-indicator"
import { sessionHref } from "@/lib/issues/run/agent-task-adapter"
import type { ProjectThreadRow as Row } from "@/hooks/project-coordinator/use-project-threads"
import { ThreadActions } from "./thread-actions"
import { ThreadPrActions } from "./thread-pr-actions"
import { ThreadStateBadge } from "./thread-state-badge"

/** One thread: open it, see its state and branch, act on it. */
export function ProjectThreadRow({ row }: { row: Row }) {
  const t = useTranslations("projectCoordinator.row")
  const { thread, state, status } = row
  const title = thread.title?.trim() || t("untitled")
  const branch = thread.executionContext?.branch
  return (
    <div
      className="flex items-center gap-2 rounded-control px-2 py-1.5 text-sm hover:bg-accent/40"
      data-testid={`project-thread-${thread.id}`}
    >
      <SessionRunIndicator status={status} testIdPrefix={`project-thread-run-${thread.id}`} />
      <Link href={sessionHref(thread.id)} className="min-w-0 flex-1 truncate hover:underline">
        {title}
      </Link>
      {branch ? (
        <span className="hidden min-w-0 max-w-40 items-center gap-1 truncate font-mono text-[11px] text-muted-foreground @md/workspace-card:inline-flex">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      ) : null}
      <ThreadStateBadge state={state} />
      <ThreadPrActions thread={thread} pr={row.pr} />
      <ThreadActions threadId={thread.id} title={title} state={state} />
    </div>
  )
}
