"use client"

/**
 * Read-only issue list for the mobile (Capacitor) shell.
 *
 * Deliberately read-mostly, following `components/mobile/agent-teams/team-board-mobile.tsx`:
 * no touch drag, no inline editing. Writing from mobile means registering the
 * tracker's tables as syncable, which is a seven-site fan-out ending in Rust
 * (`src-tauri/src/companion_api/sync_registry.rs`) — a separate piece of work.
 * Until then the phone shows the board's contents and links back to the
 * desktop surface rather than offering controls that would not round-trip.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { LabelChip } from "@/components/labels/label-chip"
import { IssuePriorityIcon, IssueStatusIcon } from "@/components/issues/issue-glyphs"
import { Badge } from "@/components/ui/badge"
import { useClientLiveQuery } from "@/hooks/data"
import { listIssues } from "@/lib/db/issues"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { listLabels } from "@/lib/db/labels"
import { buildIssueGroups } from "@/lib/issues/board-model"
import { toUnifiedIssue } from "@/lib/issues/sources/local-source"
import { useProjectStore } from "@/stores/project/project-store"
import type { IssueStatus } from "@/types/issues"
import type { LabelRow } from "@/types/labels"
import { cn } from "@/lib/utils"

export interface IssuesMobileBodyProps {
  /** Deep-linked issue id from `/issues?id=…`. */
  initialSelectedId?: string
}

export function IssuesMobileBody({ initialSelectedId }: IssuesMobileBodyProps) {
  const t = useTranslations("issues")
  const projectId = useProjectStore((s) => s.activeProjectId)

  const rows = useClientLiveQuery(
    () => (projectId ? listIssues({ projectId }) : Promise.resolve([])),
    [projectId],
    []
  )
  const projects = useClientLiveQuery(
    () => (projectId ? listIssueProjects({ projectId }) : Promise.resolve([])),
    [projectId],
    []
  )
  const labels = useClientLiveQuery(() => listLabels("issue"), [], [] as LabelRow[])

  const labelsById = useMemo(
    () => new Map((labels ?? []).map((label) => [label.id, label])),
    [labels]
  )
  const projectNamesById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects]
  )

  const groups = useMemo(
    () => buildIssueGroups((rows ?? []).map(toUnifiedIssue), "status"),
    [rows]
  )
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="issues-mobile-body">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <h1 className="text-base font-semibold">{t("title")}</h1>
        <Badge variant="secondary" className="font-normal">
          {t("summary", { count: total })}
        </Badge>
      </header>

      {total === 0 ? (
        <p
          className="py-16 text-center text-sm text-muted-foreground"
          data-testid="issues-mobile-empty"
        >
          {t("board.empty")}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.map((group) => (
            <section key={group.key} data-testid={`issues-mobile-group-${group.key}`}>
              <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-4 py-1.5 backdrop-blur">
                <IssueStatusIcon status={group.key as IssueStatus} />
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(`status.${group.key as IssueStatus}`)}
                </h2>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {group.items.length}
                </span>
              </header>
              <ul>
                {group.items.map((item) => (
                  <li
                    key={item.unifiedId}
                    data-testid={`issues-mobile-row-${item.sourceId}`}
                    className={cn(
                      "flex flex-col gap-1.5 border-b px-4 py-3",
                      initialSelectedId === item.sourceId && "bg-accent"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {item.identifier}
                      </span>
                      {item.priority !== "none" ? (
                        <IssuePriorityIcon priority={item.priority} />
                      ) : null}
                      <span className="flex-1" />
                      <span
                        className={cn(
                          "truncate text-[11px] text-muted-foreground",
                          !item.assignee && "italic opacity-70"
                        )}
                      >
                        {item.assignee
                          ? (item.assignee.label ?? t(`actor.${item.assignee.kind}`))
                          : t("actor.unassigned")}
                      </span>
                    </div>
                    <p className="text-sm font-medium leading-snug">{item.title}</p>
                    <div className="flex flex-wrap items-center gap-1">
                      {item.issueProjectId && projectNamesById.get(item.issueProjectId) ? (
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                          {projectNamesById.get(item.issueProjectId)}
                        </Badge>
                      ) : null}
                      {item.labelIds
                        .map((id) => labelsById.get(id))
                        .filter((label): label is LabelRow => Boolean(label))
                        .map((label) => (
                          <LabelChip key={label.id} label={label} className="h-5 text-[10px]" />
                        ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
