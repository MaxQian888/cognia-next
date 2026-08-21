"use client"

/**
 * The "N selected" band above the list.
 *
 * Placement and shape follow `components/memory/memory-bulk-toolbar.tsx`: it
 * lives INSIDE the centre pane above the rows, gated on a non-empty selection,
 * so it pushes the list rather than floating over the row you are aiming at.
 *
 * Every action reports what it actually did. A mixed selection of local and
 * GitHub rows cannot all be edited, and "12 updated" when four were skipped is
 * a lie the user has no way to catch — `applyIssueBulkAction` counts, and this
 * surfaces the count.
 */

import { TagIcon, TrashIcon, UserIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { countApplicableItems, type IssueBulkAction } from "@/lib/issues/bulk-actions"
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@/types/issues"
import type { IssueProject } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { defaultLabelColor, type LabelRow } from "@/types/labels"
import type { AssigneeOption } from "../assignee-picker"
import { IssuePriorityIcon, IssueStatusIcon } from "../issue-glyphs"

export interface IssueBulkToolbarProps {
  items: readonly UnifiedIssueItem[]
  runningIds: ReadonlySet<string>
  labels: readonly LabelRow[]
  projects: readonly IssueProject[]
  assigneeOptions: readonly AssigneeOption[]
  onAction: (action: IssueBulkAction) => void
  onRequestDelete: () => void
  /** Ticks every row currently on screen; a second call clears. */
  onToggleAll?: () => void
  /** How many rows are on screen, for the select-all label. */
  visibleCount?: number
  onClear: () => void
}

export function IssueBulkToolbar({
  items,
  runningIds,
  labels,
  projects,
  assigneeOptions,
  onAction,
  onRequestDelete,
  onToggleAll,
  visibleCount,
  onClear,
}: IssueBulkToolbarProps) {
  const t = useTranslations("issues")

  if (items.length === 0) return null

  /**
   * How many of the selection an action would touch. Rendered next to each
   * option so a mixed selection says up front that it will only reach some of
   * the rows, instead of reporting it afterwards.
   */
  const applicable = (action: IssueBulkAction) => countApplicableItems(items, action, runningIds)

  const deletable = applicable({ kind: "delete" })

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-primary/5 px-3 py-2"
      data-testid="issue-bulk-toolbar"
      role="toolbar"
      aria-label={t("bulk.label")}
    >
      <span className="text-sm font-medium tabular-nums" data-testid="issue-bulk-count">
        {t("bulk.selected", { count: items.length })}
      </span>

      {/*
        Select-all lives here rather than in a list header: the toolbar is
        already on screen the moment one row is ticked, which is exactly when
        "and the rest" gets reached for.
      */}
      {onToggleAll && visibleCount !== undefined && visibleCount > items.length ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={onToggleAll}
          data-testid="issue-bulk-select-all"
        >
          {t("bulk.selectAll", { count: visibleCount })}
        </Button>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" data-testid="issue-bulk-status">
            {t("detail.status")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {ISSUE_STATUSES.map((status) => {
            const count = applicable({ kind: "status", to: status })
            return (
              <DropdownMenuItem
                key={status}
                disabled={count === 0}
                onSelect={() => onAction({ kind: "status", to: status })}
                data-testid={`issue-bulk-status-${status}`}
              >
                <IssueStatusIcon status={status} />
                <span className="flex-1">{t(`status.${status}`)}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" data-testid="issue-bulk-priority">
            {t("detail.priority")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {ISSUE_PRIORITIES.map((priority) => {
            const count = applicable({ kind: "priority", to: priority })
            return (
              <DropdownMenuItem
                key={priority}
                disabled={count === 0}
                onSelect={() => onAction({ kind: "priority", to: priority })}
                data-testid={`issue-bulk-priority-${priority}`}
              >
                <IssuePriorityIcon priority={priority} />
                <span className="flex-1">{t(`priority.${priority}`)}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" data-testid="issue-bulk-assignee">
            <UserIcon className="size-4" />
            {t("detail.assignee")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuItem
            disabled={applicable({ kind: "assignee", to: null }) === 0}
            onSelect={() => onAction({ kind: "assignee", to: null })}
            data-testid="issue-bulk-assignee-none"
          >
            <span className="italic">{t("actor.unassigned")}</span>
          </DropdownMenuItem>
          {assigneeOptions.map((option) => (
            <DropdownMenuItem
              key={option.key}
              disabled={applicable({ kind: "assignee", to: option.actor }) === 0}
              onSelect={() => onAction({ kind: "assignee", to: option.actor })}
              data-testid={`issue-bulk-assignee-${option.key}`}
            >
              <span className="truncate">{option.actor.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {labels.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" data-testid="issue-bulk-labels">
              <TagIcon className="size-4" />
              {t("detail.labels")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel>{t("bulk.addLabel")}</DropdownMenuLabel>
            {labels.map((label) => (
              <DropdownMenuItem
                key={`add-${label.id}`}
                disabled={applicable({ kind: "addLabel", labelId: label.id }) === 0}
                onSelect={() => onAction({ kind: "addLabel", labelId: label.id })}
                data-testid={`issue-bulk-add-label-${label.id}`}
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: label.color ?? defaultLabelColor(label.name) }}
                />
                <span className="truncate">{label.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("bulk.removeLabel")}</DropdownMenuLabel>
            {labels.map((label) => (
              <DropdownMenuItem
                key={`remove-${label.id}`}
                disabled={applicable({ kind: "removeLabel", labelId: label.id }) === 0}
                onSelect={() => onAction({ kind: "removeLabel", labelId: label.id })}
                data-testid={`issue-bulk-remove-label-${label.id}`}
              >
                <span className="truncate">{label.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {projects.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" data-testid="issue-bulk-project">
              {t("detail.project")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                disabled={applicable({ kind: "project", issueProjectId: project.id }) === 0}
                onSelect={() => onAction({ kind: "project", issueProjectId: project.id })}
                data-testid={`issue-bulk-project-${project.id}`}
              >
                <span aria-hidden>{project.icon ?? "📁"}</span>
                <span className="truncate">{project.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        disabled={deletable === 0}
        onClick={onRequestDelete}
        data-testid="issue-bulk-delete"
      >
        <TrashIcon className="size-4" />
        {t("context.delete")}
      </Button>

      <span className="flex-1" />

      <Button size="sm" variant="ghost" onClick={onClear} data-testid="issue-bulk-clear">
        <XIcon className="size-4" />
        {t("bulk.clear")}
      </Button>
    </div>
  )
}
