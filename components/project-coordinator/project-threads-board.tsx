"use client"

/**
 * The workspace's project threads, grouped by what they need (ADR-0204): the
 * Overview a person reads after stepping away. Every row is an ordinary
 * conversation — opening it is how you steer it.
 */

import { useState } from "react"
import { useNow, useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronRightIcon, WorkflowIcon } from "lucide-react"
import { ConsoleSection } from "@/components/surface/console-section"
import { Skeleton } from "@/components/ui/skeleton"
import {
  useProjectThreadRows,
  useProjectThreads,
  type ProjectThreadRow as Row,
} from "@/hooks/project-coordinator/use-project-threads"
import { THREAD_BOARD_ORDER, type ThreadBoardState } from "@/lib/project-coordinator/thread-state"
import { ProjectThreadRow } from "./thread-row"
import { ThreadStateBadge } from "./thread-state-badge"

export interface ProjectThreadsBoardProps {
  coordinatorSessionId: string
}

function groupRows(rows: readonly Row[]): Array<[ThreadBoardState, Row[]]> {
  const groups = new Map<ThreadBoardState, Row[]>()
  for (const row of rows) groups.set(row.state, [...(groups.get(row.state) ?? []), row])
  return THREAD_BOARD_ORDER.filter((state) => groups.has(state)).map((state) => [
    state,
    groups.get(state)!,
  ])
}

export function ProjectThreadsBoard({ coordinatorSessionId }: ProjectThreadsBoardProps) {
  const t = useTranslations("projectCoordinator.board")
  const now = useNow({ updateInterval: 60_000 }).getTime()
  const threads = useProjectThreads(coordinatorSessionId)
  const rows = useProjectThreadRows(threads, now)
  const [showResolved, setShowResolved] = useState(false)
  const groups = rows ? groupRows(rows) : undefined
  const open = groups?.filter(([state]) => state !== "resolved") ?? []
  const resolved = groups?.find(([state]) => state === "resolved")?.[1] ?? []

  return (
    <ConsoleSection
      id="project-threads"
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={WorkflowIcon}
      title={t("title")}
      meta={rows ? rows.length - resolved.length : undefined}
      wide
    >
      {groups === undefined ? (
        <div
          role="status"
          aria-busy="true"
          aria-label={t("loading")}
          className="flex flex-col gap-2"
        >
          {[0, 1].map((row) => (
            <Skeleton key={row} className="h-8 w-full" />
          ))}
        </div>
      ) : open.length === 0 && resolved.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="project-threads-empty">
          {t("empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-3" data-testid="project-threads-board">
          {open.map(([state, stateRows]) => (
            <section key={state} aria-label={state} data-testid={`project-threads-group-${state}`}>
              <div className="mb-1 flex items-center gap-2 px-2">
                <ThreadStateBadge state={state} />
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {stateRows.length}
                </span>
              </div>
              <ul className="flex flex-col">
                {stateRows.map((row) => (
                  <li key={row.thread.id}>
                    <ProjectThreadRow row={row} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {resolved.length > 0 ? (
            <section data-testid="project-threads-group-resolved">
              <button
                type="button"
                className="flex items-center gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={showResolved}
                onClick={() => setShowResolved((value) => !value)}
              >
                {showResolved ? (
                  <ChevronDownIcon aria-hidden className="size-3" />
                ) : (
                  <ChevronRightIcon aria-hidden className="size-3" />
                )}
                {t("resolved", { count: resolved.length })}
              </button>
              {showResolved ? (
                <ul className="mt-1 flex flex-col">
                  {resolved.map((row) => (
                    <li key={row.thread.id}>
                      <ProjectThreadRow row={row} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      )}
    </ConsoleSection>
  )
}
