"use client"

/**
 * Read-only issue list for the mobile (Capacitor) shell.
 *
 * Deliberately read-mostly, following `components/mobile/agent-teams/team-board-mobile.tsx`:
 * no touch drag, no inline editing. The tables are companion-synced now, so
 * the board actually has contents to show. Writes stay off: there is no
 * `issue_*` command at all, so a control here would have nothing to call.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { LabelChip } from "@/components/labels/label-chip"
import { IssuePriorityIcon, IssueStatusIcon } from "@/components/issues/issue-glyphs"
import { Badge } from "@/components/ui/badge"
import { useDexieFirstQuery } from "@/hooks/data/use-dexie-first-query"
import { ListSkeleton } from "@/components/mobile/discover/list-skeleton"
import { listIssues } from "@/lib/db/issues"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { listLabels } from "@/lib/db/labels"
import { buildIssueGroups } from "@/lib/issues/board-model"
import { toUnifiedIssue } from "@/lib/issues/sources/local-source"
import { useProjectStore } from "@/stores/project/project-store"
import { IssueDetailSheet } from "./issue-detail-sheet"
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

  // Dexie-first: each read kicks a targeted pull for its own table, so a phone
  // that has never synced the tracker fills in rather than rendering an empty
  // board it has no way to correct.
  const issuesQuery = useDexieFirstQuery({
    query: () => (projectId ? listIssues({ projectId }) : Promise.resolve([])),
    deps: [projectId],
    initial: [] as Awaited<ReturnType<typeof listIssues>>,
    table: "issues",
  })
  const rows = issuesQuery.data
  const projects = useDexieFirstQuery({
    query: () => (projectId ? listIssueProjects({ projectId }) : Promise.resolve([])),
    deps: [projectId],
    initial: [] as Awaited<ReturnType<typeof listIssueProjects>>,
    table: "issueProjects",
  }).data
  const labels = useDexieFirstQuery({
    query: () => listLabels("issue"),
    deps: [],
    initial: [] as LabelRow[],
    table: "labels",
  }).data

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

  /**
   * The deep link used to set a highlight and stop there — `?id=` tinted a row
   * that nothing could open. It now seeds the detail sheet, so a link from a
   * notification actually arrives somewhere.
   */
  const [openId, setOpenId] = useState<string | undefined>(initialSelectedId)
  const openItem =
    groups.flatMap((group) => group.items).find((candidate) => candidate.sourceId === openId) ??
    null

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="issues-mobile-body">
      <header className="safe-area-pt flex items-center gap-2 border-b px-4 py-3">
        <h1 className="text-base font-semibold">{t("title")}</h1>
        <Badge variant="secondary" className="font-normal">
          {t("summary", { count: total })}
        </Badge>
      </header>

      {total === 0 && issuesQuery.isSyncing ? (
        // "No issues" and "this phone has not pulled the board yet" are
        // different answers, and until these tables synced the second was
        // always rendered as the first.
        <ListSkeleton rows={3} testId="issues-mobile-skeleton" className="p-4" />
      ) : total === 0 ? (
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
                  <li key={item.unifiedId}>
                    <button
                      type="button"
                      onClick={() => setOpenId(item.sourceId)}
                      data-testid={`issues-mobile-row-${item.sourceId}`}
                      className={cn(
                        "flex w-full flex-col gap-1.5 border-b px-4 py-3 text-left",
                        "focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]",
                        openId === item.sourceId && "bg-accent"
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
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <IssueDetailSheet
        item={openItem}
        onOpenChange={(open) => {
          if (!open) setOpenId(undefined)
        }}
        labelsById={labelsById}
        projectNamesById={projectNamesById}
      />
    </div>
  )
}
