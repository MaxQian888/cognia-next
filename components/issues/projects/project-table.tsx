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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
    /*
      A container query, not a viewport one: this table sits in the centre pane
      and its width depends on whether the inspector is open, which no `md:` or
      `lg:` can see. The old floor was `min-w-[52rem]`, wider than the centre
      pane ever gets below about 1200px, so the issue count sat permanently off
      the right edge behind a horizontal scrollbar nobody looks for.

      Columns drop in reverse order of how often they are read. Name, key,
      status and the issue count always survive, because those are what the
      page is for.
    */
    <div
      className="@container/project-table min-w-0 flex-1 overflow-auto"
      data-testid="project-table"
    >
      {/*
        This div is the scrollport the sticky header resolves against, so the
        shared Table's own horizontal scroller is turned off.
      */}
      <Table containerClassName="overflow-x-visible" className="min-w-[22rem] border-collapse">
        <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur">
          <TableRow className="text-left text-xs font-semibold tracking-wide whitespace-nowrap uppercase hover:bg-transparent">
            {/*
              `w-full` on ONE column is the table idiom for "absorb the slack";
              without it the name gets a content-based width and `max-w-0` on
              the cell collapses it to a few characters — which is the wrong
              column to squeeze.
            */}
            <TableHead scope="col" className="w-full px-4 font-semibold text-muted-foreground">
              {t("projects.nameLabel")}
            </TableHead>
            <TableHead scope="col" className="px-3 font-semibold text-muted-foreground">
              {t("projects.keyLabel")}
            </TableHead>
            <TableHead scope="col" className="px-3 font-semibold text-muted-foreground">
              {t("detail.status")}
            </TableHead>
            <TableHead
              scope="col"
              className="hidden px-3 font-semibold @3xl/project-table:table-cell text-muted-foreground"
            >
              {t("projects.lead")}
            </TableHead>
            <TableHead
              scope="col"
              className="hidden px-3 font-semibold @4xl/project-table:table-cell text-muted-foreground"
            >
              {t("projects.targetDate")}
            </TableHead>
            {/*
              A minimum rather than a width: `w-full` on the name column wins
              the slack, and without a floor the progress bar shrinks to a stub
              that reads as broken rather than as "barely started".
            */}
            <TableHead
              scope="col"
              className="hidden min-w-40 px-3 font-semibold @xl/project-table:table-cell text-muted-foreground"
            >
              {t("projects.progress")}
            </TableHead>
            <TableHead scope="col" className="px-3 text-right font-semibold text-muted-foreground">
              {t("projects.issueCount")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project) => {
            const progress = progressById.get(project.id)
            const selected = selectedId === project.id
            return (
              <TableRow
                key={project.id}
                data-testid={`project-row-${project.id}`}
                data-selected={selected || undefined}
                className={cn(
                  "transition-none motion-safe:transition-colors motion-safe:duration-150",
                  "hover:bg-accent/40",
                  selected && "bg-accent"
                )}
              >
                <TableCell className="w-full max-w-0 px-4">
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
                </TableCell>
                <TableCell className="px-3">
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {project.key}
                  </Badge>
                </TableCell>
                <TableCell className="px-3">
                  <Badge variant="secondary" className="font-normal">
                    {t(`projects.status.${project.status}`)}
                  </Badge>
                </TableCell>
                <TableCell className="hidden max-w-32 truncate px-3 text-muted-foreground @3xl/project-table:table-cell">
                  {project.lead
                    ? (project.lead.label ?? t(`actor.${project.lead.kind}`))
                    : t("actor.noLead")}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap px-3 tabular-nums text-muted-foreground @4xl/project-table:table-cell">
                  {project.targetDate ? new Date(project.targetDate).toLocaleDateString() : "—"}
                </TableCell>
                <TableCell className="hidden min-w-40 px-3 @xl/project-table:table-cell">
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
                </TableCell>
                <TableCell className="px-3 text-right tabular-nums text-muted-foreground">
                  {progress?.total ?? 0}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
