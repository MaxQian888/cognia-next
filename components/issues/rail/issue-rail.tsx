"use client"

/**
 * The `/issues` left rail — views, delivery containers, labels.
 *
 * This is what let the header collapse back to one row. Everything here used
 * to be crammed into `FeaturePageHeader`'s single `controls` slot, which
 * renders inside `overflow-x-auto` with the scrollbar hidden — so a narrow
 * window silently scrolled the view tabs and the create button off the right
 * edge with no indication anything was there.
 *
 * Every row is a FILTER, not a destination. Clicking a project narrows the
 * board in place (`filter.issueProjectIds`) rather than navigating to
 * `/projects`; the hover-revealed arrow is the navigation. Mixing the two into
 * one click is how a user loses the board they were reading.
 */

import { ArrowUpRightIcon, SettingsIcon } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { useTranslations } from "next-intl"

import { Progress } from "@/components/ui/progress"
import type { IssueProjectProgress } from "@/lib/issues/project-progress"
import { BUILTIN_ISSUE_VIEWS } from "@/lib/issues/views"
import type { IssueProject } from "@/types/issues"
import { defaultLabelColor, type LabelRow } from "@/types/labels"
import { IssueRailRow } from "./issue-rail-row"
import { IssueRailSection } from "./issue-rail-section"
import { TrackerNav } from "./tracker-nav"

export interface IssueRailProps {
  viewId: string
  /** Per-view tallies, federated rows included. */
  viewCounts: Record<string, number>
  onSelectView: (viewId: string) => void

  projects: readonly IssueProject[]
  projectProgress: ReadonlyMap<string, IssueProjectProgress>
  activeProjectIds: readonly string[]
  onToggleProject: (projectId: string) => void

  labels: readonly LabelRow[]
  /** Per-label tallies across the current view's items. */
  labelCounts: ReadonlyMap<string, number>
  activeLabelIds: readonly string[]
  onToggleLabel: (labelId: string) => void
  onManageLabels?: () => void
}

export function IssueRail({
  viewId,
  viewCounts,
  onSelectView,
  projects,
  projectProgress,
  activeProjectIds,
  onToggleProject,
  labels,
  labelCounts,
  activeLabelIds,
  onToggleLabel,
  onManageLabels,
}: IssueRailProps) {
  const t = useTranslations("issues")
  const [openSections, setOpenSections] = useState({
    views: true,
    projects: true,
    labels: true,
  })

  const setOpen = (key: keyof typeof openSections) => (open: boolean) =>
    setOpenSections((current) => ({ ...current, [key]: open }))

  return (
    <nav
      aria-label={t("rail.label")}
      data-testid="issue-rail"
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pb-2"
    >
      {/* Above the filter sections, because it navigates and they narrow. */}
      <TrackerNav active="issues" />

      <IssueRailSection
        id="views"
        title={t("rail.views")}
        open={openSections.views}
        onOpenChange={setOpen("views")}
      >
        {BUILTIN_ISSUE_VIEWS.map((view) => (
          <IssueRailRow
            key={view.id}
            active={view.id === viewId}
            onSelect={() => onSelectView(view.id)}
            label={t(`views.${view.labelKey}`)}
            count={viewCounts[view.id] ?? 0}
            testId={`issue-rail-view-${view.id}`}
          />
        ))}
      </IssueRailSection>

      <IssueRailSection
        id="projects"
        title={t("rail.projects")}
        open={openSections.projects}
        onOpenChange={setOpen("projects")}
        emptyText={t("rail.noProjects")}
        isEmpty={projects.length === 0}
        action={{
          label: t("rail.manageProjects"),
          icon: <ArrowUpRightIcon className="size-3.5" />,
          href: "/projects",
          testId: "issue-rail-manage-projects",
        }}
      >
        {projects.map((project) => {
          const progress = projectProgress.get(project.id)
          return (
            <IssueRailRow
              key={project.id}
              active={activeProjectIds.includes(project.id)}
              onSelect={() => onToggleProject(project.id)}
              icon={
                <span aria-hidden className="shrink-0 text-sm">
                  {project.icon ?? "📁"}
                </span>
              }
              label={project.name}
              count={progress?.denominator}
              detail={
                progress && progress.denominator > 0 ? (
                  <Progress
                    value={progress.ratio * 100}
                    className="h-1"
                    aria-label={t("projects.progress")}
                  />
                ) : undefined
              }
              trailing={
                <Link
                  href={`/projects?id=${encodeURIComponent(project.id)}`}
                  aria-label={t("rail.openProject", { name: project.name })}
                  title={t("rail.openProject", { name: project.name })}
                  data-testid={`issue-rail-open-project-${project.id}`}
                  className="focus-visible:ring-ring/50 grid size-6 place-items-center rounded-md bg-background/80 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px]"
                >
                  <ArrowUpRightIcon className="size-3.5" />
                </Link>
              }
              testId={`issue-rail-project-${project.id}`}
            />
          )
        })}
      </IssueRailSection>

      <IssueRailSection
        id="labels"
        title={t("rail.labels")}
        open={openSections.labels}
        onOpenChange={setOpen("labels")}
        emptyText={t("rail.noLabels")}
        isEmpty={labels.length === 0}
        action={
          onManageLabels
            ? {
                label: t("rail.manageLabels"),
                icon: <SettingsIcon className="size-3.5" />,
                onSelect: onManageLabels,
                testId: "issue-rail-manage-labels",
              }
            : undefined
        }
      >
        {labels.map((label) => (
          <IssueRailRow
            key={label.id}
            active={activeLabelIds.includes(label.id)}
            onSelect={() => onToggleLabel(label.id)}
            label={label.name}
            icon={
              <span
                aria-hidden
                data-testid={`issue-rail-label-swatch-${label.id}`}
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: label.color ?? defaultLabelColor(label.name) }}
              />
            }
            count={labelCounts.get(label.id) ?? 0}
            testId={`issue-rail-label-${label.id}`}
          />
        ))}
      </IssueRailSection>
    </nav>
  )
}
