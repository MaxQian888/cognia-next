"use client"

/**
 * Issue list for the mobile (Capacitor) shell.
 *
 * Read-mostly, following `components/mobile/agent-teams/team-board-mobile.tsx`:
 * no touch drag, no inline editing on the rows. The tables are
 * companion-synced, so the board has contents to show. The phone's writes are
 * the few that matter away from a desk (spec 2026-09-06 D8): a new issue from
 * the header's plus button, and status, assignee and a comment from the detail
 * sheet. Each is a queued job for the host, never a local write.
 */

import { PlusIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { LabelChip } from "@/components/labels/label-chip"
import { IssuePriorityIcon, IssueStatusIcon } from "@/components/issues/issue-glyphs"
import { Badge } from "@/components/ui/badge"
import { useDexieFirstQuery } from "@/hooks/data/use-dexie-first-query"
import { ListSkeleton } from "@/components/mobile/discover/list-skeleton"
import { listIssues } from "@/lib/db/issues"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { listIssueCycles } from "@/lib/db/issue-cycles"
import { buildPlanningHints } from "@/lib/issues/planning-hints"
import { PlanningBadges } from "@/components/issues/planning/planning-badges"
import { TrackerTabs } from "@/components/issues/tracker-tabs"
import { MobileBackButton } from "@/components/mobile/shell/mobile-back-button"
import { Button } from "@/components/ui/button"
import { listLabels } from "@/lib/db/labels"
import { buildIssueGroups } from "@/lib/issues/board-model"
import { toUnifiedIssue } from "@/lib/issues/sources/local-source"
import { useProjectStore } from "@/stores/project/project-store"
import { IssueCreateSheet } from "./issue-create-sheet"
import { IssueDetailSheet } from "./issue-detail-sheet"
import type { IssueCycle, IssueStatus } from "@/types/issues"
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
  const cycles = useDexieFirstQuery({
    query: () => (projectId ? listIssueCycles({ projectId }) : Promise.resolve([])),
    deps: [projectId],
    initial: [] as IssueCycle[],
    table: "issueCycles",
  }).data

  const labelsById = useMemo(
    () => new Map((labels ?? []).map((label) => [label.id, label])),
    [labels]
  )
  const projectNamesById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects]
  )

  const cycleNamesById = useMemo(
    () => new Map((cycles ?? []).map((cycle) => [cycle.id, cycle.name])),
    [cycles]
  )
  const cyclesById = useMemo(
    () => new Map((cycles ?? []).map((cycle) => [cycle.id, cycle])),
    [cycles]
  )
  const unified = useMemo(() => (rows ?? []).map(toUnifiedIssue), [rows])
  const planningHints = useMemo(
    () => buildPlanningHints(unified, cyclesById),
    [unified, cyclesById]
  )
  const groups = useMemo(() => buildIssueGroups(unified, "status"), [unified])
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)

  /**
   * The deep link used to set a highlight and stop there — `?id=` tinted a row
   * that nothing could open. It now seeds the detail sheet, so a link from a
   * notification actually arrives somewhere.
   */
  const [openId, setOpenId] = useState<string | undefined>(initialSelectedId)
  const [createOpen, setCreateOpen] = useState(false)
  const openItem =
    groups.flatMap((group) => group.items).find((candidate) => candidate.sourceId === openId) ??
    null

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="issues-mobile-body">
      <header className="safe-area-pt flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <MobileBackButton />
          <h1 className="text-base font-semibold">{t("title")}</h1>
          {/* "No issues" beside the empty board said the same thing twice. */}
          {total > 0 ? (
            <Badge variant="secondary" className="font-normal">
              {t("summary", { count: total })}
            </Badge>
          ) : null}
          <span className="flex-1" />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("create.trigger")}
            disabled={!projectId}
            onClick={() => setCreateOpen(true)}
            data-testid="issues-mobile-create-trigger"
          >
            <PlusIcon className="size-4" />
          </Button>
        </div>
        <TrackerTabs active="issues" compact />
      </header>

      {total === 0 && issuesQuery.isSyncing ? (
        // "No issues" and "this phone has not pulled the board yet" are
        // different answers, and until these tables synced the second was
        // always rendered as the first.
        <ListSkeleton rows={3} testId="issues-mobile-skeleton" className="p-4" />
      ) : total === 0 ? (
        <div
          className="flex flex-col items-center gap-3 px-6 py-16 text-center"
          data-testid="issues-mobile-empty"
        >
          <p className="text-sm text-muted-foreground">{t("board.empty")}</p>
          {/* The header's plus is a 32px glyph in a corner; an empty board is
              the moment the reader is looking for the way to start one. */}
          {projectId ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCreateOpen(true)}
              data-testid="issues-mobile-empty-create"
            >
              <PlusIcon className="size-4" aria-hidden />
              {t("create.trigger")}
            </Button>
          ) : null}
        </div>
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
                      <PlanningBadges item={item} hint={planningHints.get(item.unifiedId)} />
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

      <IssueCreateSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        projects={projects ?? []}
      />

      <IssueDetailSheet
        item={openItem}
        onOpenChange={(open) => {
          if (!open) setOpenId(undefined)
        }}
        labelsById={labelsById}
        projectNamesById={projectNamesById}
        cycleNamesById={cycleNamesById}
        items={unified}
        hint={openItem ? planningHints.get(openItem.unifiedId) : undefined}
      />
    </div>
  )
}
