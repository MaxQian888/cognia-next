"use client"

/**
 * The delivery containers, as rows.
 *
 * Replaces a card grid that could only fit a name, a key, a status pill and a
 * progress bar — so the lead, the target date and the issue count, all of
 * which the container carries, were simply invisible. A table shows them at a
 * glance and compares across containers, which is the whole reason to look at
 * this page.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import type { IssueProjectProgress } from "@/lib/issues/project-progress"
import { cn } from "@/lib/utils"
import type { IssueProject } from "@/types/issues"

export interface ProjectTableProps {
  projects: readonly IssueProject[]
  progressById: ReadonlyMap<string, IssueProjectProgress>
  selectedId?: string
  onSelect: (projectId: string) => void
}

export function ProjectTable({ projects, progressById, selectedId, onSelect }: ProjectTableProps) {
  const t = useTranslations("issues")

  return (
    <div className="min-w-0 flex-1 overflow-auto" data-testid="project-table">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
          <tr className="border-b text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="px-4 py-2 font-semibold">
              {t("projects.nameLabel")}
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              {t("projects.keyLabel")}
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              {t("detail.status")}
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              {t("projects.lead")}
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              {t("projects.targetDate")}
            </th>
            <th scope="col" className="w-48 px-3 py-2 font-semibold">
              {t("projects.progress")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              {t("projects.issueCount")}
            </th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => {
            const progress = progressById.get(project.id)
            const selected = selectedId === project.id
            return (
              <tr
                key={project.id}
                data-testid={`project-row-${project.id}`}
                data-selected={selected || undefined}
                className={cn(
                  "border-b motion-safe:transition-colors motion-safe:duration-150",
                  "hover:bg-accent/40",
                  selected && "bg-accent"
                )}
              >
                <td className="max-w-0 px-4 py-2">
                  {/*
                    The name cell is the row's button. Making the <tr> clickable
                    would leave keyboard users with no way in, and wrapping a row
                    in a <button> is invalid inside a table.
                  */}
                  <button
                    type="button"
                    onClick={() => onSelect(project.id)}
                    aria-pressed={selected}
                    data-testid={`project-open-${project.id}`}
                    className="focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-[3px]"
                  >
                    <span aria-hidden className="shrink-0">
                      {project.icon ?? "📁"}
                    </span>
                    <span className="min-w-0 truncate font-medium">{project.name}</span>
                  </button>
                </td>
                <td className="px-3 py-2">
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {project.key}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <Badge variant="secondary" className="font-normal">
                    {t(`projects.status.${project.status}`)}
                  </Badge>
                </td>
                <td className="max-w-32 truncate px-3 py-2 text-muted-foreground">
                  {project.lead
                    ? (project.lead.label ?? t(`actor.${project.lead.kind}`))
                    : t("actor.noLead")}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                  {project.targetDate ? new Date(project.targetDate).toLocaleDateString() : "—"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Progress
                      value={(progress?.ratio ?? 0) * 100}
                      className="h-1.5 flex-1"
                      aria-label={t("projects.progress")}
                    />
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {t("projects.progressCount", {
                        completed: progress?.completed ?? 0,
                        // The denominator excludes cancelled work: a cancelled
                        // item is not outstanding, and counting it would make
                        // dropping scope look like losing ground.
                        total: progress?.denominator ?? 0,
                      })}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {progress?.total ?? 0}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
