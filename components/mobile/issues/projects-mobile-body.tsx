"use client"

/**
 * Read-only delivery containers for the mobile (Capacitor) shell.
 *
 * `/projects` had no mobile body at all — the route rendered the desktop
 * console unconditionally, so a phone got a seven-column table inside
 * `FeaturePageShellMobile`.
 *
 * Read-only for the same reason as `issues-mobile-body.tsx`: the tracker has
 * no `issue_*` command at all, so a write control here would have nothing to
 * call. The tables themselves are companion-synced now, so the containers
 * have contents to show.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { useDexieFirstQuery } from "@/hooks/data/use-dexie-first-query"
import { ListSkeleton } from "@/components/mobile/discover/list-skeleton"
import { listIssues } from "@/lib/db/issues"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { computeProgressFromIssues } from "@/lib/issues/project-progress"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project/project-store"
import type { IssueProject } from "@/types/issues"

export interface ProjectsMobileBodyProps {
  /** Deep-linked container id from `/projects?id=…`. */
  initialSelectedId?: string
}

export function ProjectsMobileBody({ initialSelectedId }: ProjectsMobileBodyProps) {
  const t = useTranslations("issues")
  const workspaceId = useProjectStore((s) => s.activeProjectId)

  const projectsQuery = useDexieFirstQuery({
    query: () => (workspaceId ? listIssueProjects({ projectId: workspaceId }) : Promise.resolve([])),
    deps: [workspaceId],
    initial: [] as IssueProject[],
    table: "issueProjects",
  })
  const projects = projectsQuery.data
  const issues = useDexieFirstQuery({
    query: () => (workspaceId ? listIssues({ projectId: workspaceId }) : Promise.resolve([])),
    deps: [workspaceId],
    initial: [] as Awaited<ReturnType<typeof listIssues>>,
    table: "issues",
  }).data

  const progressById = useMemo(
    () =>
      computeProgressFromIssues(
        (projects ?? []).map((project) => project.id),
        issues ?? []
      ),
    [projects, issues]
  )

  const rows = projects ?? []

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="projects-mobile-body">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <h1 className="text-base font-semibold">{t("projects.title")}</h1>
        <Badge variant="secondary" className="font-normal">
          {t("projects.summary", { count: rows.length })}
        </Badge>
      </header>

      {rows.length === 0 && projectsQuery.isSyncing ? (
        <ListSkeleton rows={3} testId="projects-mobile-skeleton" className="p-4" />
      ) : rows.length === 0 ? (
        <p
          className="py-16 text-center text-sm text-muted-foreground"
          data-testid="projects-mobile-empty"
        >
          {t("projects.empty")}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((project) => {
            const progress = progressById.get(project.id)
            return (
              <li
                key={project.id}
                data-testid={`projects-mobile-row-${project.id}`}
                className={cn(
                  "flex flex-col gap-2 border-b px-4 py-3",
                  initialSelectedId === project.id && "bg-accent"
                )}
              >
                <div className="flex items-center gap-2">
                  <span aria-hidden className="text-base">
                    {project.icon ?? "📁"}
                  </span>
                  <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{project.name}</h2>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {project.key}
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className="font-normal">
                    {t(`projects.status.${project.status}`)}
                  </Badge>
                  {project.targetDate ? (
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {t("projects.targetDate")}:{" "}
                      {new Date(project.targetDate).toLocaleDateString()}
                    </span>
                  ) : null}
                </div>

                {project.description ? (
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {project.description}
                  </p>
                ) : null}

                <div className="flex items-center gap-2">
                  <Progress
                    value={(progress?.ratio ?? 0) * 100}
                    className="h-1.5 flex-1"
                    aria-label={t("projects.progress")}
                  />
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {t("projects.progressCount", {
                      completed: progress?.completed ?? 0,
                      total: progress?.denominator ?? 0,
                    })}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
