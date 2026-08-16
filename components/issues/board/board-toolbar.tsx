"use client"

/**
 * Filter + Display toolbar for the issue surface.
 *
 * Deliberately two menus, matching the split the conversation sidebar already
 * established (`components/chat/conversation-filter-controls.tsx`): Display
 * changes how rows *look* and how they're grouped; Filter changes which rows
 * exist. Conflating them is how "where did my issue go?" happens.
 *
 * Every facet option is derived from the items actually present
 * (`collectIssueFilterOptions`), so the menu never offers a filter that would
 * return nothing.
 */

import { LayoutGridIcon, ListIcon, ListFilterIcon, SlidersHorizontalIcon } from "lucide-react"
import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  actorKey,
  collectIssueFilterOptions,
  countActiveIssueFilters,
  EMPTY_ISSUE_FILTER,
  ISSUE_GROUP_BY_OPTIONS,
  type IssueBoardFilter,
  type IssueGroupBy,
} from "@/lib/issues/board-model"
import { ISSUE_SORT_MODES, type IssueSortMode, type IssueViewLayout } from "@/lib/issues/views"
import { ISSUE_PRIORITIES } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"

export interface IssueBoardToolbarProps {
  items: readonly UnifiedIssueItem[]
  filter: IssueBoardFilter
  onFilterChange: (filter: IssueBoardFilter) => void
  layout: IssueViewLayout
  onLayoutChange: (layout: IssueViewLayout) => void
  groupBy: IssueGroupBy
  onGroupByChange: (groupBy: IssueGroupBy) => void
  sort: IssueSortMode
  onSortChange: (sort: IssueSortMode) => void
  labelsById?: ReadonlyMap<string, LabelRow>
  projectNamesById?: ReadonlyMap<string, string>
}

/** Toggle a value in a readonly facet array without mutating it. */
function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
}

export function IssueBoardToolbar({
  items,
  filter,
  onFilterChange,
  layout,
  onLayoutChange,
  groupBy,
  onGroupByChange,
  sort,
  onSortChange,
  labelsById,
  projectNamesById,
}: IssueBoardToolbarProps) {
  const t = useTranslations("issues.toolbar")
  const tIssues = useTranslations("issues")

  const options = useMemo(() => collectIssueFilterOptions(items), [items])
  const activeCount = countActiveIssueFilters(filter)

  return (
    <div className="flex items-center gap-2" data-testid="issue-toolbar">
      <Input
        value={filter.query}
        onChange={(event) => onFilterChange({ ...filter, query: event.target.value })}
        placeholder={t("search")}
        aria-label={t("search")}
        className="h-8 w-44"
        data-testid="issue-toolbar-search"
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" data-testid="issue-toolbar-filter">
            <ListFilterIcon className="size-4" />
            {t("filter")}
            {activeCount > 0 ? (
              <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px] tabular-nums">
                {activeCount}
              </Badge>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>{t("facet.priority")}</DropdownMenuLabel>
          {ISSUE_PRIORITIES.map((priority) => (
            <DropdownMenuCheckboxItem
              key={priority}
              checked={filter.priorities.includes(priority)}
              onCheckedChange={() =>
                onFilterChange({ ...filter, priorities: toggle(filter.priorities, priority) })
              }
            >
              {tIssues(`priority.${priority}`)}
            </DropdownMenuCheckboxItem>
          ))}

          {options.labelIds.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("facet.labels")}</DropdownMenuLabel>
              {options.labelIds.map((labelId) => (
                <DropdownMenuCheckboxItem
                  key={labelId}
                  checked={filter.labelIds.includes(labelId)}
                  onCheckedChange={() =>
                    onFilterChange({ ...filter, labelIds: toggle(filter.labelIds, labelId) })
                  }
                >
                  {labelsById?.get(labelId)?.name ?? labelId}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          ) : null}

          {options.assignees.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("facet.assignee")}</DropdownMenuLabel>
              {options.assignees.map(({ key, actor }) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={filter.assignees.includes(key)}
                  onCheckedChange={() =>
                    onFilterChange({ ...filter, assignees: toggle(filter.assignees, key) })
                  }
                >
                  {actor.label ?? tIssues(`actor.${actor.kind}`)}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          ) : null}

          {options.sources.length > 1 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("facet.source")}</DropdownMenuLabel>
              {options.sources.map((source) => (
                <DropdownMenuCheckboxItem
                  key={source}
                  checked={filter.sources.includes(source)}
                  onCheckedChange={() =>
                    onFilterChange({ ...filter, sources: toggle(filter.sources, source) })
                  }
                >
                  {tIssues(`source.${source}`)}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          ) : null}

          {options.issueProjectIds.length > 1 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("facet.project")}</DropdownMenuLabel>
              {options.issueProjectIds.map((id) => (
                <DropdownMenuCheckboxItem
                  key={id}
                  checked={filter.issueProjectIds.includes(id)}
                  onCheckedChange={() =>
                    onFilterChange({
                      ...filter,
                      issueProjectIds: toggle(filter.issueProjectIds, id),
                    })
                  }
                >
                  {projectNamesById?.get(id) ?? id}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          ) : null}

          {activeCount > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => onFilterChange(EMPTY_ISSUE_FILTER)}
                data-testid="issue-toolbar-clear-filters"
              >
                {t("clearFilters")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" data-testid="issue-toolbar-display">
            <SlidersHorizontalIcon className="size-4" />
            {t("display")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>{t("groupBy.label")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={groupBy}
            onValueChange={(value) => onGroupByChange(value as IssueGroupBy)}
          >
            {ISSUE_GROUP_BY_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {t(`groupBy.${option}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("sort.label")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(value) => onSortChange(value as IssueSortMode)}
          >
            {ISSUE_SORT_MODES.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {t(`sort.${option}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <ToggleGroup
        type="single"
        value={layout}
        onValueChange={(value) => value && onLayoutChange(value as IssueViewLayout)}
        variant="outline"
        size="sm"
        aria-label={t("display")}
      >
        <ToggleGroupItem value="board" aria-label={t("board")} data-testid="issue-layout-board">
          <LayoutGridIcon className="size-4" />
        </ToggleGroupItem>
        <ToggleGroupItem value="list" aria-label={t("list")} data-testid="issue-layout-list">
          <ListIcon className="size-4" />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}

/** Re-exported so the console can label a lane without importing board-model. */
export { actorKey }
