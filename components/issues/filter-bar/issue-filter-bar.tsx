"use client"

/**
 * Search + Filter + Display, and the chips that say what is engaged.
 *
 * Replaces `board/board-toolbar.tsx`, which lived inside
 * `FeaturePageHeader`'s `controls` slot alongside the view tabs, the create
 * button and two badges. That slot renders in `overflow-x-auto` with the
 * scrollbar hidden, so `flex-wrap` never wrapped and the right-hand controls
 * silently scrolled off the edge. The bar now owns a strip of its own above
 * the board, and the views moved to the rail.
 *
 * The two-menu split is unchanged and deliberate, and matches
 * `components/memory/memory-toolbar.tsx`: Display changes how rows LOOK and
 * how they group; Filter changes which rows EXIST. Conflating them is how
 * "where did my issue go?" happens.
 *
 * Every facet option is derived from the items actually present
 * (`collectIssueFilterOptions`), so the menu never offers a filter that would
 * return nothing.
 */

import { LayoutGridIcon, ListFilterIcon, ListIcon, SlidersHorizontalIcon } from "lucide-react"
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
  collectIssueFilterOptions,
  countActiveIssueFilters,
  ISSUE_GROUP_BY_OPTIONS,
  type IssueBoardFilter,
  type IssueGroupBy,
} from "@/lib/issues/board-model"
import {
  collectActiveFilterChips,
  removeFilterChip,
  toggleFilterValue,
  CLEARED_ISSUE_FILTER,
} from "@/lib/issues/filter-chips"
import {
  ISSUE_LIST_DENSITIES,
  ISSUE_SORT_MODES,
  type IssueListDensity,
  type IssueSortMode,
  type IssueViewLayout,
} from "@/lib/issues/views"
import { ISSUE_PRIORITIES } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { ActiveFilterChips } from "./active-filter-chips"

export interface IssueFilterBarProps {
  /** Scoped-but-unfiltered items — facet options must not shrink as you filter. */
  items: readonly UnifiedIssueItem[]
  filter: IssueBoardFilter
  onFilterChange: (filter: IssueBoardFilter) => void
  layout: IssueViewLayout
  onLayoutChange: (layout: IssueViewLayout) => void
  groupBy: IssueGroupBy
  onGroupByChange: (groupBy: IssueGroupBy) => void
  sort: IssueSortMode
  onSortChange: (sort: IssueSortMode) => void
  density: IssueListDensity
  onDensityChange: (density: IssueListDensity) => void
  labelsById?: ReadonlyMap<string, LabelRow>
  projectNamesById?: ReadonlyMap<string, string>
  /** Focus target for the `/` shortcut. */
  searchRef?: React.Ref<HTMLInputElement>
}

export function IssueFilterBar({
  items,
  filter,
  onFilterChange,
  layout,
  onLayoutChange,
  groupBy,
  onGroupByChange,
  sort,
  onSortChange,
  density,
  onDensityChange,
  labelsById,
  projectNamesById,
  searchRef,
}: IssueFilterBarProps) {
  const t = useTranslations("issues.toolbar")
  const tIssues = useTranslations("issues")

  const options = useMemo(() => collectIssueFilterOptions(items), [items])
  const activeCount = countActiveIssueFilters(filter)
  const chips = useMemo(() => collectActiveFilterChips(filter), [filter])
  const assigneeLabels = useMemo(
    () =>
      new Map(
        options.assignees.map(({ key, actor }) => [
          key,
          actor.label ?? tIssues(`actor.${actor.kind}`),
        ])
      ),
    [options.assignees, tIssues]
  )

  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-b bg-background/60 px-3 py-2"
      data-testid="issue-filter-bar"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Input
          ref={searchRef}
          value={filter.query}
          onChange={(event) => onFilterChange({ ...filter, query: event.target.value })}
          placeholder={t("search")}
          aria-label={t("search")}
          className="h-8 min-w-0 max-w-64 flex-1"
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
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>{t("facet.priority")}</DropdownMenuLabel>
            {ISSUE_PRIORITIES.map((priority) => (
              <DropdownMenuCheckboxItem
                key={priority}
                checked={filter.priorities.includes(priority)}
                onCheckedChange={() =>
                  onFilterChange(toggleFilterValue(filter, "priorities", priority))
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
                      onFilterChange(toggleFilterValue(filter, "labelIds", labelId))
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
                {options.assignees.map(({ key }) => (
                  <DropdownMenuCheckboxItem
                    key={key}
                    checked={filter.assignees.includes(key)}
                    onCheckedChange={() =>
                      onFilterChange(toggleFilterValue(filter, "assignees", key))
                    }
                  >
                    {assigneeLabels.get(key) ?? key}
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
                      onFilterChange(toggleFilterValue(filter, "sources", source))
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
                      onFilterChange(toggleFilterValue(filter, "issueProjectIds", id))
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
                  onSelect={() => onFilterChange(CLEARED_ISSUE_FILTER)}
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
          <DropdownMenuContent align="start" className="w-48">
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

            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("density.label")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={density}
              onValueChange={(value) => onDensityChange(value as IssueListDensity)}
            >
              {ISSUE_LIST_DENSITIES.map((option) => (
                <DropdownMenuRadioItem
                  key={option}
                  value={option}
                  data-testid={`issue-density-${option}`}
                >
                  {t(`density.${option}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="flex-1" />

        <ToggleGroup
          type="single"
          value={layout}
          onValueChange={(value) => value && onLayoutChange(value as IssueViewLayout)}
          variant="outline"
          size="sm"
          aria-label={t("display")}
          className="shrink-0"
        >
          <ToggleGroupItem value="board" aria-label={t("board")} data-testid="issue-layout-board">
            <LayoutGridIcon className="size-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label={t("list")} data-testid="issue-layout-list">
            <ListIcon className="size-4" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <ActiveFilterChips
        chips={chips}
        labelsById={labelsById}
        projectNamesById={projectNamesById}
        assigneeLabels={assigneeLabels}
        onRemove={(chip) => onFilterChange(removeFilterChip(filter, chip))}
        onClearAll={() => onFilterChange(CLEARED_ISSUE_FILTER)}
      />
    </div>
  )
}
