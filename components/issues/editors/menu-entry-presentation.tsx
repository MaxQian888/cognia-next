"use client"

/**
 * How one `IssueMenuEntry` reads and looks.
 *
 * The entries carry raw ids — a status, a priority, an `actorKey`, a label id,
 * a container id — because `lib/issues/menu-model.ts` must stay free of i18n
 * to remain unit-testable. Turning those into text and swatches is this
 * module's whole job, and it is shared so the right-click menu and the
 * inspector's property menus cannot drift into two different renderings of the
 * same entry.
 */

import { useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import type { IssueMenuEntry, IssueMenuSectionId } from "@/lib/issues/menu-model"
import type { IssuePriority, IssueProject, IssueStatus } from "@/types/issues"
import { defaultLabelColor, type LabelRow } from "@/types/labels"
import type { AssigneeOption } from "../assignee-picker"
import { IssuePriorityIcon, IssueStatusIcon } from "../issue-glyphs"

/** Section id → its `issues.detail.*` heading key. */
const ISSUE_MENU_SECTION_LABEL_KEY: Record<IssueMenuSectionId, string> = {
  status: "detail.status",
  priority: "detail.priority",
  assignee: "detail.assignee",
  labels: "detail.labels",
  project: "detail.project",
}

export interface MenuEntryPresentationInput {
  labels: readonly LabelRow[]
  projects: readonly IssueProject[]
  assigneeOptions: readonly AssigneeOption[]
}

export interface MenuEntryPresentation {
  sectionLabel: (section: IssueMenuSectionId) => string
  entryLabel: (section: IssueMenuSectionId, entry: IssueMenuEntry) => string
  entryIcon: (section: IssueMenuSectionId, entry: IssueMenuEntry) => ReactNode
}

export function useMenuEntryPresentation({
  labels,
  projects,
  assigneeOptions,
}: MenuEntryPresentationInput): MenuEntryPresentation {
  const t = useTranslations("issues")

  const labelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels])
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects]
  )
  const assigneesByKey = useMemo(
    () => new Map(assigneeOptions.map((option) => [option.key, option])),
    [assigneeOptions]
  )

  return {
    sectionLabel: (section) => t(ISSUE_MENU_SECTION_LABEL_KEY[section]),

    entryLabel: (section, entry) => {
      switch (section) {
        case "status":
          return t(`status.${entry.id as IssueStatus}`)
        case "priority":
          return t(`priority.${entry.id as IssuePriority}`)
        case "assignee":
          return entry.id === "none"
            ? t("actor.unassigned")
            : // A Character deleted since the issue was assigned leaves a key
              // with no option; showing the key beats showing nothing.
              (assigneesByKey.get(entry.id)?.actor.label ?? entry.id)
        case "labels":
          return labelsById.get(entry.id)?.name ?? entry.id
        case "project":
          return projectsById.get(entry.id)?.name ?? entry.id
      }
    },

    entryIcon: (section, entry) => {
      switch (section) {
        case "status":
          return <IssueStatusIcon status={entry.id as IssueStatus} />
        case "priority":
          return <IssuePriorityIcon priority={entry.id as IssuePriority} />
        case "labels": {
          const label = labelsById.get(entry.id)
          return label ? (
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: label.color ?? defaultLabelColor(label.name) }}
            />
          ) : null
        }
        case "project": {
          const project = projectsById.get(entry.id)
          return project ? <span aria-hidden>{project.icon ?? "📁"}</span> : null
        }
        case "assignee":
          return null
      }
    },
  }
}
